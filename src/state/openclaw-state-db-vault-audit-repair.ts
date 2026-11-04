import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { SqliteTableContract } from "../infra/sqlite-schema-contract-assembly.js";
import {
  createSqliteTableContractReader,
  getCanonicalSqliteNamedIndexContracts,
  type SqliteSchemaIssue,
} from "../infra/sqlite-schema-contract.js";
import {
  extractSqliteTableSchema,
  normalizeSchemaSql,
  quoteSqliteIdentifier,
} from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const VAULT_AUDIT_TABLE = "vault_audit_events";
const VAULT_AUDIT_ACTION_ISSUE = `${VAULT_AUDIT_TABLE}.action`;

const MIGRATION_TABLE = `${VAULT_AUDIT_TABLE}_migration_new`;

/**
 * The vault audit table shipped before agent fill admitted only the actions
 * below. The fill feature added `fill` to the column CHECK, which SQLite stores
 * as part of the column definition, so an upgraded database keeps refusing the
 * new action until the table is rebuilt. This is the only shipped legacy shape;
 * every other difference stays a schema mismatch.
 */
const LEGACY_VAULT_AUDIT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vault_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('profile')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  action TEXT NOT NULL CHECK (action IN (
    'initialize', 'unlock', 'unlock-failed', 'lock', 'create', 'update',
    'delete', 'restore', 'purge', 'reveal', 'copy', 'generate', 'purge-expired'
  )),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  item_ref TEXT,
  reason_code TEXT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;`;

function readTableSql(db: DatabaseSync, tableName: string): string | undefined {
  const statement = db // sqlite-allow-raw -- Fixed catalog lookup of one canonical table name.
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?");
  const row = statement.get(tableName);
  return typeof row?.sql === "string" ? row.sql : undefined;
}

let canonicalContract: SqliteTableContract | undefined;

function readCanonicalVaultAuditContract(): SqliteTableContract {
  canonicalContract ??= (() => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      database.exec(OPENCLAW_STATE_SCHEMA_SQL); // sqlite-allow-raw -- Private canonical fixture.
      const contract = createSqliteTableContractReader(database)(VAULT_AUDIT_TABLE);
      if (!contract) {
        throw new Error(`Canonical vault audit schema is missing for ${VAULT_AUDIT_TABLE}`);
      }
      return contract;
    } finally {
      database.close();
    }
  })();
  return canonicalContract;
}

function canonicalCreateSql(): string {
  return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, VAULT_AUDIT_TABLE, {
    endMarker: "\n) STRICT;",
    errorMessage: `Canonical vault schema markers are missing for ${VAULT_AUDIT_TABLE}`,
  });
}

/**
 * True only while the table is the exact shipped pre-fill shape and carries no
 * foreign explicit or unique index. The canonical index owner repairs a missing
 * or drifted named index; extra or missing columns, a different constraint, a
 * trigger, or a foreign index stays a mismatch so the caller's canonical schema
 * check refuses it instead of rebuilding it.
 */
export function needsVaultAuditActionRepair(db: DatabaseSync): boolean {
  const sql = readTableSql(db, VAULT_AUDIT_TABLE);
  if (
    sql === undefined ||
    normalizeSchemaSql(sql) !== normalizeSchemaSql(LEGACY_VAULT_AUDIT_TABLE_SQL)
  ) {
    return false;
  }
  const actual = createSqliteTableContractReader(db)(VAULT_AUDIT_TABLE);
  if (!actual) {
    return false;
  }
  const expected = readCanonicalVaultAuditContract();
  const canonicalFingerprints = new Set(expected.indexes.map((index) => JSON.stringify(index)));
  const canonicalIndexNames = new Set(
    expected.indexes.flatMap((index) => (index.name === null ? [] : [index.name])),
  );
  // The canonical index owner repairs a missing or drifted named index. Any
  // other explicit or unique index is foreign structure and stays a refusal.
  const foreignIndex = actual.indexes.some(
    (index) =>
      (index.origin === "c" && (index.name === null || !canonicalIndexNames.has(index.name))) ||
      (index.unique === 1 && !canonicalFingerprints.has(JSON.stringify(index))),
  );
  return !foreignIndex && JSON.stringify(actual.triggers) === JSON.stringify(expected.triggers);
}

/** The only schema issue this repair owns; callers also check the table shape. */
export function isVaultAuditActionDefinitionIssue(issue: SqliteSchemaIssue): boolean {
  return issue.code === "column-definition-drift" && issue.objectName === VAULT_AUDIT_ACTION_ISSUE;
}

function readSequenceHighWater(db: DatabaseSync): string | null {
  if (!tableExists(db, "sqlite_sequence")) {
    return null;
  }
  const statement = db // sqlite-allow-raw -- Exact AUTOINCREMENT high-water read.
    .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = ?");
  const row = statement.get(VAULT_AUDIT_TABLE);
  if (row === undefined) {
    return null;
  }
  if (typeof row.seq !== "string" || !/^\d+$/u.test(row.seq)) {
    throw new Error(`${VAULT_AUDIT_TABLE} sequence high-water mark is invalid`);
  }
  return row.seq;
}

function restoreSequenceHighWater(db: DatabaseSync, highWater: string | null): void {
  if (highWater === null) {
    return;
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(VAULT_AUDIT_TABLE); // sqlite-allow-raw -- Restore the retained AUTOINCREMENT high-water mark.
  const insertSequenceSql =
    "INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))";
  db.prepare(insertSequenceSql).run(VAULT_AUDIT_TABLE, highWater); // sqlite-allow-raw -- Same sequence restore.
}

function readColumnNames(db: DatabaseSync): string[] {
  const rows = db // sqlite-allow-raw -- Declared column order for the row-preserving copy.
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(VAULT_AUDIT_TABLE);
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new Error(`${VAULT_AUDIT_TABLE} has an unreadable column definition`);
    }
    return row.name;
  });
}

function recreateCanonicalIndexes(db: DatabaseSync): void {
  for (const index of getCanonicalSqliteNamedIndexContracts(OPENCLAW_STATE_SCHEMA_SQL)) {
    if (index.tableName !== VAULT_AUDIT_TABLE || index.fingerprint.sql === null) {
      continue;
    }
    // DROP TABLE removed the named index; recreate the exact canonical definition.
    db.exec(`${index.fingerprint.sql};`); // sqlite-allow-raw -- Canonical index DDL.
  }
}

function rebuildVaultAuditTable(db: DatabaseSync): void {
  if (tableExists(db, MIGRATION_TABLE)) {
    // Foreign data may own this name; the shipped repair never leaves it behind.
    throw new Error(`Refusing to replace unexpected table ${MIGRATION_TABLE}`);
  }
  const columns = readColumnNames(db);
  const sequenceHighWater = readSequenceHighWater(db);
  const columnList = columns.map(quoteSqliteIdentifier).join(", ");
  const createSql = canonicalCreateSql().replace(
    `CREATE TABLE IF NOT EXISTS ${VAULT_AUDIT_TABLE}`,
    `CREATE TABLE ${quoteSqliteIdentifier(MIGRATION_TABLE)}`,
  );
  db.exec(createSql); // sqlite-allow-raw -- Canonical vault audit table shape.
  const copySql =
    `INSERT INTO ${quoteSqliteIdentifier(MIGRATION_TABLE)} (${columnList}) ` +
    `SELECT ${columnList} FROM ${quoteSqliteIdentifier(VAULT_AUDIT_TABLE)}`;
  db.exec(copySql); // sqlite-allow-raw -- Row-preserving copy of value-free audit events.
  db.exec(`DROP TABLE ${quoteSqliteIdentifier(VAULT_AUDIT_TABLE)}`); // sqlite-allow-raw
  const renameSql =
    `ALTER TABLE ${quoteSqliteIdentifier(MIGRATION_TABLE)} ` +
    `RENAME TO ${quoteSqliteIdentifier(VAULT_AUDIT_TABLE)}`;
  db.exec(renameSql); // sqlite-allow-raw
  // AUTOINCREMENT is the audit list cursor; a rebuilt table must not reuse a sequence.
  restoreSequenceHighWater(db, sequenceHighWater);
  recreateCanonicalIndexes(db);
}

/**
 * Converge the one known vault audit action drift inside the caller's transaction.
 * Returns false when the table is absent, canonical, or an unrecognized shape.
 */
export function repairVaultAuditActionConstraint(db: DatabaseSync): boolean {
  if (db.isTransaction) {
    if (!needsVaultAuditActionRepair(db)) {
      return false;
    }
    rebuildVaultAuditTable(db);
    return true;
  }
  let repaired = false;
  runSqliteImmediateTransactionSync(
    db,
    () => {
      // Recheck under the write lock so a concurrent writer cannot change the shape.
      if (!needsVaultAuditActionRepair(db)) {
        return;
      }
      rebuildVaultAuditTable(db);
      repaired = true;
    },
    {
      databaseLabel: VAULT_AUDIT_TABLE,
      operationLabel: "state.schema.vault-audit-action",
    },
  );
  return repaired;
}
