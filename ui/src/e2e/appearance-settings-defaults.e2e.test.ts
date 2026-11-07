// Control UI tests cover Appearance override provenance and restoring product defaults.
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  type MockGatewayRequest,
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  configResponse,
  patchPrefs,
  resetSyncedPreference,
  waitForRequestCount,
} from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("appearance-settings-defaults");
  }
});
function settingsStorageKey(): string {
  return controlUiBundledSettingsStorageKey(suite.server.baseUrl);
}

function settingsRow(page: Page, title: string): Locator {
  return page
    .locator(".settings-row")
    .filter({ has: page.locator(".settings-row__title", { hasText: title }) })
    .first();
}

async function selectValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) =>
    String((element as HTMLElement & { value?: unknown }).value),
  );
}

async function readPersistedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }, settingsStorageKey());
}

async function captureViewport(page: Page, filename: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, filename),
  });
}

suite.define(() => {
  it("shows task progress auto-collapse off by default and persists the opt-in", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse({}, "appearance-task-progress-1"),
          },
        });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
        );
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const row = settingsRow(page, "Collapse task progress by default on desktop");
        const toggle = row.locator("wa-switch");
        await row.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            toggle.evaluate((element) => Boolean((element as { checked?: boolean }).checked)),
          )
          .toBe(false);
        await expect.poll(() => row.textContent()).not.toContain("Using default:");
        await captureViewport(page, "11-task-progress-collapse-off.png");

        await row.click();
        await expect
          .poll(() =>
            toggle.evaluate((element) => Boolean((element as { checked?: boolean }).checked)),
          )
          .toBe(true);
        await expect
          .poll(() => readPersistedSettings(page))
          .toMatchObject({
            chatCollapseTaskProgress: true,
          });
        await captureViewport(page, "12-task-progress-collapse-on.png");
      },
    );
  });

  it("removes synced and browser-local overrides, then reloads inherited defaults", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    await context.addInitScript(
      ({ gatewayUrl, key }) => {
        const seedKey = "openclaw.control-ui-e2e.appearance-defaults-seeded";
        if (sessionStorage.getItem(seedKey) === "1") {
          return;
        }
        sessionStorage.setItem(seedKey, "1");
        localStorage.setItem(
          key,
          JSON.stringify({
            gatewayUrl,
            textScale: 110,
          }),
        );
      },
      { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), key: settingsStorageKey() },
    );
    const page = await context.newPage();
    const initialPrefs: Record<string, unknown> = {
      locale: "en",
      themeMode: "dark",
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse(initialPrefs, "appearance-defaults-1"),
        "config.patch": { ok: true },
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const languageRow = settingsRow(page, "Language");
      const colorModeRow = page.locator("#settings-appearance-theme .settings-row").first();
      const textSizeSection = page.locator("#settings-appearance-text-size");
      const languageSelect = languageRow.locator("wa-select");
      const colorModeGroup = colorModeRow.locator("wa-radio-group");

      await expect.poll(() => selectValue(languageSelect)).toBe("en");
      await expect.poll(() => selectValue(colorModeGroup)).toBe("dark");
      await expect
        .poll(() =>
          textSizeSection
            .locator(".settings-text-scale__btn", { hasText: "110%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect.poll(() => languageRow.textContent()).toContain("Default: System");
      await expect
        .poll(() =>
          page
            .locator("#settings-appearance-theme")
            .locator(":scope > .settings-section__desc")
            .textContent(),
        )
        .toContain("Default: System");
      await expect.poll(() => textSizeSection.textContent()).toContain("Default: 100%");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "01-explicit-overrides.png");

      const withoutLocale = { ...initialPrefs };
      delete withoutLocale.locale;
      await resetSyncedPreference({
        click: () =>
          languageSelect.evaluate((element) => {
            const select = element as HTMLElement & { value: string };
            select.value = "system";
            select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          }),
        expectedKey: "locale",
        gateway,
        hash: "appearance-defaults-2",
        remainingPrefs: withoutLocale,
      });

      const withoutThemeMode: Record<string, unknown> = { ...withoutLocale };
      delete withoutThemeMode.themeMode;
      await resetSyncedPreference({
        click: () =>
          colorModeRow
            .locator('wa-radio[value="system"]')
            .click()
            .then(() => undefined),
        expectedKey: "themeMode",
        gateway,
        hash: "appearance-defaults-4",
        remainingPrefs: withoutThemeMode,
      });

      await textSizeSection.locator(".settings-text-scale__btn", { hasText: "100%" }).click();
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");

      await expect.poll(() => selectValue(languageSelect)).toBe("system");
      await expect.poll(() => selectValue(colorModeGroup)).toBe("system");
      await expect
        .poll(() =>
          textSizeSection
            .locator(".settings-text-scale__btn", { hasText: "100%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const reloadedLanguageRow = settingsRow(page, "Language");
      const reloadedColorModeRow = settingsRow(page, "Color mode");
      const reloadedTextSizeSection = page.locator("#settings-appearance-text-size");

      await expect.poll(() => selectValue(reloadedLanguageRow.locator("wa-select"))).toBe("system");
      await expect
        .poll(() => selectValue(reloadedColorModeRow.locator("wa-radio-group")))
        .toBe("system");
      await expect
        .poll(() =>
          reloadedTextSizeSection
            .locator(".settings-text-scale__btn", { hasText: "100%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect.poll(() => reloadedLanguageRow.textContent()).not.toContain("Using default:");
      await expect.poll(() => reloadedColorModeRow.textContent()).not.toContain("Using default:");
      await expect
        .poll(() => reloadedTextSizeSection.textContent())
        .not.toContain("Using default:");
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "03-inherited-defaults.png");
    } finally {
      await context.close();
    }
  });

  it("keeps rejected edits browser-local and resets them without another server write", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const initialPrefs = {
          locale: "en",
          themeMode: "dark",
          chatFollowUpMode: "queue",
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialPrefs, "appearance-rejected-1"),
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const languageRow = page.locator("#settings-language .settings-row");
        const languageSelect = languageRow.locator("wa-select");
        const colorModeRow = page.locator("#settings-appearance-theme .settings-row").first();
        const colorModeDescription = page
          .locator("#settings-appearance-theme")
          .locator(":scope > .settings-section__desc");
        const followUpSelect = page.locator("[data-settings-follow-up-mode]");
        const followUpRow = page.locator(".settings-row").filter({ has: followUpSelect });

        await expect.poll(() => selectValue(languageSelect)).toBe("en");
        await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("dark");
        await expect.poll(() => followUpSelect.inputValue()).toBe("queue");

        await gateway.deferNext("config.patch");
        await colorModeRow.locator('wa-radio[value="light"]').click();
        await waitForRequestCount(gateway, "config.patch", 1);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[0] as MockGatewayRequest),
        ).toEqual({ themeMode: "light" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("light");
        await expect.poll(() => colorModeDescription.textContent()).toContain("Default: Dark");
        await expect
          .poll(() => colorModeDescription.textContent())
          .toContain("Stored in this browser only");

        await gateway.deferNext("config.patch");
        await languageSelect.evaluate((element) => {
          const select = element as HTMLElement & { value: string };
          select.value = "fr";
          select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        });
        await waitForRequestCount(gateway, "config.patch", 2);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[1] as MockGatewayRequest),
        ).toEqual({ locale: "fr" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect.poll(() => selectValue(languageSelect)).toBe("fr");
        await expect.poll(() => languageRow.textContent()).toContain("Par défaut : Anglais");
        await expect
          .poll(() => languageRow.textContent())
          .toContain("Stocké uniquement dans ce navigateur");

        await gateway.deferNext("config.patch");
        await followUpSelect.selectOption("steer");
        await waitForRequestCount(gateway, "config.patch", 3);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[2] as MockGatewayRequest),
        ).toEqual({ chatFollowUpMode: "steer" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect.poll(() => followUpSelect.inputValue()).toBe("steer");
        await expect
          .poll(() => followUpRow.textContent())
          .toContain("Stocké uniquement dans ce navigateur");

        await colorModeRow.locator('wa-radio[value="dark"]').click();
        await languageSelect.evaluate((element) => {
          const select = element as HTMLElement & { value: string };
          select.value = "system";
          select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        });
        await followUpRow.locator("button.btn--sm").click();

        await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("dark");
        await expect.poll(() => selectValue(languageSelect)).toBe("en");
        await expect.poll(() => followUpSelect.inputValue()).toBe("queue");
        await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("en");
        await page.waitForTimeout(100);
        expect(await gateway.getRequests("config.patch")).toHaveLength(3);
      },
    );
  });

  it("keeps every read-only preference surface browser-local across reload", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read"],
      methodResponses: {
        "config.get": configResponse({ themeMode: "dark" }, "appearance-read-only-1"),
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const colorModeRow = page.locator("#settings-appearance-theme .settings-row").first();
      const colorModeDescription = page
        .locator("#settings-appearance-theme")
        .locator(":scope > .settings-section__desc");
      await colorModeRow.locator('wa-radio[value="light"]').click();

      await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("light");
      await expect
        .poll(() => colorModeDescription.textContent())
        .toContain("Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ themeMode: "light" });
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("light");
      await expect
        .poll(() => colorModeDescription.textContent())
        .toContain("Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ themeMode: "light" });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await colorModeRow.locator('wa-radio[value="system"]').click();
      await expect.poll(() => selectValue(colorModeRow.locator("wa-radio-group"))).toBe("system");
      await expect.poll(() => colorModeDescription.textContent()).toContain("Default: Dark");
      await expect
        .poll(() => colorModeDescription.textContent())
        .toContain("Stored in this browser only");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const viewMenuTrigger = page.locator(".chat-header-session-menu__trigger");
      await viewMenuTrigger.click();
      const viewMenu = page.locator("wa-dropdown.chat-header-session-menu");
      await expect
        .poll(() => viewMenu.locator('[role="note"]').textContent())
        .toContain("Stored in this browser only");
      const viewItem = viewMenu.getByRole("menuitem", { name: "View", exact: true });
      await viewItem.hover();
      const reasoning = viewMenu.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await expect.poll(() => reasoning.isVisible()).toBe(true);
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("false");

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      const customizeMenu = sidebar.locator("wa-dropdown.sidebar-pin-editor-menu");
      await expect
        .poll(() => customizeMenu.locator(".sidebar-customize-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      const usage = customizeMenu.getByRole("menuitemcheckbox", { name: "Usage" });
      await usage.click();
      await expect.poll(() => usage.getAttribute("aria-checked")).toBe("true");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.reload();
      await viewMenuTrigger.click();
      await expect
        .poll(() => viewMenu.locator('[role="note"]').textContent())
        .toContain("Stored in this browser only");
      await viewItem.hover();
      await expect
        .poll(() =>
          viewMenu
            .getByRole("menuitemcheckbox", { name: "Reasoning" })
            .getAttribute("aria-checked"),
        )
        .toBe("false");

      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      await expect
        .poll(() => customizeMenu.locator(".sidebar-customize-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      await expect
        .poll(() =>
          customizeMenu
            .getByRole("menuitemcheckbox", { name: "Usage" })
            .getAttribute("aria-checked"),
        )
        .toBe("true");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
