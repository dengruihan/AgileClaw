import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VaultService } from "./vault-service.js";
import { VaultError } from "./vault-types.js";

const PASSPHRASE = "correct horse battery staple";
const SYNTHETIC_PASSWORD = "k9Q!vault-synthetic-Pa55word";
const SYNTHETIC_NOTES = "synthetic recovery code: 4F7A-19C2";

function expectVaultError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(VaultError);
  expect((error as VaultError).code).toBe(code);
}

function scanStateBytes(root: string, needle: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const file = `${entry.parentPath}/${entry.name}`;
    const body = fs.readFileSync(file);
    if (body.includes(Buffer.from(needle, "utf8"))) {
      hits.push(file);
    }
  }
  return hits;
}

describe("personal password vault service", () => {
  let service: VaultService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("encrypts values at rest, reveals only on demand, and never stores plaintext bytes", async () => {
    await withOpenClawTestState({ label: "vault-service", scenario: "minimal" }, async (state) => {
      service = new VaultService({ env: state.env });
      const initialized = await service.initialize(PASSPHRASE, 60);
      expect(initialized.state).toBe("unlocked");

      const entry = await service.create({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "person@example.com",
        label: "Work",
        password: SYNTHETIC_PASSWORD,
        notes: SYNTHETIC_NOTES,
      });
      expect(entry.itemRef).toMatch(/^vault_[0-9a-f-]{36}$/u);
      expect(entry.account).toBe("person@example.com");
      expect(entry.hasNotes).toBe(true);

      const listed = await service.list(false);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_PASSWORD);
      expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_NOTES);

      const revealed = await service.reveal(entry.itemRef, "reveal");
      expect(revealed.password).toBe(SYNTHETIC_PASSWORD);
      expect(revealed.notes).toBe(SYNTHETIC_NOTES);
      expect(revealed.entry.lastUsedAtMs).toBeTypeOf("number");

      const audit = await service.auditList(20);
      expect(audit.map((event) => event.action)).toEqual(
        expect.arrayContaining(["initialize", "create", "reveal"]),
      );
      expect(JSON.stringify(audit)).not.toContain(SYNTHETIC_PASSWORD);
      expect(JSON.stringify(audit)).not.toContain(SYNTHETIC_NOTES);

      await service.close();
      service = undefined;
      expect(scanStateBytes(state.stateDir, SYNTHETIC_PASSWORD)).toEqual([]);
      expect(scanStateBytes(state.stateDir, SYNTHETIC_NOTES)).toEqual([]);
    });
  });

  it("distinguishes a wrong passphrase from corrupted ciphertext and enforces AAD binding", async () => {
    await withOpenClawTestState({ label: "vault-aad", scenario: "minimal" }, async (state) => {
      service = new VaultService({ env: state.env });
      await service.initialize(PASSPHRASE, 60);
      const entry = await service.create({
        originScheme: "https",
        originHost: "bank.example",
        originPort: 443,
        siteLabel: "Bank",
        account: "person@example.com",
        password: SYNTHETIC_PASSWORD,
        notes: "",
      });
      await service.lock();
      await expect(service.unlock("wrong passphrase value")).rejects.toSatisfy((error: unknown) => {
        expectVaultError(error, "VAULT_WRONG_PASSPHRASE");
        return true;
      });
      await service.unlock(PASSPHRASE);
      await service.close();
      service = undefined;

      const database = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
      database
        .prepare("UPDATE vault_entries SET origin_host = ? WHERE item_ref = ?")
        .run("bank-login.example", entry.itemRef);
      database.close();

      service = new VaultService({ env: state.env });
      await service.unlock(PASSPHRASE);
      await expect(service.reveal(entry.itemRef, "reveal")).rejects.toSatisfy((error: unknown) => {
        expectVaultError(error, "VAULT_CORRUPTED");
        return true;
      });
    });
  });

  it("rejects stale revisions and keeps soft-deleted entries restorable for 7 days", async () => {
    await withOpenClawTestState(
      { label: "vault-revisions", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        const entry = await service.create({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "Example",
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
          notes: "",
        });
        const updated = await service.update({
          itemRef: entry.itemRef,
          revision: entry.revision,
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "Example updated",
          account: "person@example.com",
          password: "replacement-synthetic-password",
          notes: "note",
        });
        expect(updated.revision).toBe(entry.revision + 1);
        await expect(
          service.update({
            itemRef: entry.itemRef,
            revision: entry.revision,
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            siteLabel: "stale",
            account: "person@example.com",
            notes: "",
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_CONFLICT");
          return true;
        });

        await service.delete(entry.itemRef, updated.revision);
        expect(await service.list(false)).toEqual([]);
        expect(await service.list(true)).toHaveLength(1);
        await service.restore(entry.itemRef);
        expect(await service.list(false)).toHaveLength(1);

        await service.delete(entry.itemRef, updated.revision);
        await service.close();
        service = undefined;

        const database = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
        database
          .prepare("UPDATE vault_entries SET deleted_at_ms = ? WHERE item_ref = ?")
          .run(Date.now() - 8 * 24 * 60 * 60_000, entry.itemRef);
        database.close();

        service = new VaultService({ env: state.env });
        await service.unlock(PASSPHRASE);
        await service.list(false);
        expect(await service.list(true)).toEqual([]);
        const audit = await service.auditList(50);
        expect(audit.map((event) => event.action)).toContain("purge-expired");
      },
    );
  });

  it("backs off after repeated wrong passphrases and starts locked after restart", async () => {
    await withOpenClawTestState({ label: "vault-lockout", scenario: "minimal" }, async (state) => {
      service = new VaultService({ env: state.env });
      const initialized = await service.initialize(PASSPHRASE, 60);
      expect(initialized.state).toBe("unlocked");
      await service.lock();
      await service.close();
      service = undefined;

      service = new VaultService({ env: state.env });
      expect((await service.status()).state).toBe("locked");
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(service.unlock(`wrong-pass-${String(attempt)}`)).rejects.toSatisfy(
          (error: unknown) => {
            expectVaultError(error, "VAULT_WRONG_PASSPHRASE");
            return true;
          },
        );
      }
      await expect(service.unlock("wrong-pass-4")).rejects.toSatisfy((error: unknown) => {
        expectVaultError(error, "VAULT_LOCKED_OUT");
        return true;
      });
      const status = await service.status();
      expect(status.failedAttempts).toBe(5);
      expect(status.lockedUntilMs).toBeTypeOf("number");
    });
  });
});
