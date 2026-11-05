/** Lazy companion retaining the executing device for tool-action audit rows. */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

type ToolActionDeviceBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "tool_action_device_bindings"
>;

export const TOOL_ACTION_DEVICE_REF_MAX_LENGTH = 64;
const TOOL_ACTION_DEVICE_BINDING_MAX_ROWS = 100_000;
const TOOL_ACTION_DEVICE_BINDING_PRUNE_BATCH_ROWS = 1_024;
const DEFAULT_BINDING_LIMITS = {
  maxRows: TOOL_ACTION_DEVICE_BINDING_MAX_ROWS,
  pruneBatchRows: TOOL_ACTION_DEVICE_BINDING_PRUNE_BATCH_ROWS,
} as const;
export type ToolActionDeviceBindingLimits = {
  maxRows: number;
  pruneBatchRows: number;
};
const ensuredBindingDatabases = new WeakSet<DatabaseSync>();
/** Cached row count keeps the cap check off every device-scoped write. */
const bindingRowCounts = new WeakMap<DatabaseSync, number>();

function toolActionDeviceBindingSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS tool_action_device_bindings (",
  );
  const indexStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE INDEX IF NOT EXISTS tool_action_device_bindings_occurred_idx",
    start,
  );
  const end = indexStart >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(";", indexStart) : -1;
  if (start < 0 || end < 0) {
    throw new Error("canonical tool action device binding schema is missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 1);
}

/** Install the additive companion only when a device-scoped tool event is first retained. */
export function ensureToolActionDeviceBindingSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (
    ensuredBindingDatabases.has(database.db) ||
    tableExists(database.db, "tool_action_device_bindings")
  ) {
    ensuredBindingDatabases.add(database.db);
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; bindings use Kysely.
      db.exec(toolActionDeviceBindingSchemaSql());
    },
    { ...options, database },
    { operationLabel: "audit.tool-action-device-binding.schema.ensure" },
  );
  ensuredBindingDatabases.add(database.db);
}

/**
 * Retain one hashed device ref beside its tool-action row. The ref is already
 * projected by the audit boundary; raw device ids never reach this store.
 */
export function recordToolActionDeviceBindingInDatabase(
  db: DatabaseSync,
  params: { eventId: string; deviceRef: string; occurredAt: number },
): boolean {
  const deviceRef = params.deviceRef.trim();
  if (!params.eventId || !deviceRef || deviceRef.length > TOOL_ACTION_DEVICE_REF_MAX_LENGTH) {
    throw new Error("tool action device binding violates its bounded ref contract");
  }
  const inserted = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db)
      .insertInto("tool_action_device_bindings")
      .values({
        event_id: params.eventId,
        device_ref: deviceRef,
        occurred_at: params.occurredAt,
      })
      .onConflict((conflict) => conflict.column("event_id").doNothing()),
  );
  return Number(inserted.numAffectedRows ?? 0n) > 0;
}

/** Device refs for one read page, keyed by their tool-action event id. */
export function readToolActionDeviceBindingsInDatabase(
  db: DatabaseSync,
  eventIds: readonly string[],
): Map<string, string> {
  const refs = new Map<string, string>();
  if (eventIds.length === 0 || !tableExists(db, "tool_action_device_bindings")) {
    return refs;
  }
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db)
      .selectFrom("tool_action_device_bindings")
      .select(["event_id", "device_ref"])
      .where("event_id", "in", eventIds),
  ).rows;
  for (const row of rows) {
    if (typeof row.event_id === "string" && typeof row.device_ref === "string") {
      refs.set(row.event_id, row.device_ref);
    }
  }
  return refs;
}

function countToolActionDeviceBindings(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db)
      .selectFrom("tool_action_device_bindings")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function deleteExpiredToolActionDeviceBindings(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
  limit: number,
): number {
  const kysely = getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db);
  const expiredIds = kysely
    .selectFrom("tool_action_device_bindings")
    .select("sequence")
    .where("occurred_at", "<", now - retentionMs)
    .orderBy("occurred_at", "asc")
    .orderBy("sequence", "asc")
    .limit(limit);
  const deleted = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("tool_action_device_bindings").where("sequence", "in", expiredIds),
  );
  return Number(deleted.numAffectedRows ?? 0n);
}

/** Delete the oldest overflow by a monotonic sequence cutoff, never a retained-id scan. */
function pruneOverflowToolActionDeviceBindings(
  db: DatabaseSync,
  limits: ToolActionDeviceBindingLimits,
): number {
  const kysely = getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db);
  const retainedRows = Math.max(0, limits.maxRows - limits.pruneBatchRows);
  const overflow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("tool_action_device_bindings")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(retainedRows)
      .limit(1),
  );
  const cutoff = normalizeSqliteNumber(overflow?.sequence ?? null);
  if (cutoff === undefined) {
    return 0;
  }
  const deleted = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("tool_action_device_bindings").where("sequence", "<=", cutoff),
  );
  return Number(deleted.numAffectedRows ?? 0n);
}

function pruneToolActionDeviceBindings(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
  limits: ToolActionDeviceBindingLimits,
  insertedRows: number,
): void {
  if (!tableExists(db, "tool_action_device_bindings")) {
    return;
  }
  const expired = deleteExpiredToolActionDeviceBindings(
    db,
    now,
    retentionMs,
    limits.pruneBatchRows,
  );
  const cached = bindingRowCounts.get(db);
  let rowCount =
    cached === undefined
      ? countToolActionDeviceBindings(db)
      : Math.max(0, cached + insertedRows - expired);
  if (rowCount > limits.maxRows) {
    rowCount = Math.max(0, rowCount - pruneOverflowToolActionDeviceBindings(db, limits));
  }
  bindingRowCounts.set(db, rowCount);
}

/** Prune after one companion insert without rescanning the retained id set. */
export function pruneToolActionDeviceBindingsAfterInsert(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
  limits: ToolActionDeviceBindingLimits = DEFAULT_BINDING_LIMITS,
): void {
  pruneToolActionDeviceBindings(db, now, retentionMs, limits, 1);
}

/** Retain one binding and prune its bounded overflow inside the same write transaction. */
export function recordToolActionDeviceBindingAfterInsert(
  db: DatabaseSync,
  params: { eventId: string; deviceRef: string; occurredAt: number },
  retentionMs: number,
  limits: ToolActionDeviceBindingLimits = DEFAULT_BINDING_LIMITS,
): boolean {
  if (!recordToolActionDeviceBindingInDatabase(db, params)) {
    return false;
  }
  pruneToolActionDeviceBindingsAfterInsert(db, Date.now(), retentionMs, limits);
  return true;
}

/** Maintenance prune: recount from the table, then enforce cap/retention. */
export function pruneToolActionDeviceBindingsInDatabase(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
  limits: ToolActionDeviceBindingLimits = DEFAULT_BINDING_LIMITS,
): void {
  if (!tableExists(db, "tool_action_device_bindings")) {
    return;
  }
  try {
    // Ledger retention and other cascades can remove companion rows without
    // passing through the write-path count cache, so maintenance recounts.
    deleteExpiredToolActionDeviceBindings(db, now, retentionMs, limits.pruneBatchRows);
    let rowCount = countToolActionDeviceBindings(db);
    if (rowCount > limits.maxRows) {
      rowCount = Math.max(0, rowCount - pruneOverflowToolActionDeviceBindings(db, limits));
    }
    bindingRowCounts.set(db, rowCount);
  } catch (error) {
    bindingRowCounts.delete(db);
    throw error;
  }
}

/** Drop the cached count after a rolled-back transaction; the next write recounts. */
export function clearToolActionDeviceBindingRowCountCache(db: DatabaseSync): void {
  bindingRowCounts.delete(db);
}
