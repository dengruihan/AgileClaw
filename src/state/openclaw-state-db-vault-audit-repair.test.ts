// Covers the shipped pre-fill vault audit table upgrade through the real
// shared-state startup and doctor entries. The old release snapshot created
// vault_audit_events with an action CHECK that lacked `fill`, so an upgraded
// database refused schema admission before the vault worker could run.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { extractSqliteTableSchema, normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { insertVaultAudit } from "../vault/vault-kernel.worker.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { needsVaultAuditActionRepair } from "./openclaw-state-db-vault-audit-repair.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const REPAIR_CHANGE = "Repaired shared-state vault audit action constraint";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const startupConfig: OpenClawConfig = { agents: { entries: {} } };

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function stateOptions(stateDir: string) {
  return { env: { OPENCLAW_STATE_DIR: stateDir } };
}

function canonicalAuditTableSql(): string {
  return extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "vault_audit_events", {
    endMarker: "\n) STRICT;",
  });
}

/** The previous release shipped the canonical block without the `fill` action. */
function legacyAuditTableSql(): string {
  const canonical = canonicalAuditTableSql();
  const legacy = canonical.replace("'fill', ", "");
  expect(legacy).not.toBe(canonical);
  return legacy;
}

function createStateDatabase(stateDir: string): string {
  const pathname = openOpenClawStateDatabase(stateOptions(stateDir)).path;
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

function replaceAuditTable(database: DatabaseSync, tableSql: string): void {
  database.exec("DROP TABLE IF EXISTS vault_audit_events;");
  database.exec(`${tableSql}\n`);
  database.exec(`CREATE INDEX IF NOT EXISTS vault_audit_events_owner_sequence_idx
    ON vault_audit_events (owner_kind, owner_id, sequence DESC);`);
  database.exec(`INSERT INTO vault_audit_events
      (event_id, owner_kind, owner_id, action, status, item_ref, reason_code, occurred_at_ms)
    VALUES ('evt-1', 'profile', 'profile-1', 'create', 'succeeded', 'item-a', NULL, 1000),
           ('evt-2', 'profile', 'profile-1', 'reveal', 'failed', NULL, 'locked', 2000);`);
  // Retained high-water marks are part of the audit pagination contract.
  database.exec("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'vault_audit_events';");
}

function createLegacyDatabase(stateDir: string): string {
  const pathname = createStateDatabase(stateDir);
  const database = new DatabaseSync(pathname);
  try {
    replaceAuditTable(database, legacyAuditTableSql());
    expect(needsVaultAuditActionRepair(database)).toBe(true);
  } finally {
    database.close();
  }
  return pathname;
}

function readTableSql(database: DatabaseSync): string {
  const row = database
    .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
    .get("vault_audit_events") as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("vault_audit_events is missing");
  }
  return row.sql;
}

function readAuditRows(database: DatabaseSync) {
  return database
    .prepare("SELECT sequence, event_id, action FROM vault_audit_events ORDER BY sequence")
    .all()
    .map((row) => ({
      sequence: Number(row.sequence),
      event_id: String(row.event_id),
      action: String(row.action),
    }));
}

function readStateVersionFacts(database: DatabaseSync) {
  const userVersion = database.prepare("PRAGMA user_version").get()?.user_version;
  const meta = database
    .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  return { userVersion, meta };
}

function expectCanonicalAuditSchema(database: DatabaseSync, pathname: string): void {
  expect(() => assertCurrentStateRuntimeSchema(database, pathname)).not.toThrow();
  expect(needsVaultAuditActionRepair(database)).toBe(false);
  const auditIndex = database
    .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'index' AND name = ?")
    .get("vault_audit_events_owner_sequence_idx") as { sql?: unknown } | undefined;
  expect(typeof auditIndex?.sql).toBe("string");
  expect(normalizeSchemaSql(auditIndex?.sql as string)).toBe(
    "CREATE INDEX vault_audit_events_owner_sequence_idx ON vault_audit_events (owner_kind, owner_id, sequence DESC)",
  );
}

describe("vault audit action schema repair", () => {
  it("admits the pre-fill drift at the gateway startup gate and repairs it on open", async () => {
    const stateDir = tempDirs.make("vault-audit-startup-");
    createLegacyDatabase(stateDir);

    await expect(
      assertOpenClawDatabasesReady({
        env: stateOptions(stateDir).env,
        config: startupConfig,
        operation: "gateway-startup",
      }),
    ).resolves.toBeUndefined();

    const { db, path } = openOpenClawStateDatabase(stateOptions(stateDir));
    expectCanonicalAuditSchema(db, path);
    expect(readAuditRows(db)).toEqual([
      { sequence: 1, event_id: "evt-1", action: "create" },
      { sequence: 2, event_id: "evt-2", action: "reveal" },
    ]);

    insertVaultAudit(
      db,
      { kind: "profile", id: "profile-1" },
      { eventId: "evt-3", action: "fill", status: "succeeded", itemRef: "item-a" },
      3000,
    );
    expect(readAuditRows(db).map((row) => row.sequence)).toEqual([1, 2, 8]);
    closeOpenClawStateDatabaseForTest();

    const reopened = new DatabaseSync(path);
    try {
      expect(readStateVersionFacts(reopened)).toEqual({
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        meta: { role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
      });
    } finally {
      reopened.close();
    }
  });

  it("repairs through doctor, preserves rows, and is idempotent", () => {
    const stateDir = tempDirs.make("vault-audit-doctor-");
    const pathname = createLegacyDatabase(stateDir);

    const first = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(first.warnings).toEqual([]);
    expect(first.changes).toContain(REPAIR_CHANGE);

    const second = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(second.warnings).toEqual([]);
    expect(second.changes).not.toContain(REPAIR_CHANGE);

    const database = new DatabaseSync(pathname);
    try {
      expectCanonicalAuditSchema(database, pathname);
      expect(readAuditRows(database)).toEqual([
        { sequence: 1, event_id: "evt-1", action: "create" },
        { sequence: 2, event_id: "evt-2", action: "reveal" },
      ]);
      expect(readStateVersionFacts(database)).toEqual({
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        meta: { role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
      });
      insertVaultAudit(
        database,
        { kind: "profile", id: "profile-1" },
        { eventId: "evt-3", action: "fill", status: "succeeded", itemRef: "item-a" },
        3000,
      );
      const sequences = database
        .prepare("SELECT sequence FROM vault_audit_events ORDER BY sequence")
        .all()
        .map((row) => row.sequence);
      expect(sequences).toEqual([1, 2, 8]);
    } finally {
      database.close();
    }
  });

  it("repairs the table while the index owner restores a missing canonical index", () => {
    const stateDir = tempDirs.make("vault-audit-missing-index-");
    const pathname = createLegacyDatabase(stateDir);
    const seeded = new DatabaseSync(pathname);
    try {
      seeded.exec("DROP INDEX vault_audit_events_owner_sequence_idx;");
      expect(needsVaultAuditActionRepair(seeded)).toBe(true);
    } finally {
      seeded.close();
    }

    const result = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(REPAIR_CHANGE);

    const after = new DatabaseSync(pathname);
    try {
      expectCanonicalAuditSchema(after, pathname);
      expect(readAuditRows(after).map((row) => row.event_id)).toEqual(["evt-1", "evt-2"]);
    } finally {
      after.close();
    }
  });

  it("leaves a canonical table and an absent first-use table alone", () => {
    const canonicalDir = tempDirs.make("vault-audit-canonical-");
    createStateDatabase(canonicalDir);
    const result = repairOpenClawStateDatabaseSchema(stateOptions(canonicalDir));
    expect(result.warnings).toEqual([]);
    expect(result.changes).not.toContain(REPAIR_CHANGE);

    const { DatabaseSync: Database } = requireNodeSqlite();
    const stateDir = tempDirs.make("vault-audit-absent-");
    const pathname = createStateDatabase(stateDir);
    const absent = new Database(pathname);
    try {
      expect(
        absent
          .prepare("SELECT 1 AS found FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
          .get("vault_audit_events"),
      ).toBeUndefined();
    } finally {
      absent.close();
    }
    const absentRepair = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(absentRepair.warnings).toEqual([]);
    expect(absentRepair.changes).not.toContain(REPAIR_CHANGE);
  });

  it.each([
    {
      name: "an extra column",
      mutate: (database: DatabaseSync) =>
        database.exec("ALTER TABLE vault_audit_events ADD COLUMN mystery TEXT;"),
    },
    {
      name: "an unknown action",
      mutate: (database: DatabaseSync) =>
        replaceAuditTable(
          database,
          legacyAuditTableSql().replace("'purge-expired'", "'purge-expired', 'export'"),
        ),
    },
    {
      name: "an extra unique index",
      mutate: (database: DatabaseSync) =>
        database.exec(
          "CREATE UNIQUE INDEX vault_audit_events_unknown_unique_idx ON vault_audit_events (event_id, occurred_at_ms);",
        ),
    },
  ])("refuses $name instead of rebuilding it", ({ mutate }) => {
    const stateDir = tempDirs.make("vault-audit-unknown-");
    const pathname = createLegacyDatabase(stateDir);
    const before = new DatabaseSync(pathname);
    let beforeSql: string;
    try {
      mutate(before);
      beforeSql = readTableSql(before);
    } finally {
      before.close();
    }
    expect(beforeSql).not.toBe(legacyAuditTableSql());

    const result = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(result.changes).not.toContain(REPAIR_CHANGE);
    expect(result.warnings).toHaveLength(1);

    const after = new DatabaseSync(pathname);
    try {
      expect(readTableSql(after)).toBe(beforeSql);
      expect(readAuditRows(after)).toEqual([
        { sequence: 1, event_id: "evt-1", action: "create" },
        { sequence: 2, event_id: "evt-2", action: "reveal" },
      ]);
    } finally {
      after.close();
    }
    expect(() => openOpenClawStateDatabase(stateOptions(stateDir))).toThrow(/vault_audit_events/iu);
    closeOpenClawStateDatabaseForTest();
  });

  it("rolls the rebuild back when a later repair step fails", () => {
    const stateDir = tempDirs.make("vault-audit-rollback-");
    const pathname = createLegacyDatabase(stateDir);
    const seeded = new DatabaseSync(pathname);
    try {
      // An unexpected unique index fails index verification after the audit rebuild.
      seeded.exec("CREATE UNIQUE INDEX unexpected_unique_idx ON schema_meta (meta_key);");
    } finally {
      seeded.close();
    }

    const result = repairOpenClawStateDatabaseSchema(stateOptions(stateDir));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/unexpected unique index/iu);

    const after = new DatabaseSync(pathname);
    try {
      expect(normalizeSchemaSql(readTableSql(after))).toBe(
        normalizeSchemaSql(legacyAuditTableSql()),
      );
      expect(readAuditRows(after)).toEqual([
        { sequence: 1, event_id: "evt-1", action: "create" },
        { sequence: 2, event_id: "evt-2", action: "reveal" },
      ]);
      expect(
        after.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'vault_audit_events'").get(),
      ).toEqual({ seq: 7 });
    } finally {
      after.close();
    }
    expect(() => openOpenClawStateDatabase(stateOptions(stateDir))).toThrow();
    closeOpenClawStateDatabaseForTest();
  });
});
