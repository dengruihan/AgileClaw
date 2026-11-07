// Covers the shipped pre-agent-save vault entry table upgrade through the real
// shared-state doctor entry. The old release created vault_entries with an
// account CHECK that required at least one character, so an upgraded database
// refused the empty-account rows agent saves create.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { insertVaultEntry } from "../vault/vault-kernel.worker.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { needsVaultEntriesAccountRepair } from "./openclaw-state-db-vault-entries-repair.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const REPAIR_CHANGE = "Relaxed shared-state vault entry account constraint";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const startupConfig: OpenClawConfig = { agents: { entries: {} } };
const OWNER = { kind: "profile" as const, id: "local" };

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function stateOptions(stateDir: string) {
  return { env: { OPENCLAW_STATE_DIR: stateDir } };
}

function legacyEntriesTableSql(): string {
  const canonical = OPENCLAW_STATE_SCHEMA_SQL.match(
    /CREATE TABLE IF NOT EXISTS vault_entries \(.*?\n\) STRICT;/su,
  )?.[0];
  if (!canonical) {
    throw new Error("canonical vault_entries schema is missing");
  }
  const legacy = canonical.replace(
    "CHECK (length(account) BETWEEN 0 AND 512)",
    "CHECK (length(account) BETWEEN 1 AND 512)",
  );
  expect(legacy).not.toBe(canonical);
  return legacy;
}

function legacyAccountIndexSql(): string {
  return `CREATE UNIQUE INDEX vault_entries_owner_active_account_idx
  ON vault_entries (owner_kind, owner_id, origin_host, account) WHERE deleted_at_ms IS NULL;`;
}

function createStateDatabase(stateDir: string): string {
  const pathname = openOpenClawStateDatabase(stateOptions(stateDir)).path;
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

function seedLegacyVaultTables(database: DatabaseSync): void {
  database.exec("DROP TABLE IF EXISTS vault_pending_entry_secrets;");
  database.exec("DROP TABLE IF EXISTS vault_entry_secrets;");
  database.exec("DROP TABLE IF EXISTS vault_entries;");
  database.exec(`${legacyEntriesTableSql()}\n`);
  database.exec(`${legacyAccountIndexSql()}\n`);
  database.exec(`CREATE TABLE IF NOT EXISTS vault_entry_secrets (
  item_ref TEXT NOT NULL PRIMARY KEY REFERENCES vault_entries(item_ref) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  aad_version INTEGER NOT NULL CHECK (aad_version = 1),
  secret_nonce BLOB NOT NULL CHECK (length(secret_nonce) = 12),
  secret_ciphertext BLOB NOT NULL,
  notes_nonce BLOB NOT NULL CHECK (length(notes_nonce) = 12),
  notes_ciphertext BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;`);
  insertVaultEntry(
    database,
    OWNER,
    {
      itemRef: "vault_legacy_item",
      scheme: "https",
      host: "example.com",
      port: 443,
      siteLabel: "Example",
      account: "person@example.com",
      hasNotes: false,
      revision: 1,
    },
    {
      keyId: "vk_legacy",
      secretNonce: Buffer.alloc(12),
      secretCiphertext: Buffer.from("ciphertext"),
      notesNonce: Buffer.alloc(12),
      notesCiphertext: Buffer.from("notes-ciphertext"),
    },
    1000,
  );
}

function createLegacyDatabase(stateDir: string): string {
  const pathname = createStateDatabase(stateDir);
  const database = new DatabaseSync(pathname);
  try {
    seedLegacyVaultTables(database);
    expect(needsVaultEntriesAccountRepair(database)).toBe(true);
  } finally {
    database.close();
  }
  return pathname;
}

function readEntryRows(database: DatabaseSync) {
  return database
    .prepare("SELECT item_ref, account FROM vault_entries ORDER BY item_ref")
    .all()
    .map((row) => ({ item_ref: String(row.item_ref), account: String(row.account) }));
}

function readSecretRefs(database: DatabaseSync) {
  return database
    .prepare("SELECT item_ref FROM vault_entry_secrets ORDER BY item_ref")
    .all()
    .map((row) => String(row.item_ref));
}

function expectCanonicalEntriesSchema(database: DatabaseSync, pathname: string): void {
  expect(needsVaultEntriesAccountRepair(database)).toBe(false);
  expect(() => {
    // The relaxed CHECK accepts the empty-account rows agent saves create.
    database
      .prepare(
        `INSERT INTO vault_entries
           (item_ref, owner_kind, owner_id, origin_scheme, origin_host, origin_port,
            site_label, account, label, has_notes, revision, password_updated_at_ms,
            last_used_at_ms, created_at_ms, updated_at_ms, deleted_at_ms)
         VALUES ('vault_blank_item', 'profile', 'local', 'https', 'example.com', 443,
           'Example', '', NULL, 0, 1, NULL, NULL, 1000, 1000, NULL)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO vault_entries
           (item_ref, owner_kind, owner_id, origin_scheme, origin_host, origin_port,
            site_label, account, label, has_notes, revision, password_updated_at_ms,
            last_used_at_ms, created_at_ms, updated_at_ms, deleted_at_ms)
         VALUES ('vault_blank_item_2', 'profile', 'local', 'https', 'example.com', 443,
           'Example', '', NULL, 0, 1, NULL, NULL, 1000, 1000, NULL)`,
      )
      .run();
    expect(readEntryRows(database)).toEqual([
      { item_ref: "vault_blank_item", account: "" },
      { item_ref: "vault_blank_item_2", account: "" },
      { item_ref: "vault_legacy_item", account: "person@example.com" },
    ]);
    database.exec("DELETE FROM vault_entries WHERE item_ref LIKE 'vault_blank%';");
  }).not.toThrow();
  const tableSql = database
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'vault_entries'")
    .get()?.sql;
  expect(typeof tableSql === "string" && tableSql.includes("BETWEEN 0 AND 512")).toBe(true);
  const indexSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND name = 'vault_entries_owner_active_account_idx'",
    )
    .get()?.sql;
  expect(
    typeof indexSql === "string" && normalizeSchemaSql(indexSql).includes("account <> ''"),
  ).toBe(true);
  expect(pathname.length).toBeGreaterThan(0);
}

describe("vault entry account schema repair", () => {
  it("admits the pre-agent-save drift at the gateway startup gate", async () => {
    const stateDir = tempDirs.make("vault-entries-startup-");
    createLegacyDatabase(stateDir);

    await expect(
      assertOpenClawDatabasesReady({
        env: stateOptions(stateDir).env,
        config: startupConfig,
        operation: "gateway-startup",
      }),
    ).resolves.toBeUndefined();

    const { db } = openOpenClawStateDatabase(stateOptions(stateDir));
    expect(readEntryRows(db)).toEqual([
      { item_ref: "vault_legacy_item", account: "person@example.com" },
    ]);
    // The child secret rows survive the referenced-table rebuild.
    expect(readSecretRefs(db)).toEqual(["vault_legacy_item"]);
    expectCanonicalEntriesSchema(db, "state");
    closeOpenClawStateDatabaseForTest();
  });

  it("repairs through doctor, preserves rows, and is idempotent", () => {
    const stateDir = tempDirs.make("vault-entries-doctor-");
    const pathname = createLegacyDatabase(stateDir);

    const first = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(first.warnings).toEqual([]);
    expect(first.changes).toContain(REPAIR_CHANGE);

    const second = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(second.warnings).toEqual([]);
    expect(second.changes).not.toContain(REPAIR_CHANGE);

    const database = new DatabaseSync(pathname);
    try {
      expect(readEntryRows(database)).toEqual([
        { item_ref: "vault_legacy_item", account: "person@example.com" },
      ]);
      expect(readSecretRefs(database)).toEqual(["vault_legacy_item"]);
      expectCanonicalEntriesSchema(database, pathname);
    } finally {
      database.close();
    }
  });

  it("leaves an absent first-use table alone", () => {
    const stateDir = tempDirs.make("vault-entries-absent-");
    createStateDatabase(stateDir);
    const database = new DatabaseSync(openStatePath(stateDir));
    try {
      expect(
        database
          .prepare("SELECT 1 AS found FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
          .get("vault_entries"),
      ).toBeUndefined();
    } finally {
      database.close();
    }
    const result = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(result.warnings).toEqual([]);
    expect(result.changes).not.toContain(REPAIR_CHANGE);
  });

  it("refuses an unrecognized shape instead of rebuilding it", () => {
    const stateDir = tempDirs.make("vault-entries-unknown-");
    const pathname = createLegacyDatabase(stateDir);
    const before = new DatabaseSync(pathname);
    let beforeSql: string;
    try {
      before.exec("ALTER TABLE vault_entries ADD COLUMN mystery TEXT;");
      beforeSql = String(
        before
          .prepare(
            "SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'vault_entries'",
          )
          .get()?.sql,
      );
    } finally {
      before.close();
    }

    const result = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(result.changes).not.toContain(REPAIR_CHANGE);
    expect(result.warnings).toHaveLength(1);

    const after = new DatabaseSync(pathname);
    try {
      const afterSql = String(
        after
          .prepare(
            "SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = 'vault_entries'",
          )
          .get()?.sql,
      );
      expect(afterSql).toBe(beforeSql);
      expect(readEntryRows(after)).toEqual([
        { item_ref: "vault_legacy_item", account: "person@example.com" },
      ]);
      expect(readSecretRefs(after)).toEqual(["vault_legacy_item"]);
    } finally {
      after.close();
    }
  });
});

function openStatePath(stateDir: string): string {
  const stateDb = openOpenClawStateDatabase(stateOptions(stateDir)).path;
  closeOpenClawStateDatabaseForTest();
  return stateDb;
}
