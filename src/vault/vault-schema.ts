import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export const VAULT_TABLE_NAMES = [
  "vault_entries",
  "vault_entry_secrets",
  "vault_keys",
  "vault_key_wraps",
  "vault_meta",
  "vault_audit_events",
] as const;

const VAULT_INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS vault_entries_owner_active_account_idx
    ON vault_entries (owner_kind, owner_id, origin_host, account) WHERE deleted_at_ms IS NULL`,
  `CREATE INDEX IF NOT EXISTS vault_entries_owner_live_idx
    ON vault_entries (owner_kind, owner_id, deleted_at_ms, updated_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS vault_entries_owner_deleted_idx
    ON vault_entries (owner_kind, owner_id, deleted_at_ms) WHERE deleted_at_ms IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vault_keys_owner_live_idx
    ON vault_keys (owner_kind, owner_id) WHERE retired_at_ms IS NULL`,
  `CREATE INDEX IF NOT EXISTS vault_audit_events_owner_sequence_idx
    ON vault_audit_events (owner_kind, owner_id, sequence DESC)`,
] as const;

function vaultTableSql(table: string): string {
  return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
    endMarker: "\n) STRICT;",
    errorMessage: `Canonical vault schema markers are missing for ${table}`,
  });
}

/** First-use additive install for the personal password vault tables. */
export function ensureVaultSchema(database: DatabaseSync): void {
  for (const table of VAULT_TABLE_NAMES) {
    database.exec(vaultTableSql(table)); // sqlite-allow-raw -- Canonical feature-owned additive DDL only.
  }
  upgradeVaultAuditActions(database);
  for (const index of VAULT_INDEX_SQL) {
    database.exec(`${index};`); // sqlite-allow-raw -- Canonical feature-owned additive DDL only.
  }
}

const VAULT_AUDIT_COLUMNS =
  "sequence, event_id, owner_kind, owner_id, action, status, item_ref, reason_code, occurred_at_ms";

/**
 * M35 shipped the audit table before agent fill existed. New audit actions are
 * part of the table's CHECK constraint, so an already-created table needs a
 * copy-and-rebuild migration. Fresh databases already contain the full list.
 */
function upgradeVaultAuditActions(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_audit_events'")
    .get() as { sql?: unknown } | undefined;
  const sql = typeof row?.sql === "string" ? row.sql : "";
  if (sql.length === 0 || sql.includes("'fill'")) {
    return;
  }
  database.exec("BEGIN IMMEDIATE"); // sqlite-allow-raw -- Feature-owned additive migration.
  try {
    database.exec("DROP TABLE IF EXISTS vault_audit_events_legacy"); // sqlite-allow-raw
    database.exec("ALTER TABLE vault_audit_events RENAME TO vault_audit_events_legacy"); // sqlite-allow-raw
    database.exec(vaultTableSql("vault_audit_events")); // sqlite-allow-raw
    database.exec(
      `INSERT INTO vault_audit_events (${VAULT_AUDIT_COLUMNS}) ` +
        `SELECT ${VAULT_AUDIT_COLUMNS} FROM vault_audit_events_legacy`,
    ); // sqlite-allow-raw
    database.exec("DROP TABLE vault_audit_events_legacy"); // sqlite-allow-raw
    database.exec("COMMIT"); // sqlite-allow-raw
  } catch (error) {
    database.exec("ROLLBACK"); // sqlite-allow-raw
    throw error;
  }
}
