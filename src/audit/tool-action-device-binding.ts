/** Lazy companion retaining the executing device for tool-action audit rows. */
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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
const ensuredBindingDatabases = new WeakSet<DatabaseSync>();

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
): void {
  const deviceRef = params.deviceRef.trim();
  if (!params.eventId || !deviceRef || deviceRef.length > TOOL_ACTION_DEVICE_REF_MAX_LENGTH) {
    throw new Error("tool action device binding violates its bounded ref contract");
  }
  executeSqliteQuerySync(
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

function deleteExpiredToolActionDeviceBindings(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
  limit: number,
) {
  const kysely = getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db);
  const expiredIds = kysely
    .selectFrom("tool_action_device_bindings")
    .select("event_id")
    .where("occurred_at", "<", now - retentionMs)
    .orderBy("occurred_at", "asc")
    .limit(limit);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("tool_action_device_bindings").where("event_id", "in", expiredIds),
  );
}

/** Prune one bounded batch with the ledger's retention clock and row cap. */
export function pruneToolActionDeviceBindingsInDatabase(
  db: DatabaseSync,
  now: number,
  retentionMs: number,
): void {
  const kysely = getNodeSqliteKysely<ToolActionDeviceBindingDatabase>(db);
  if (!tableExists(db, "tool_action_device_bindings")) {
    return;
  }
  const expired = deleteExpiredToolActionDeviceBindings(
    db,
    now,
    retentionMs,
    TOOL_ACTION_DEVICE_BINDING_PRUNE_BATCH_ROWS,
  );
  const remaining =
    TOOL_ACTION_DEVICE_BINDING_PRUNE_BATCH_ROWS - Number(expired.numAffectedRows ?? 0n);
  if (remaining <= 0) {
    return;
  }
  const retainedIds = kysely
    .selectFrom("tool_action_device_bindings")
    .select("event_id")
    .orderBy("occurred_at", "desc")
    .limit(TOOL_ACTION_DEVICE_BINDING_MAX_ROWS);
  const overflowIds = kysely
    .selectFrom("tool_action_device_bindings")
    .select("event_id")
    .where("event_id", "not in", retainedIds)
    .orderBy("occurred_at", "asc")
    .limit(remaining);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("tool_action_device_bindings").where("event_id", "in", overflowIds),
  );
}
