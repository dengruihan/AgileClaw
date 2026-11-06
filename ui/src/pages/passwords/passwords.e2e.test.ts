import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { VaultEntryMetadata } from "../../../../packages/gateway-protocol/src/index.js";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "../../e2e/control-ui-e2e-suite.test-support.ts";
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

const DELETED_ENTRY: VaultEntryMetadata = {
  ...ENTRY,
  deletedAtMs: 1_786_352_400_000,
};

const LONG_ENTRY: VaultEntryMetadata = {
  ...SECOND_ENTRY,
  itemRef: "vault_33333333-3333-4333-8333-333333333333",
  siteLabel: "A very long site name that keeps going across the row to test wrapping",
  account: "a-very-long-account-name-with-a-plus-tag@example.test",
  label: "A long label that should not push the actions out of the table",
};

const REVEAL = {
  entry: ENTRY,
  password: "synthetic-revealed-password",
  notes: "synthetic notes",
};

const ZH_CN_CONTEXT = { ...createControlUiE2eContextOptions(), locale: "zh-CN" };

const LOCKED = {
  initialized: true,
  state: "locked",
  autoLockSeconds: 300,
  failedAttempts: 0,
  itemCount: 2,
  deletedCount: 0,
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

  it("renders vault setup, entries, the entry dialog, and audit activity in Simplified Chinese", async () => {
    await suite.withPage(ZH_CN_CONTEXT, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.initialize",
          "vault.list",
          "vault.create",
          "vault.audit.list",
        ],
        operatorScopes: ["operator.vault", "operator.vault.reveal"],
        methodResponses: {
          "vault.status": { sequence: [UNINITIALIZED, UNLOCKED, UNLOCKED] },
          "vault.initialize": { ...UNLOCKED },
          "vault.list": { entries: [ENTRY, SECOND_ENTRY] },
          "vault.create": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "An entry for this site and account already exists.",
              details: { code: "VAULT_DUPLICATE" },
            },
          },
          "vault.audit.list": {
            events: [
              {
                sequence: 1,
                action: "initialize",
                status: "succeeded",
                occurredAtMs: 1_786_352_400_000,
              },
              {
                sequence: 2,
                action: "fill",
                status: "succeeded",
                occurredAtMs: 1_786_352_460_000,
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("heading", { name: "创建密码库" }).waitFor();
      await page.getByText("设置一个主密码短语。").waitFor();
      await page.getByText("确认密码短语", { exact: true }).waitFor();
      await page.getByRole("button", { name: "创建密码库" }).waitFor();
      expect(await page.getByText("Create your password vault").count()).toBe(0);
      await capture(page, "passwords-zh-cn-setup.png");

      await page.locator('input[name="master-passphrase"]').fill("synthetic master passphrase");
      await page.locator('input[name="confirm-passphrase"]').fill("synthetic master passphrase");
      await page.getByRole("button", { name: "创建密码库" }).click();

      const request = await gateway.waitForRequest("vault.initialize");
      expect(request.params).toMatchObject({ autoLockSeconds: 300 });
      await page.getByRole("button", { name: "添加密码" }).waitFor();
      await page.getByPlaceholder("搜索站点、账号或标签").waitFor();
      await page.getByText("显示已删除", { exact: true }).waitFor();
      await page.getByRole("button", { name: "锁定" }).waitFor();
      await page.getByText("2 个有效，0 个已删除").waitFor();
      await page.getByText("闲置 5 分钟后自动锁定").waitFor();
      await page.getByRole("columnheader", { name: "账号" }).waitFor();
      await page.getByRole("columnheader", { name: "最近修改" }).waitFor();
      await page.getByRole("columnheader", { name: "上次使用" }).waitFor();
      await page.getByRole("button", { name: "显示" }).first().waitFor();
      await page.getByRole("button", { name: "编辑" }).first().waitFor();
      await page.getByText("最近的密码库活动").waitFor();
      await page
        .locator(".passwords-vault__audit")
        .getByText("密码库已创建", { exact: true })
        .waitFor();
      await page
        .locator(".passwords-vault__audit")
        .getByText("已填充密码", { exact: true })
        .waitFor();
      expect(await page.getByText("No saved passwords yet.").count()).toBe(0);
      await capture(page, "passwords-zh-cn-unlocked.png");

      await page.getByRole("button", { name: "添加密码" }).click();
      await page.getByRole("heading", { name: "添加密码" }).waitFor();
      await page.getByText("站点名称", { exact: true }).waitFor();
      await page.getByText("标签（可选）", { exact: true }).waitFor();
      await page.getByText("备注", { exact: true }).waitFor();
      await page.getByRole("button", { name: "生成" }).waitFor();
      await page.getByRole("button", { name: "取消" }).waitFor();
      await page.getByRole("button", { name: "保存" }).waitFor();
      await capture(page, "passwords-zh-cn-dialog.png");

      const dialog = page.locator("openclaw-modal-dialog");
      await page.locator('input[name="website"]').fill("https://example.com");
      await page.locator('input[name="site-label"]').fill("Example");
      await page.locator('input[name="account"]').fill("duplicate@example.com");
      await page.locator('input[name="password"]').fill("synthetic-duplicate-password");
      await dialog.getByRole("button", { name: "保存" }).click();
      const formError = dialog.locator(".passwords-vault__error");
      await formError.getByText("该站点和账号下已存在条目。").waitFor();
      expect(
        await formError
          .getByText("An entry for this site and account already exists.", { exact: false })
          .count(),
      ).toBe(0);
    });
  });

  it("reports vault unlock failures and the unlocked vault in Simplified Chinese", async () => {
    await suite.withPage(ZH_CN_CONTEXT, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.unlock", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { sequence: [LOCKED, UNLOCKED, UNLOCKED] },
          "vault.unlock": {
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "Incorrect master passphrase.",
                  details: { code: "VAULT_WRONG_PASSPHRASE" },
                },
              },
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "Too many failed attempts. Try again later.",
                  details: { code: "VAULT_LOCKED_OUT", lockedUntilMs: 1_786_353_000_000 },
                },
              },
              { ...UNLOCKED },
            ],
          },
          "vault.list": { entries: [ENTRY, SECOND_ENTRY] },
          "vault.audit.list": {
            events: [
              {
                sequence: 2,
                action: "unlock",
                status: "succeeded",
                occurredAtMs: 1_786_352_400_000,
              },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("heading", { name: "解锁密码库" }).waitFor();
      await page.getByText("输入主密码短语以查看或复制已保存的密码。").waitFor();
      expect(await page.getByText("Unlock the password vault").count()).toBe(0);

      await page.locator('input[name="master-passphrase"]').fill("synthetic wrong passphrase");
      await page.getByRole("button", { name: "解锁" }).click();
      await page.locator(".passwords-vault__error").getByText("主密码短语不正确。").waitFor();
      expect((await page.locator(".passwords-vault__error").textContent())?.trim()).toBe(
        "主密码短语不正确。",
      );

      await page.locator('input[name="master-passphrase"]').fill("synthetic wrong passphrase");
      await page.getByRole("button", { name: "解锁" }).click();
      await page.locator(".passwords-vault__error").getByText("失败次数过多。请在").waitFor();
      expect(
        await page
          .locator(".passwords-vault__error")
          .getByText("Too many failed attempts", { exact: false })
          .count(),
      ).toBe(0);

      await page.locator('input[name="master-passphrase"]').fill("synthetic master passphrase");
      await page.getByRole("button", { name: "解锁" }).click();
      await page.getByRole("button", { name: "添加密码" }).waitFor();
      await page.getByText("密码库已解锁。", { exact: true }).waitFor();
      await page
        .locator(".passwords-vault__audit")
        .getByText("密码库已解锁", { exact: true })
        .waitFor();
      expect(await page.getByText("Add password").count()).toBe(0);
      await capture(page, "passwords-zh-cn-unlocked-after-unlock.png");
    });
  });

  it("unlocks with the default Control UI scopes and keeps reveal actions hidden", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.list",
          "vault.lock",
          "vault.unlock",
          "vault.audit.list",
        ],
        methodResponses: {
          "vault.status": { sequence: [UNLOCKED, LOCKED, UNLOCKED, UNLOCKED] },
          "vault.lock": { ok: true },
          "vault.unlock": {
            sequence: [
              {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "Incorrect master passphrase.",
                  details: { code: "VAULT_WRONG_PASSPHRASE" },
                },
              },
              { ...UNLOCKED },
            ],
          },
          "vault.list": { entries: [ENTRY] },
          "vault.audit.list": { events: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("row", { name: /person@example.com/u }).waitFor();
      await page.getByRole("button", { name: "Lock", exact: true }).click();
      await gateway.waitForRequest("vault.lock");
      await page.getByRole("heading", { name: "Unlock the password vault" }).waitFor();

      await page.locator('input[name="master-passphrase"]').fill("synthetic wrong passphrase");
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      await page
        .locator(".passwords-vault__error")
        .getByText("Incorrect master passphrase.")
        .waitFor();

      await page.locator('input[name="master-passphrase"]').fill("synthetic master passphrase");
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
      const request = await gateway.waitForRequest("vault.unlock");
      expect(request.params).toEqual({ passphrase: "synthetic master passphrase" });
      await page.getByRole("row", { name: /person@example.com/u }).waitFor();
      expect(await page.locator(".passwords-vault__error").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Show" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: /Copy/u }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Add password" }).count()).toBe(1);
    });
  });

  it("keeps unknown vault diagnostics in Simplified Chinese instead of the generic fallback", async () => {
    await suite.withPage(ZH_CN_CONTEXT, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": {
            __mockError: { code: "UNAVAILABLE", message: "synthetic vault backend offline" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("heading", { name: "解锁密码库" }).waitFor();
      await page
        .locator(".passwords-vault__error")
        .getByText("synthetic vault backend offline")
        .waitFor();
      expect(await page.getByText("密码库请求失败。").count()).toBe(0);
    });
  });

  it("localizes known vault failures raised after unlock in Simplified Chinese", async () => {
    await suite.withPage(ZH_CN_CONTEXT, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 0 },
          "vault.list": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "Unlock the password vault first.",
              details: { code: "VAULT_LOCKED" },
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      const alert = page.locator(".passwords-vault__error");
      await alert.getByText("密码库已锁定。请解锁后继续。").waitFor();
      expect(
        await alert.getByText("Unlock the password vault first.", { exact: false }).count(),
      ).toBe(0);
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

  it("edits an entry without erasing notes unless the user explicitly replaces or clears them", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.update", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [ENTRY] },
          "vault.update": { entry: { ...ENTRY, revision: 2 } },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: /Edit/u })
        .click();
      await page.locator('input[name="site-label"]').fill("Example renamed");
      await page.getByRole("button", { name: "Save" }).click();
      const keep = await gateway.waitForRequest("vault.update");
      expect(keep.params).not.toHaveProperty("notes");
      expect(keep.params).toMatchObject({ siteLabel: "Example renamed" });

      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: /Edit/u })
        .click();
      await page.getByRole("radio", { name: "Clear notes" }).check();
      await page.getByRole("button", { name: "Save" }).click();
      const clear = (await gateway.getRequests("vault.update")).at(-1);
      expect(clear?.params).toMatchObject({ notes: "" });
    });
  });

  it("loads existing notes for an explicit replace when reveal is granted", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.list",
          "vault.update",
          "vault.reveal",
          "vault.audit.list",
        ],
        operatorScopes: ["operator.vault", "operator.vault.reveal"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [ENTRY] },
          "vault.reveal": REVEAL,
          "vault.update": { entry: { ...ENTRY, revision: 2 } },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: /Edit/u })
        .click();
      await page.getByRole("button", { name: "Load current notes" }).click();
      await gateway.waitForRequest("vault.reveal");
      await page.locator('textarea[name="notes"]').waitFor();
      expect(await page.locator('textarea[name="notes"]').inputValue()).toBe("synthetic notes");
      await capture(page, "p13-edit-notes.png");
    });
  });

  it("deletes, restores, and permanently deletes an entry", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "vault.status",
          "vault.list",
          "vault.delete",
          "vault.restore",
          "vault.purge",
          "vault.audit.list",
        ],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": {
            sequence: [
              { entries: [ENTRY] },
              { entries: [] },
              { entries: [DELETED_ENTRY] },
              { entries: [ENTRY] },
              { entries: [DELETED_ENTRY] },
              { entries: [] },
            ],
          },
          "vault.delete": { ok: true },
          "vault.restore": { ok: true },
          "vault.purge": { ok: true },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: /Delete/u })
        .click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect.poll(async () => (await gateway.getRequests("vault.delete")).length).toBe(1);
      await page.getByLabel("Show deleted").check();
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: "Restore" })
        .click();
      await gateway.waitForRequest("vault.restore");
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: /Delete/u })
        .click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect.poll(async () => (await gateway.getRequests("vault.delete")).length).toBe(2);
      await page
        .getByRole("row", { name: /person@example.com/u })
        .getByRole("button", { name: "Delete permanently" })
        .click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Delete permanently", exact: true })
        .click();
      await expect.poll(async () => (await gateway.getRequests("vault.purge")).length).toBe(1);
    });
  });

  it("captures the empty gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 0 },
          "vault.list": { entries: [] },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByText("No saved passwords yet.").waitFor();
      await capture(page, "p06-empty.png");
    });
  });

  it("captures the unavailable gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": {
            __mockError: { code: "UNAVAILABLE", message: "The password vault is unavailable." },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByText("The password vault is unavailable.").waitFor();
      await capture(page, "p07-unavailable.png");
    });
  });

  it("captures the deleted-entry gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 0, deletedCount: 1 },
          "vault.list": {
            sequence: [{ entries: [] }, { entries: [DELETED_ENTRY] }],
          },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByLabel("Show deleted").check();
      await page.getByText("person@example.com", { exact: true }).waitFor();
      await capture(page, "p08-deleted.png");
    });
  });

  it("captures the entry dialog gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [ENTRY] },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByRole("button", { name: "Add password" }).click();
      await page.getByRole("heading", { name: "Add password" }).waitFor();
      await capture(page, "p09-dialog.png");
    });
  });

  it("captures the mobile gallery state", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 2 },
          "vault.list": { entries: [ENTRY, SECOND_ENTRY] },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByText("person@example.com", { exact: true }).waitFor();
      await capture(page, "p10-mobile.png");
    });
  });

  it("captures the long-content gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 1 },
          "vault.list": { entries: [LONG_ENTRY] },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.getByText(LONG_ENTRY.account, { exact: true }).waitFor();
      await capture(page, "p11-long-content.png");
    });
  });

  it("captures the loading gallery state", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["vault.status", "vault.list", "vault.audit.list"],
        operatorScopes: ["operator.vault"],
        deferredMethods: ["vault.list"],
        methodResponses: {
          "vault.status": { ...UNLOCKED, itemCount: 0 },
          "vault.audit.list": { events: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/passwords`);
      await page.locator(".settings-loading-skeleton").waitFor();
      await capture(page, "p12-loading.png");
      await gateway.resolveDeferred("vault.list", { entries: [] });
    });
  });
});
