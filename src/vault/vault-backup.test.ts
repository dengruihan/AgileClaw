import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { dumpGitBackupDatabase } from "../snapshot/git-backup-codec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VaultService } from "./vault-service.js";

const PASSPHRASE = "correct horse battery staple";
const SYNTHETIC_PASSWORD = "backup-canary-Pa55word-9Q!";
const SYNTHETIC_NOTES = "backup-canary-notes-7F2A";

function scanTreeBytes(root: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const file = `${entry.parentPath}/${entry.name}`;
    if (fs.readFileSync(file).includes(Buffer.from(needle, "utf8"))) {
      hits.push(file);
    }
  }
  return hits;
}

describe("vault backup redaction", () => {
  let service: VaultService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("scans real Git backups and never includes plaintext vault values", async () => {
    await withOpenClawTestState({ label: "vault-backup", scenario: "minimal" }, async (state) => {
      service = new VaultService({ env: state.env });
      await service.initialize(PASSPHRASE, 60);
      await service.create({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "person@example.com",
        password: SYNTHETIC_PASSWORD,
        notes: SYNTHETIC_NOTES,
      });
      await service.close();
      service = undefined;

      const sourcePath = state.statePath("state", "openclaw.sqlite");
      const snapshotPath = state.path("vault-snapshot.sqlite");
      const snapshot = new DatabaseSync(sourcePath);
      snapshot.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
      snapshot.close();

      const redactedDir = state.path("git-backup-redacted");
      const redacted = await dumpGitBackupDatabase({
        snapshotPath,
        outputPath: redactedDir,
        identity: { role: "global" },
        excludeSecrets: true,
      });
      expect(redacted.excludedTables).toEqual(
        expect.arrayContaining([
          "vault_entries",
          "vault_entry_secrets",
          "vault_keys",
          "vault_key_wraps",
          "vault_meta",
          "vault_audit_events",
        ]),
      );
      expect(scanTreeBytes(redactedDir, SYNTHETIC_PASSWORD)).toEqual([]);
      expect(scanTreeBytes(redactedDir, SYNTHETIC_NOTES)).toEqual([]);

      const fullDir = state.path("git-backup-full");
      const full = await dumpGitBackupDatabase({
        snapshotPath,
        outputPath: fullDir,
        identity: { role: "global" },
        excludeSecrets: false,
      });
      expect(full.tables.vault_entry_secrets).toBeDefined();
      expect(scanTreeBytes(fullDir, SYNTHETIC_PASSWORD)).toEqual([]);
      expect(scanTreeBytes(fullDir, SYNTHETIC_NOTES)).toEqual([]);
    });
  });
});
