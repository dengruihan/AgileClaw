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

const VAULT_ENTRIES_TABLE = "vault_entries";
const VAULT_ENTRIES_ACCOUNT_ISSUE = `${VAULT_ENTRIES_TABLE}.account`;
const VAULT_ENTRIES_ACCOUNT_INDEX = "vault_entries_owner_active_account_idx";

const MIGRATION_TABLE = `${VAULT_ENTRIES_TABLE}_migration_new`;

/**
 * The vault entry table shipped before agent saves required a non-empty
 * account. Agent-saved partial logins store an empty account, which SQLite
 * keeps inside the column CHECK, so an upgraded database must be rebuilt with
 * the relaxed constraint before the runtime accepts one. This is the only
 * shipped legacy shape; every other difference stays a schema mismatch.
 */
const LEGACY_VAULT_ENTRIES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS vault_entries (
  item_ref TEXT NOT NULL PRIMARY KEY CHECK (length(item_ref) BETWEEN 1 AND 128),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('profile')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  origin_scheme TEXT NOT NULL CHECK (origin_scheme IN ('https', 'http')),
  origin_host TEXT NOT NULL CHECK (length(origin_host) BETWEEN 1 AND 253),
  origin_port INTEGER NOT NULL CHECK (origin_port BETWEEN 1 AND 65535),
  site_label TEXT NOT NULL CHECK (length(site_label) BETWEEN 1 AND 256),
  account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 512),
  label TEXT,
  has_notes INTEGER NOT NULL CHECK (has_notes IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  password_updated_at_ms INTEGER,
  last_used_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  deleted_at_ms INTEGER
) STRICT;`;

/** Pre-repair canonical named index; the rebuild replaces it with current DDL. */
const LEGACY_VAULT_ENTRIES_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS vault_entries_owner_active_account_idx
    ON vault_entries (owner_kind, owner_id, origin_host, account) WHERE deleted_at_ms IS NULL`;

function readTableSql(db: DatabaseSync, tableName: string): string | undefined {
  const statement = db // sqlite-allow-raw -- Fixed catalog lookup of one canonical table name.
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?");
  const row = statement.get(tableName);
  return typeof row?.sql === "string" ? row.sql : undefined;
}

let canonicalContract: SqliteTableContract | undefined;
let legacyIndexFingerprints: Set<string> | undefined;

function readCanonicalVaultEntriesShapes(): SqliteTableContract {
  canonicalContract ??= (() => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      database.exec(OPENCLAW_STATE_SCHEMA_SQL); // sqlite-allow-raw -- Private canonical fixture.
      const contract = createSqliteTableContractReader(database)(VAULT_ENTRIES_TABLE);
      if (!contract) {
        throw new Error(`Canonical vault schema is missing for ${VAULT_ENTRIES_TABLE}`);
      }
      legacyIndexFingerprints ??= readLegacyIndexFingerprints(database);
      return contract;
    } finally {
      database.close();
    }
  })();
  return canonicalContract;
}

/** Fingerprints of the pre-repair shipped index shape, captured on the fixture. */
function readLegacyIndexFingerprints(database: DatabaseSync): Set<string> {
  const fingerprints = new Set<string>();
  const reader = createSqliteTableContractReader(database);
  // The canonical statement uses IF NOT EXISTS, so replacing the shipped index
  // explicitly is what exposes the legacy fingerprint to the reader.
  database.exec(`DROP INDEX IF EXISTS ${VAULT_ENTRIES_ACCOUNT_INDEX};`); // sqlite-allow-raw -- Private fixture.
  database.exec(`${LEGACY_VAULT_ENTRIES_INDEX_SQL};`); // sqlite-allow-raw -- Private fixture.
  const withLegacyIndex = reader(VAULT_ENTRIES_TABLE);
  if (withLegacyIndex) {
    for (const index of withLegacyIndex.indexes) {
      fingerprints.add(JSON.stringify(index));
    }
  }
  return fingerprints;
}

function canonicalCreateSql(): string {
  return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, VAULT_ENTRIES_TABLE, {
    endMarker: "\n) STRICT;",
    errorMessage: `Canonical vault schema markers are missing for ${VAULT_ENTRIES_TABLE}`,
  });
}

/**
 * True only while the table is the exact shipped pre-agent-save shape and
 * carries no foreign explicit or unique index. The canonical index owner
 * repairs a missing or drifted named index; extra or missing columns, a
 * different constraint, a trigger, or a foreign index stays a mismatch so the
 * caller's canonical schema check refuses it instead of rebuilding it.
 */
export function needsVaultEntriesAccountRepair(db: DatabaseSync): boolean {
  const sql = readTableSql(db, VAULT_ENTRIES_TABLE);
  if (
    sql === undefined ||
    normalizeSchemaSql(sql) !== normalizeSchemaSql(LEGACY_VAULT_ENTRIES_TABLE_SQL)
  ) {
    return false;
  }
  const actual = createSqliteTableContractReader(db)(VAULT_ENTRIES_TABLE);
  if (!actual) {
    return false;
  }
  const expected = readCanonicalVaultEntriesShapes();
  const acceptedFingerprints = new Set([
    ...expected.indexes.map((index) => JSON.stringify(index)),
    ...(legacyIndexFingerprints ?? []),
  ]);
  const canonicalIndexNames = new Set(
    expected.indexes.flatMap((index) => (index.name === null ? [] : [index.name])),
  );
  // The canonical index owner repairs a missing or drifted named index. Any
  // other explicit or unique index is foreign structure and stays a refusal.
  const foreignIndex = actual.indexes.some(
    (index) =>
      (index.origin === "c" && (index.name === null || !canonicalIndexNames.has(index.name))) ||
      (index.unique === 1 && !acceptedFingerprints.has(JSON.stringify(index))),
  );
  return !foreignIndex && JSON.stringify(actual.triggers) === JSON.stringify(expected.triggers);
}

/** The only schema issue this repair owns; callers also check the table shape. */
export function isVaultEntriesAccountDefinitionIssue(issue: SqliteSchemaIssue): boolean {
  return (
    issue.code === "column-definition-drift" && issue.objectName === VAULT_ENTRIES_ACCOUNT_ISSUE
  );
}

/**
 * The shipped account index also drifts alongside the column CHECK: the
 * canonical partial index gained the `account <> ''` filter. Both index issues
 * are owned by the same rebuild.
 */
export function isVaultEntriesAccountIndexIssue(issue: SqliteSchemaIssue): boolean {
  return (
    (issue.code === "missing-or-drifted-index" || issue.code === "unexpected-unique-index") &&
    issue.objectName === VAULT_ENTRIES_ACCOUNT_INDEX
  );
}

function readColumnNames(db: DatabaseSync): string[] {
  const rows = db // sqlite-allow-raw -- Declared column order for the row-preserving copy.
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(VAULT_ENTRIES_TABLE);
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new Error(`${VAULT_ENTRIES_TABLE} has an unreadable column definition`);
    }
    return row.name;
  });
}

function recreateCanonicalIndexes(db: DatabaseSync): void {
  for (const index of getCanonicalSqliteNamedIndexContracts(OPENCLAW_STATE_SCHEMA_SQL)) {
    if (index.tableName !== VAULT_ENTRIES_TABLE || index.fingerprint.sql === null) {
      continue;
    }
    // DROP TABLE removed the named index; recreate the exact canonical definition.
    db.exec(`${index.fingerprint.sql};`); // sqlite-allow-raw -- Canonical index DDL.
  }
}

function rebuildVaultEntriesTable(db: DatabaseSync): void {
  if (tableExists(db, MIGRATION_TABLE)) {
    // Foreign data may own this name; the shipped repair never leaves it behind.
    throw new Error(`Refusing to replace unexpected table ${MIGRATION_TABLE}`);
  }
  const columns = readColumnNames(db);
  const columnList = columns.map(quoteSqliteIdentifier).join(", ");
  const createSql = canonicalCreateSql().replace(
    `CREATE TABLE IF NOT EXISTS ${VAULT_ENTRIES_TABLE}`,
    `CREATE TABLE ${quoteSqliteIdentifier(MIGRATION_TABLE)}`,
  );
  db.exec(createSql); // sqlite-allow-raw -- Canonical vault entry table shape.
  const copySql =
    `INSERT INTO ${quoteSqliteIdentifier(MIGRATION_TABLE)} (${columnList}) ` +
    `SELECT ${columnList} FROM ${quoteSqliteIdentifier(VAULT_ENTRIES_TABLE)}`;
  db.exec(copySql); // sqlite-allow-raw -- Row-preserving metadata copy.
  // FK enforcement is off for this rebuild, so the child secret rows survive.
  db.exec(`DROP TABLE ${quoteSqliteIdentifier(VAULT_ENTRIES_TABLE)}`); // sqlite-allow-raw
  const renameSql =
    `ALTER TABLE ${quoteSqliteIdentifier(MIGRATION_TABLE)} ` +
    `RENAME TO ${quoteSqliteIdentifier(VAULT_ENTRIES_TABLE)}`;
  db.exec(renameSql); // sqlite-allow-raw
  recreateCanonicalIndexes(db);
}

/**
 * Converge the one known vault entry account drift inside the caller's
 * transaction. Returns false when the table is absent, canonical, or an
 * unrecognized shape. Callers that are not already inside a
 * FK-disabled transaction get one here: referenced-table rebuilds must not
 * cascade-delete vault_entry_secrets rows.
 */
export function repairVaultEntriesAccountConstraint(db: DatabaseSync): boolean {
  if (db.isTransaction) {
    if (!needsVaultEntriesAccountRepair(db)) {
      return false;
    }
    rebuildVaultEntriesTable(db);
    return true;
  }
  if (!needsVaultEntriesAccountRepair(db)) {
    return false;
  }
  const foreignKeysWereEnabled =
    Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
  if (foreignKeysWereEnabled) {
    db.exec("PRAGMA foreign_keys = OFF;");
  }
  try {
    let repaired = false;
    runSqliteImmediateTransactionSync(
      db,
      () => {
        // Recheck under the write lock so a concurrent writer cannot change the shape.
        if (!needsVaultEntriesAccountRepair(db)) {
          return;
        }
        rebuildVaultEntriesTable(db);
        repaired = true;
      },
      {
        databaseLabel: VAULT_ENTRIES_TABLE,
        operationLabel: "state.schema.vault-entries-account",
      },
    );
    return repaired;
  } finally {
    if (foreignKeysWereEnabled && db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}
