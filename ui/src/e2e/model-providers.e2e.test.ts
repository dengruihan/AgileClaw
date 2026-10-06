// Control UI tests cover the Models settings page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  defaultControlUiFeatureMethods,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  pickerValue as modelPickerValue,
  selectPickerValue as selectModelPicker,
} from "../test-helpers/select-picker-e2e.ts";
import {
  requestRaw,
  resolveConfigMutation,
  providerConfig,
  createProviderProofCapture,
} from "./model-providers.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
let readinessArtifactDir: string;
const captureProviderProof = createProviderProofCapture(() => artifactDir);
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir("model-providers");
    readinessArtifactDir = path.join(artifactDir, "models-provider-readiness");
  }
});
const redactedConfigValue = "[redacted]";
const openaiInputValue = ["e2e", "test", "key"].join("-");
const googleInputValue = ["e2e", "google", "key"].join("-");

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Models mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps defaults read-only without an admin warning when config patches are unavailable", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 877 },
    });
    const page = await context.newPage();
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const gateway = await installMockGateway(page, {
      featureMethods: defaultControlUiFeatureMethods.filter((method) => method !== "config.patch"),
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", available: true },
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "read-only-model-providers",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.authStatus": { ts: NOW, providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const defaults = page.locator(".model-providers__defaults");
      await defaults.waitFor();
      const picker = defaults.locator("openclaw-select-picker").first();
      await picker.locator(".picker-select__trigger").click();
      const otherModel = picker.locator('[role="option"][data-value="openai/gpt-4.1"]');
      expect(await otherModel.getAttribute("aria-disabled")).toBe("true");
      await otherModel.click({ force: true });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await expect.poll(() => page.getByText(/operator\.admin access/u).count()).toBe(0);
      if (recordVisuals) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "read-only-without-admin-warning.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("lists configured providers with auth state, quota, billing, and local spend", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1200, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      models: [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", available: true },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google", available: false },
      ],
      methodResponses: {
        "models.authStatus": {
          ts: NOW,
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
            { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
          ],
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:default", type: "oauth", status: "expired" }],
              usage: {
                providerId: "anthropic",
                plan: "Max 20x",
                windows: [{ label: "5h", usedPercent: 38, resetAt: NOW + 2 * 3_600_000 }],
              },
            },
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              status: "static",
              profiles: [{ profileId: "openrouter:default", type: "api_key", status: "static" }],
            },
          ],
        },
        "usage.status": {
          updatedAt: NOW,
          providers: [
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              windows: [],
              billing: [{ type: "balance", amount: 12.34, unit: "USD" }],
            },
          ],
        },
        "sessions.usage": {
          updatedAt: NOW,
          sessions: [],
          totals: null,
          aggregates: {
            messages: {
              total: 0,
              user: 0,
              assistant: 0,
              toolCalls: 0,
              toolResults: 0,
              errors: 0,
            },
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [
              {
                provider: "anthropic",
                count: 3,
                totals: {
                  input: 100,
                  output: 50,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 1_500_000,
                  totalCost: 4.2,
                  inputCost: 4.2,
                  outputCost: 0,
                  cacheReadCost: 0,
                  cacheWriteCost: 0,
                  missingCostEntries: 0,
                },
              },
            ],
            byAgent: [],
            byChannel: [],
            daily: [],
          },
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      const claudeCard = page.locator(".model-providers__row", { hasText: "Claude" });
      await claudeCard.waitFor();
      // Alias auth row (claude-cli) merges onto the canonical anthropic card.
      await expect
        .poll(async () => claudeCard.locator(".settings-row__desc").first().textContent())
        .toContain("anthropic");
      await expect.poll(async () => claudeCard.textContent()).toContain("Max 20x");
      await expect.poll(async () => claudeCard.textContent()).toContain("Credentials configured");
      const claudeReadiness = claudeCard.locator(".model-providers__head");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Expired");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Expiring");
      await expect.poll(async () => claudeReadiness.textContent()).not.toContain("Not signed in");
      await expect
        .poll(async () => claudeCard.locator(".model-providers__profile").textContent())
        .toContain("Expired");
      await expect.poll(async () => claudeCard.textContent()).toContain("$4.20");
      await claudeCard.locator(".provider-usage-progress").first().waitFor();
      await expect.poll(() => page.getByText("Model auth expired: Claude").count()).toBe(0);

      if (recordVisuals) {
        await captureProviderProof("claude-cli-oauth-alias.png", claudeCard);
      }

      const openrouterCard = page.locator(".model-providers__row", { hasText: "OpenRouter" });
      await openrouterCard.waitFor();
      await openrouterCard.getByRole("button", { name: "Set API key", exact: true }).waitFor();
      expect(await openrouterCard.locator(".model-providers__profile").textContent()).toContain(
        "openrouter:default",
      );
      await expect.poll(async () => openrouterCard.textContent()).toContain("$12.34");

      // openai qualifies via its available catalog model despite having no
      // auth row; the shared label map renders "OpenAI", not "Openai".
      const openaiCard = page.locator(".model-providers__row", { hasText: "OpenAI" });
      await openaiCard.waitFor();
      await expect.poll(async () => openaiCard.textContent()).toContain("1 model");

      // google is in the configured catalog with an unavailable model; the
      // page surfaces it instead of hiding the broken provider.
      const googleCard = page.locator(".model-providers__row", { hasText: "Google" });
      await googleCard.waitFor();
      await expect.poll(async () => googleCard.textContent()).toContain("0 of 1 models available");
      await expect.poll(async () => page.locator(".model-providers__row").count()).toBe(4);
      expect(
        await page
          .locator(".model-providers__provider-list")
          .evaluate((node) => getComputedStyle(node).rowGap),
      ).toBe("18px");
      const providerSection = page
        .locator(".settings-section")
        .filter({ has: page.locator(".model-providers__updated") });
      const headerMetrics = await providerSection.evaluate((section) => {
        const heading = section.querySelector<HTMLElement>(".settings-section__heading");
        const actions = section.querySelector<HTMLElement>(".settings-section__actions");
        const updated = section.querySelector<HTMLElement>(".model-providers__updated");
        const refresh = section.querySelector<HTMLButtonElement>(
          ".model-providers__refresh-button",
        );
        const icon = refresh?.querySelector<SVGElement>("svg");
        if (!heading || !actions || !updated || !refresh || !icon) {
          throw new Error("expected configured-provider header controls");
        }
        const updatedBounds = updated.getBoundingClientRect();
        const refreshBounds = refresh.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        return {
          centerOffset: Math.abs(
            updatedBounds.top +
              updatedBounds.height / 2 -
              (refreshBounds.top + refreshBounds.height / 2),
          ),
          iconWidth: iconBounds.width,
          textSize: Number.parseFloat(getComputedStyle(updated).fontSize),
          refreshHeight: refresh.getBoundingClientRect().height,
        };
      });
      expect(headerMetrics.centerOffset).toBeLessThanOrEqual(1);
      expect(headerMetrics.iconWidth).toBeCloseTo(headerMetrics.textSize, 1);
      expect(headerMetrics.refreshHeight).toBe(28);

      await page.setViewportSize({ width: 390, height: 844 });
      const mobileMetrics = await providerSection.evaluate((section) => {
        const header = section.querySelector<HTMLElement>(".settings-section__header");
        const actions = section.querySelector<HTMLElement>(".settings-section__actions");
        if (!header || !actions) {
          throw new Error("expected configured-provider mobile header controls");
        }
        return {
          actionsAlignSelf: getComputedStyle(actions).alignSelf,
          flexDirection: getComputedStyle(header).flexDirection,
          overflowsViewport: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(mobileMetrics).toEqual({
        actionsAlignSelf: "flex-end",
        flexDirection: "column",
        overflowsViewport: false,
      });
    } finally {
      await context.close();
    }
  });

  it("renders one complete uppercased grapheme in custom provider fallback icons", async () => {
    const bottomProviderId = "e\u0301-proxy";
    const cases = [
      { id: "ß-provider", expected: "S" },
      { id: "🧭-proxy", expected: "🧭" },
      { id: "🇺🇸-proxy", expected: "🇺🇸" },
      { id: "👩‍💻-proxy", expected: "👩‍💻" },
      { id: bottomProviderId, expected: "E\u0301" },
    ];
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      models: cases.map(({ id }) => ({
        id: "test-model",
        name: "Test Model",
        provider: id,
        available: true,
      })),
      methodResponses: {
        "models.authStatus": { ts: NOW, providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      for (const { id, expected } of cases) {
        const icon = page.locator(`[data-provider-id="${id}"] .provider-brand-icon--fallback`);
        await icon.waitFor();
        await expect.poll(async () => (await icon.textContent())?.trim()).toBe(expected);
      }

      if (recordVisuals) {
        const firstIcon = page
          .locator(".model-providers__row .provider-brand-icon--fallback")
          .first();
        await firstIcon.scrollIntoViewIfNeeded();
        await captureProviderProof("03-unicode-fallback-icons.png", firstIcon);
        await page.locator(`[data-provider-id="${bottomProviderId}"]`).scrollIntoViewIfNeeded();
        await captureProviderProof(
          "04-unicode-fallback-icons-bottom.png",
          page.locator(`[data-provider-id="${bottomProviderId}"]`),
        );
      }
    } finally {
      await context.close();
    }
  });

  it("autosaves utility choices without a primary model and retains them after reload", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    let config: unknown = { agents: { defaults: {} } };
    let hash = "utility-defaults";
    const snapshot = () => ({
      config,
      sourceConfig: config,
      hash,
      raw: JSON.stringify(config),
      valid: true,
      issues: [],
    });
    const gateway = await installMockGateway(page, {
      models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai", available: true }],
      methodResponses: {
        "config.get": snapshot(),
        "models.authStatus": { ts: NOW, providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });
    const observations: unknown[] = [];
    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const defaults = page.locator(".model-providers__defaults");
      const utility = page.locator("openclaw-select-picker:has(#model-providers-utility-model)");
      await expect.poll(() => modelPickerValue(utility)).toBe("__openclaw_automatic_utility__");
      if (recordVisuals) {
        await captureProviderProof("utility-before.png", utility);
      }
      for (const choice of [
        { label: "GPT-5 Mini", value: "openai/gpt-5-mini", setting: "openai/gpt-5-mini" },
        { label: "Disabled", value: "", setting: "" },
        { label: "Auto", value: "__openclaw_automatic_utility__", setting: null },
      ]) {
        const before = (await gateway.getRequests("config.patch")).length;
        await gateway.deferNext("config.patch");
        await selectModelPicker(utility, choice.value);
        const request = await gateway.waitForRequest("config.patch", { after: before });
        const patch = requestRaw(request);
        // The fixture commits the actual wire patch, not the expected selection.
        const next = applyMergePatch(config, patch);
        const noop = JSON.stringify(next) === JSON.stringify(config);
        hash = noop ? hash : `${hash}-updated`;
        config = next;
        await gateway.setMethodResponse("config.get", snapshot());
        await gateway.resolveDeferred("config.patch", { ok: true, config, hash, noop });
        await expect.poll(() => utility.locator("button").first().isEnabled()).toBe(true);
        expect(await modelPickerValue(utility)).toBe(choice.value);
        expect(await defaults.locator(".callout.success").count()).toBe(0);
        observations.push({ choice, request, config, selected: await modelPickerValue(utility) });
        if (recordVisuals) {
          await captureProviderProof(`utility-${choice.label}-saved.png`, utility);
        }
        expect(patch).toEqual({
          agents: {
            defaults: {
              utilityModel: choice.setting,
              thinkingDefault: null,
              fastModeDefault: null,
            },
          },
        });
        await expect.poll(() => modelPickerValue(utility)).toBe(choice.value);
        await page.reload();
        await expect.poll(() => modelPickerValue(utility)).toBe(choice.value);
        await expect
          .poll(() => modelPickerValue(defaults.locator("openclaw-select-picker").first()))
          .toBe("");
        if (recordVisuals) {
          await captureProviderProof(`utility-${choice.label}-reloaded.png`, utility);
        }
      }
    } finally {
      try {
        if (recordVisuals) {
          await writeFile(
            path.join(artifactDir, "utility-observations.json"),
            JSON.stringify(observations, null, 2),
          );
          await captureProviderProof(
            "utility-final.png",
            page.locator("openclaw-select-picker:has(#model-providers-utility-model)"),
          );
        }
      } finally {
        await context.close();
      }
    }
  });

  it("reloads the selected agent and clears a failed model draft after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const initialConfig = {
      agents: { defaults: { model: "openai/initial-model" } },
    };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "main",
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      methodResponses: {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": {
          config: initialConfig,
          sourceConfig: initialConfig,
          hash: "model-providers-reconnect-1",
          issues: [],
          raw: JSON.stringify(initialConfig),
          valid: true,
        },
        "models.list": {
          models: [
            { id: "initial-model", name: "Initial Model", provider: "openai", available: true },
            { id: "saved-model", name: "Saved Model", provider: "openai", available: true },
            { id: "failed-draft", name: "Failed Draft", provider: "openai", available: true },
          ],
        },
        "models.authStatus": {
          ts: NOW,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai:writer", type: "oauth", status: "ok" }],
            },
          ],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/initial-model");

      const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
      const savedConfig = {
        agents: { defaults: { model: "openai/saved-model" } },
      };
      const savedPatchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await selectModelPicker(primary, "openai/saved-model");
      await gateway.waitForRequest("config.patch", { after: savedPatchCount });
      await resolveConfigMutation(gateway, savedConfig, "model-providers-reconnect-saved");
      await expect.poll(() => primary.locator("button").first().isEnabled()).toBe(true);
      expect(await modelPickerValue(primary)).toBe("openai/saved-model");
      expect(await page.locator(".model-providers__defaults .callout.success").count()).toBe(0);

      await gateway.deferNext("config.patch");
      const failedPatchCount = (await gateway.getRequests("config.patch")).length;
      await selectModelPicker(primary, "openai/failed-draft");
      await gateway.waitForRequest("config.patch", { after: failedPatchCount });
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "synthetic model save rejected",
      });
      await page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }).waitFor();
      if (recordVisuals) {
        await captureProviderProof(
          "05-reconnect-save-error.png",
          page.getByRole("alert").filter({ hasText: "synthetic model save rejected" }),
        );
      }

      const reconnectedConfig = {
        agents: { defaults: { model: "openai/reconnected-model" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: reconnectedConfig,
        sourceConfig: reconnectedConfig,
        hash: "model-providers-reconnect-2",
        issues: [],
        raw: JSON.stringify(reconnectedConfig),
        valid: true,
      });
      await gateway.setMethodResponse("models.list", {
        models: [
          {
            id: "reconnected-model",
            name: "Reconnected Model",
            provider: "openai",
            available: true,
          },
        ],
      });
      const authRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.closeLatest(1012, "model provider reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThan(authRequestCount);
      await expect
        .poll(() =>
          modelPickerValue(
            page.locator(".model-providers__defaults openclaw-select-picker").first(),
          ),
        )
        .toBe("openai/reconnected-model");
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Writer");
      for (const request of (await gateway.getRequests("models.authStatus")).slice(
        authRequestCount,
      )) {
        expect(request.params).toEqual(expect.objectContaining({ agentId: "writer" }));
      }
      if (recordVisuals) {
        await captureProviderProof("06-reconnected-model.png", primary);
      }
    } finally {
      await context.close();
    }
  });
});
