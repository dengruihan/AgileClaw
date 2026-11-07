import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export const VAULT_TABLE_NAMES = [
  "vault_entries",
  "vault_entry_secrets",
  "vault_keys",
  "vault_key_wraps",
  "vault_write_keys",
  "vault_write_key_wraps",
  "vault_pending_entry_secrets",
  "vault_meta",
  "vault_audit_events",
] as const;

const VAULT_INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS vault_entries_owner_active_account_idx
    ON vault_entries (owner_kind, owner_id, origin_host, account)
    WHERE deleted_at_ms IS NULL AND account <> ''`,
  `CREATE INDEX IF NOT EXISTS vault_entries_owner_live_idx
    ON vault_entries (owner_kind, owner_id, deleted_at_ms, updated_at_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS vault_entries_owner_deleted_idx
    ON vault_entries (owner_kind, owner_id, deleted_at_ms) WHERE deleted_at_ms IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vault_keys_owner_live_idx
    ON vault_keys (owner_kind, owner_id) WHERE retired_at_ms IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS vault_write_keys_owner_live_idx
    ON vault_write_keys (owner_kind, owner_id) WHERE retired_at_ms IS NULL`,
  `CREATE INDEX IF NOT EXISTS vault_audit_events_owner_sequence_idx
    ON vault_audit_events (owner_kind, owner_id, sequence DESC)`,
] as const;

function vaultTableSql(table: string): string {
  return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
    endMarker: "\n) STRICT;",
    errorMessage: `Canonical vault schema markers are missing for ${table}`,
  });
}

/**
 * First-use additive install for the personal password vault tables. The shared
 * state admission owns same-version shape repairs, including the vault audit
 * action constraint, so this only creates absent tables and indexes.
 */
export function ensureVaultSchema(database: DatabaseSync): void {
  for (const table of VAULT_TABLE_NAMES) {
    database.exec(vaultTableSql(table)); // sqlite-allow-raw -- Canonical feature-owned additive DDL only.
  }
  for (const index of VAULT_INDEX_SQL) {
    database.exec(`${index};`); // sqlite-allow-raw -- Canonical feature-owned additive DDL only.
  }
}
