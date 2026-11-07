import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VaultService } from "./vault-service.js";
import { VaultError } from "./vault-types.js";

const PASSPHRASE = "correct horse battery staple";
const SYNTHETIC_PASSWORD = "k9Q!agent-synthetic-Pa55word";
const SYNTHETIC_NOTES = "agent recovery code: 4F7A-19C2";

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

function openStateDatabase(state: { statePath: (...parts: string[]) => string }) {
  return new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
}

describe("agent vault saves", () => {
  let service: VaultService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("saves a complete login while unlocked and returns no secret values", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-open", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "Example",
          account: "person@example.com",
          label: "Work",
          password: SYNTHETIC_PASSWORD,
          notes: SYNTHETIC_NOTES,
        });
        expect(entry.account).toBe("person@example.com");
        expect(entry.hasNotes).toBe(true);
        expect(JSON.stringify(entry)).not.toContain(SYNTHETIC_PASSWORD);
        expect(JSON.stringify(entry)).not.toContain(SYNTHETIC_NOTES);

        const revealed = await service.reveal(entry.itemRef, "reveal");
        expect(revealed.password).toBe(SYNTHETIC_PASSWORD);
        expect(revealed.notes).toBe(SYNTHETIC_NOTES);

        const audit = await service.auditList(20);
        expect(audit).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: "create",
              status: "succeeded",
              reasonCode: "agent",
              itemRef: entry.itemRef,
            }),
          ]),
        );
        expect(JSON.stringify(audit)).not.toContain(SYNTHETIC_PASSWORD);
        expect(JSON.stringify(audit)).not.toContain(SYNTHETIC_NOTES);
      },
    );
  });

  it("saves a partial entry with blank account, password, and notes for later completion", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-partial", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
        });
        // A missing site label falls back to the host so the entry lists cleanly.
        expect(entry.siteLabel).toBe("example.com");
        expect(entry.account).toBe("");
        expect(entry.hasNotes).toBe(false);

        const listed = await service.list(false);
        expect(listed).toHaveLength(1);
        expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_PASSWORD);

        const revealed = await service.reveal(entry.itemRef, "reveal");
        expect(revealed.password).toBe("");
        expect(revealed.notes).toBe("");

        // The operator can complete the entry later through the normal edit path.
        const updated = await service.update({
          itemRef: entry.itemRef,
          revision: entry.revision,
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "example.com",
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
        });
        expect(updated.account).toBe("person@example.com");
        expect((await service.reveal(entry.itemRef, "reveal")).password).toBe(SYNTHETIC_PASSWORD);

        // Blank accounts are exempt from the one-account-per-site rule.
        const secondPartial = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
        });
        expect(secondPartial.account).toBe("");
        expect(await service.list(false)).toHaveLength(2);
      },
    );
  });

  it("saves while locked without plaintext and migrates the sealed row at unlock", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-locked", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        await service.lock();
        expect((await service.status()).state).toBe("locked");

        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "login.example.com",
          originPort: 443,
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
          notes: SYNTHETIC_NOTES,
        });
        expect(entry.revision).toBe(1);

        // Metadata is listable while locked, exactly like operator-created rows.
        const listed = await service.list(false);
        expect(listed.map((item) => item.itemRef)).toEqual([entry.itemRef]);
        expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_PASSWORD);
        expect(JSON.stringify(listed)).not.toContain(SYNTHETIC_NOTES);

        // Reading sealed values stays impossible while locked.
        await expect(service.reveal(entry.itemRef, "reveal")).rejects.toSatisfy(
          (error: unknown) => {
            expectVaultError(error, "VAULT_LOCKED");
            return true;
          },
        );
        await expect(
          service.fill(entry.itemRef, entry.revision, {
            scheme: "https",
            host: "login.example.com",
            port: 443,
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_LOCKED");
          return true;
        });

        await service.close();
        service = undefined;
        // Nothing plaintext is ever staged, on disk or in logs.
        expect(scanStateBytes(state.stateDir, SYNTHETIC_PASSWORD)).toEqual([]);
        expect(scanStateBytes(state.stateDir, SYNTHETIC_NOTES)).toEqual([]);

        const database = openStateDatabase(state);
        try {
          const pending = database
            .prepare("SELECT COUNT(*) AS count FROM vault_pending_entry_secrets")
            .get() as { count: number };
          expect(pending.count).toBe(1);
          const secrets = database
            .prepare("SELECT COUNT(*) AS count FROM vault_entry_secrets")
            .get() as { count: number };
          expect(secrets.count).toBe(0);
        } finally {
          database.close();
        }

        // Unlock migrates the sealed row into the passphrase-protected format.
        service = new VaultService({ env: state.env });
        await service.unlock(PASSPHRASE);
        const revealed = await service.reveal(entry.itemRef, "reveal");
        expect(revealed.password).toBe(SYNTHETIC_PASSWORD);
        expect(revealed.notes).toBe(SYNTHETIC_NOTES);

        const migrated = openStateDatabase(state);
        try {
          const pending = migrated
            .prepare("SELECT COUNT(*) AS count FROM vault_pending_entry_secrets")
            .get() as { count: number };
          expect(pending.count).toBe(0);
          const secrets = migrated
            .prepare("SELECT COUNT(*) AS count FROM vault_entry_secrets")
            .get() as { count: number };
          expect(secrets.count).toBe(1);
        } finally {
          migrated.close();
        }
        expect(scanStateBytes(state.stateDir, SYNTHETIC_PASSWORD)).toEqual([]);
        expect(scanStateBytes(state.stateDir, SYNTHETIC_NOTES)).toEqual([]);
      },
    );
  });

  it("reports one unlock needed when a pre-upgrade vault has no write key yet", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-nokey", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        await service.close();
        service = undefined;

        // Simulate a vault written by the previous release: no write key rows.
        const database = openStateDatabase(state);
        database.exec("DELETE FROM vault_write_key_wraps; DELETE FROM vault_write_keys;");
        database.close();

        service = new VaultService({ env: state.env });
        expect((await service.status()).state).toBe("locked");
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            account: "person@example.com",
            password: SYNTHETIC_PASSWORD,
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_WRITE_KEY_UNAVAILABLE");
          return true;
        });

        // The next unlock provisions the write key and locked saves start working.
        await service.unlock(PASSPHRASE);
        await service.lock();
        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
        });
        await service.unlock(PASSPHRASE);
        expect((await service.reveal(entry.itemRef, "reveal")).password).toBe(SYNTHETIC_PASSWORD);
      },
    );
  });

  it("rejects duplicates, invalid origins, and saves before setup", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-errors", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await expect(
          service.saveLogin({ originScheme: "https", originHost: "example.com", originPort: 443 }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_UNINITIALIZED");
          return true;
        });

        await service.initialize(PASSPHRASE, 60);
        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
        });
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            account: "person@example.com",
            password: "other-synthetic-password",
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_DUPLICATE");
          expect((error as VaultError).details).toEqual({ existingItemRef: entry.itemRef });
          return true;
        });
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com/login",
            originPort: 443,
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_INVALID_INPUT");
          return true;
        });
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            account: "x".repeat(513),
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_INVALID_INPUT");
          return true;
        });

        // The duplicate check also holds while locked, before any sealing work.
        await service.lock();
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            account: "person@example.com",
            password: "other-synthetic-password",
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_DUPLICATE");
          return true;
        });
      },
    );
  });

  it("audits a locked duplicate attempt without sealing anything", async () => {
    await withOpenClawTestState(
      { label: "vault-agent-dup-audit", scenario: "minimal" },
      async (state) => {
        service = new VaultService({ env: state.env });
        await service.initialize(PASSPHRASE, 60);
        const entry = await service.saveLogin({
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          account: "person@example.com",
          password: SYNTHETIC_PASSWORD,
        });
        await service.lock();
        await expect(
          service.saveLogin({
            originScheme: "https",
            originHost: "example.com",
            originPort: 443,
            account: "person@example.com",
            password: "other-synthetic-password",
          }),
        ).rejects.toSatisfy((error: unknown) => {
          expectVaultError(error, "VAULT_DUPLICATE");
          return true;
        });
        const database = openStateDatabase(state);
        try {
          const entries = database.prepare("SELECT COUNT(*) AS count FROM vault_entries").get() as {
            count: number;
          };
          expect(entries.count).toBe(1);
          const pending = database
            .prepare("SELECT COUNT(*) AS count FROM vault_pending_entry_secrets")
            .get() as { count: number };
          expect(pending.count).toBe(0);
        } finally {
          database.close();
        }
        expect(entry.itemRef).toMatch(/^vault_/u);
      },
    );
  });
});
