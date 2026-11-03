import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { VaultEntryMetadata } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI personal password vault mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string | undefined;
beforeEach(() => {
  if (captureProofEnabled) {
    proofDir = createControlUiE2eArtifactDir(
      "passwords-vault",
      path.join(process.cwd(), ".artifacts", "control-ui-e2e", "passwords-vault"),
    );
  }
});

async function capture(page: import("playwright").Page, fileName: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

const ENTRY: VaultEntryMetadata = {
  itemRef: "vault_11111111-1111-4111-8111-111111111111",
  originScheme: "https",
  originHost: "example.com",
  originPort: 443,
  siteLabel: "Example",
  account: "person@example.com",
  label: "Work",
  hasNotes: true,
  revision: 1,
  passwordUpdatedAtMs: 1_786_352_400_000,
  createdAtMs: 1_786_352_400_000,
  updatedAtMs: 1_786_352_400_000,
};

const SECOND_ENTRY: VaultEntryMetadata = {
  ...ENTRY,
  itemRef: "vault_22222222-2222-4222-8222-222222222222",
  account: "second@example.com",
  label: "Personal",
};

const UNINITIALIZED = {
  initialized: false,
  state: "uninitialized",
  autoLockSeconds: 300,
  failedAttempts: 0,
  itemCount: 0,
  deletedCount: 0,
};

const UNLOCKED = {
  initialized: true,
  state: "unlocked",
  autoLockSeconds: 300,
  failedAttempts: 0,
  itemCount: 2,
  deletedCount: 0,
};

const REVEAL = {
  entry: ENTRY,
  password: "synthetic-revealed-password",
  notes: "synthetic notes",
};

suite.define(() => {
  it("creates the vault from Settings → Passwords and renders encrypted entries", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.initialize", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault", "operator.vault.reveal"],
        methodResponses: {
          "vault.status": { sequence: [UNINITIALIZED, UNLOCKED, UNLOCKED] },
          "vault.initialize": { ...UNLOCKED },
          "vault.list": { entries: [ENTRY, SECOND_ENTRY] },
          "vault.audit.list": {
            events: [
              {
                sequence: 1,
                action: "initialize",
                status: "succeeded",
                occurredAtMs: 1_786_352_400_000,
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("heading", { name: "Create your password vault" }).waitFor();
      await capture(page, "passwords-setup.png");
      await page.locator('input[name="master-passphrase"]').fill("synthetic master passphrase");
      await page.locator('input[name="confirm-passphrase"]').fill("synthetic master passphrase");
      await page.getByRole("button", { name: "Create password vault" }).click();

      const request = await gateway.waitForRequest("vault.initialize");
      expect(request.params).toMatchObject({
        passphrase: "synthetic master passphrase",
        autoLockSeconds: 300,
      });
      await page.getByText("Example", { exact: true }).waitFor();
      await capture(page, "passwords-unlocked.png");
      expect(await page.getByText("person@example.com", { exact: true }).count()).toBe(1);
      expect(await page.getByText("second@example.com", { exact: true }).count()).toBe(1);
      expect(await page.getByText("synthetic-revealed-password").count()).toBe(0);
    });
  });

  it("reveals and copies one entry only with the explicit reveal scope", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.list",
          "vault.reveal",
          "vault.copy",
          "vault.audit.list",
        ],
        operatorScopes: ["operator.admin", "operator.vault", "operator.vault.reveal"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [ENTRY] },
          "vault.reveal": REVEAL,
          "vault.copy": REVEAL,
          "vault.audit.list": { events: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      const row = page.getByRole("row", { name: /person@example.com/u });
      await row.waitFor();
      expect(await row.getByText("synthetic-revealed-password").count()).toBe(0);
      await row.getByRole("button", { name: "Show" }).click();
      await gateway.waitForRequest("vault.reveal");
      await row.getByText("synthetic-revealed-password").waitFor();
      await capture(page, "passwords-revealed.png");
      await row.getByRole("button", { name: /Copy/u }).click();
      await gateway.waitForRequest("vault.copy");
    });
  });

  it("does not expose reveal actions to an admin without the reveal scope", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.admin", "operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [ENTRY] },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByText("person@example.com", { exact: true }).waitFor();
      await capture(page, "passwords-admin-no-reveal.png");
      expect(await page.getByRole("button", { name: "Show" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: /Copy/u }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Add password" }).count()).toBe(1);
    });
  });

  it("submits a new password entry without echoing the password", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.list",
          "vault.create",
          "vault.generate",
          "vault.audit.list",
        ],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 0 },
          "vault.list": { entries: [] },
          "vault.create": { entry: ENTRY },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("button", { name: "Add password" }).click();
      await page.locator('input[name="website"]').fill("https://example.com");
      await page.locator('input[name="site-label"]').fill("Example");
      await page.locator('input[name="account"]').fill("person@example.com");
      await page.locator('input[name="password"]').fill("synthetic-created-password");
      await page.locator('textarea[name="notes"]').fill("synthetic note");
      await page.getByRole("button", { name: "Save" }).click();

      const request = await gateway.waitForRequest("vault.create");
      expect(request.params).toMatchObject({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "person@example.com",
        password: "synthetic-created-password",
        notes: "synthetic note",
      });
      expect(await page.getByText("synthetic-created-password").count()).toBe(0);
    });
  });

  it("points the Secrets page at the separate password vault", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["secrets.store.list"],
        methodResponses: { "secrets.store.list": { entries: [] } },
      });
      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      const link = page.getByRole("link", { name: "Open Passwords" });
      await link.waitFor();
      await capture(page, "secrets-callout.png");
      expect(await link.getAttribute("href")).toBe("/settings/passwords");
    });
  });
});
