// Control UI E2E covers catalog recovery and retirement of agent-scoped credential drafts.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model Provider operator outcomes mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const now = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
function providerResponses() {
  return {
    "config.get": { config: {}, hash: "provider-usage-outcome" },
    "models.list": { models: [] },
    "models.authStatus": {
      ts: now,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [],
        },
      ],
    },
  };
}

suite.define(() => {
  it("keeps configured models visible when their catalog fails, then recovers on refresh", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          models: { providers: { openai: { apiKey: "[redacted]" } } },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...providerResponses(),
            "config.get": {
              config,
              sourceConfig: config,
              hash: "model-providers-catalog-failure",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "models.list": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Model catalog temporarily unavailable",
              },
            },
            "models.authStatus": {
              ts: now,
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "static",
                  profiles: [],
                  apiKey: { source: "config" },
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const card = page.locator('[data-provider-id="openai"]');
        await card.waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("models.list")).length)
          .toBeGreaterThan(0);
        const catalogWarning = page.locator('.model-providers__catalog-progress[role="alert"]');

        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          const phase = (await catalogWarning.count()) === 0 ? "before" : "after";
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              `model-catalog-request-failure-${phase}.png`,
            ),
          });
        }

        await expect
          .poll(() => catalogWarning.textContent(), { timeout: 5_000 })
          .toContain("More models could not be discovered.");
        await catalogWarning.getByRole("button", { name: "Retry", exact: true }).waitFor();
        expect(await page.locator(".provider-usage-error").count()).toBe(0);
        expect(await page.locator('[data-model-readiness="model-required"]').count()).toBe(0);
        const primary = page.locator(".model-providers__defaults openclaw-select-picker").first();
        await expect.poll(() => pickerValue(primary)).toBe("openai/gpt-5.5");

        await gateway.setMethodResponse("models.list", {
          models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
        });
        await page.getByRole("button", { name: "Refresh", exact: true }).click();

        await expect.poll(() => catalogWarning.count()).toBe(0);
        await expect.poll(() => page.locator(".provider-usage-error").count()).toBe(0);
        await expect.poll(() => pickerValue(primary)).toBe("openai/gpt-5.5");
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "model-catalog-request-recovered.png",
            ),
          });
        }
      },
    );
  });

  it("clears unsaved provider credentials when switching agents without saving them", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_280 },
      },
      async ({ page }) => {
        const config = {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          models: { providers: { openai: { apiKey: "[redacted]" } } },
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
          methodResponses: {
            ...providerResponses(),
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
              config,
              sourceConfig: config,
              hash: "model-providers-agent-credentials",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "config.patch": { ok: true },
            "models.list": {
              models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
            },
            "models.authStatus": {
              ts: now,
              providerCapabilities: [
                { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
                { provider: "google", apiKeySupported: true, quickApiKeySetup: true },
              ],
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "static",
                  profiles: [],
                  apiKey: { source: "config" },
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator('[data-provider-select="openai"]').click();
        const editor = page.locator("openclaw-provider-manager");
        const keyInput = editor.locator('input[name="apiKey"]');
        await expect.poll(() => keyInput.isEnabled()).toBe(true);
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "model-providers"), { recursive: true });
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-before.png",
            ),
            fullPage: true,
          });
        }
        await keyInput.fill("synthetic-main-provider-key");

        const agentPicker = page.locator(".settings-sidebar__agent openclaw-agent-select");
        await agentPicker.locator(".agent-select__trigger").click();
        await agentPicker.locator('wa-dropdown-item[aria-label="Writer"]').click();
        await expect
          .poll(() => editor.locator(".provider-manager__connection").textContent())
          .toContain("writer");
        await expect.poll(() => keyInput.inputValue()).toBe("");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-inline-cleared.png",
            ),
            fullPage: true,
          });
        }

        await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
        await expect
          .poll(() => editor.locator(".provider-manager__connection").textContent())
          .toContain("main");
        await page.locator('[data-models-login-provider="google"]').click();
        await page.locator("[data-models-login-api-key]").click();
        const addSection = page.locator("[data-models-key-dialog]");
        await addSection.getByLabel("API key").fill("synthetic-main-provider-key");
        // The modal makes the picker inert. Use its selection owner without
        // closing the dialog so this still proves open-draft scope retirement.
        await page.locator("openclaw-app").evaluate((element) => {
          // SAFETY: This selector is the initialized app root that owns the runtime.
          const app = element as HTMLElement & { runtime: ApplicationRuntime };
          app.runtime.context.settingsAgentSelection.set("writer");
        });
        await expect
          .poll(() => editor.locator(".provider-manager__connection").textContent())
          .toContain("writer");
        await expect.poll(async () => page.locator("[data-models-key-dialog]").count()).toBe(0);
        await expect.poll(() => keyInput.inputValue()).toBe("");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "model-providers"),
              "provider-credential-scope-after.png",
            ),
            fullPage: true,
          });
        }
      },
    );
  });
});
