// Control UI tests cover schema-backed form constraints, draft recovery, and accessible names.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config form integrity mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofVariant = process.env.OPENCLAW_UI_PROOF_VARIANT ?? "after";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = path.join(
      createControlUiE2eArtifactDir("config-form-integrity"),
      proofVariant,
    );
  }
});

function configFormIntegrityMocks() {
  const config = {
    laboratory: {
      endpoint: "local-api",
      metadata: { mode: "safe" },
      retryBudget: 4,
      weights: [2],
      codes: [],
    },
  };
  return {
    "config.get": {
      appliedConfigHash: "config-form-integrity-e2e",
      config,
      configRevisionHash: "config-form-integrity-e2e",
      hash: "config-form-integrity-e2e",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      generatedAt: "2026-07-29T00:00:00.000Z",
      schema: {
        type: "object",
        properties: {
          laboratory: {
            type: "object",
            title: "Form Integrity",
            properties: {
              endpoint: {
                type: "string",
                title: "Endpoint slug",
                description: "Lowercase letters and hyphens only.",
                minLength: 3,
                maxLength: 16,
                pattern: "[a-z-]+",
              },
              retryBudget: {
                type: "integer",
                title: "Retry budget",
                description: "Even values from two through eight.",
                minimum: 2,
                maximum: 8,
                multipleOf: 2,
              },
              weights: {
                type: "array",
                title: "Weights",
                items: { type: "integer", minimum: 2, maximum: 8, multipleOf: 2 },
              },
              codes: {
                type: "array",
                title: "Codes",
                items: {
                  type: "string",
                  minLength: 3,
                  pattern: "^[0-9]+$",
                },
              },
            },
            additionalProperties: true,
          },
        },
      },
      uiHints: {},
      version: "e2e",
    },
  };
}

suite.define(() => {
  it("round-trips Agent List model overrides through the complete Gateway schema", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    const config = (codeMode?: boolean) => ({
      agents: {
        entries: {
          main: {
            name: "Form proof",
            models: {
              "openai/gpt-5.6-sol": {
                alias: "coding",
                params: { temperature: 0.5 },
                agentRuntime: { id: "openclaw" },
                streaming: false,
                ...(codeMode === undefined ? {} : { codeMode }),
              },
            },
            tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
          },
        },
      },
      tools: { codeMode: false },
    });
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const initial = config();
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "agent-list-initial",
              config: initial,
              configRevisionHash: "agent-list-initial",
              hash: "agent-list-initial",
              issues: [],
              raw: JSON.stringify(initial),
              valid: true,
            },
            "config.schema": schema,
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/agents`);
        await page
          .getByRole("button", {
            name: "Agent defaults Defaults every agent inherits unless overridden.",
          })
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
        await page.goto(`${suite.server.baseUrl}settings/ai-agents?section=agents&advanced=1`);

        const reveal = async (control: Locator) => {
          await expect.poll(() => control.count()).toBe(1);
          for (const details of await control.locator("xpath=ancestor::details").all()) {
            if ((await details.getAttribute("open")) === null) {
              await details.locator(":scope > summary").click();
            }
          }
          await expect.poll(() => control.isVisible()).toBe(true);
        };
        const mode = page.locator('select[aria-label="Code Mode"]');
        await reveal(mode);
        expect(
          (await mode.locator("option").allTextContents()).map((label) => label.trim()),
        ).toEqual(["Default", "On", "Off"]);
        expect((await mode.locator("option:checked").textContent())?.trim()).toBe("Default");
        const rawOnly = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title").getByText("Agent Code Mode", { exact: true }),
        });
        expect(await rawOnly.textContent()).toContain("Unsupported schema node. Use Raw mode.");
        expect(await rawOnly.locator("input,select,textarea").count()).toBe(0);

        const agentKey = page.locator('input[aria-label="Key: main"]').first();
        await reveal(agentKey);
        await agentKey.fill("bad/agent");
        await agentKey.blur();
        await expect.poll(() => agentKey.inputValue()).toBe("main");

        for (const [label, value] of [
          ["On", true],
          ["Off", false],
          ["Default", undefined],
        ] as const) {
          const before = (await gateway.getRequests("config.set")).length;
          await gateway.deferNext("config.set");
          await mode.selectOption({ label });
          const request = await gateway.waitForRequest("config.set", { after: before });
          const params = request.params as { raw?: string };
          expect(JSON.parse(String(params.raw))).toEqual(config(value));
          await gateway.resolveDeferred("config.set");
          await expect.poll(() => mode.isEnabled()).toBe(true);
          expect(await gateway.getRequests("config.set")).toHaveLength(before + 1);
          await page.reload();
          await reveal(mode);
          expect((await mode.locator("option:checked").textContent())?.trim()).toBe(label);
        }
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "04-agent-list-model-overrides.png"),
          });
        }
      },
    );
  });

  it("keeps invalid drafts visible and exposes schema constraints to the browser", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, { methodResponses: configFormIntegrityMocks() });

        const response = await page.goto(
          `${suite.server.baseUrl}settings/advanced?section=laboratory`,
        );
        expect(response?.status()).toBe(200);

        const endpoint = page.getByRole("textbox", { name: "Endpoint slug" });
        const retryBudget = page.getByRole("spinbutton", { name: "Retry budget" });
        const weights = page.locator(".cfg-array").filter({ hasText: "Weights" });
        const addWeight = weights.getByRole("button", { name: "Add" });
        await addWeight.click();

        const metadataEditor = page.locator(".cfg-map textarea");
        await metadataEditor.fill('{"mode":');
        await metadataEditor.blur();

        if (captureUiProofEnabled) {
          await page.locator("#config-section-panel").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "01-invalid-json-draft.png"),
          });
        }

        await expect.poll(() => endpoint.getAttribute("minlength")).toBeNull();
        await expect.poll(() => endpoint.getAttribute("maxlength")).toBeNull();
        await expect.poll(() => endpoint.getAttribute("pattern")).toBeNull();
        await expect.poll(() => endpoint.getAttribute("aria-describedby")).not.toBeNull();
        await expect.poll(() => retryBudget.getAttribute("min")).toBe("2");
        await expect.poll(() => retryBudget.getAttribute("max")).toBe("8");
        await expect.poll(() => retryBudget.getAttribute("step")).toBe("2");
        await expect
          .poll(() => page.locator(".cfg-array input[type='number']").last().inputValue())
          .toBe("2");
        await expect.poll(() => metadataEditor.inputValue()).toBe('{"mode":');
        await expect.poll(() => metadataEditor.getAttribute("aria-invalid")).toBe("true");
        await expect.poll(() => page.getByRole("alert").textContent()).toContain("valid JSON");

        const codes = page.locator(".cfg-array").filter({ hasText: "Codes" });
        await codes.getByRole("button", { name: "Add" }).click();
        const codeDraft = codes.locator(".cfg-collection-draft");
        await expect.poll(() => codeDraft.isVisible()).toBe(true);
        const codeValue = codeDraft.getByRole("textbox", { name: "Add: Codes" });
        await codeValue.fill("abc");
        await codeDraft.getByRole("button", { name: "Add" }).click();
        await expect.poll(() => codeValue.getAttribute("aria-invalid")).toBe("true");
        await expect.poll(() => codes.locator("input[aria-label='Codes']").count()).toBe(0);

        if (captureUiProofEnabled) {
          await page.locator("#config-section-panel").screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "02-pattern-collection-draft.png"),
          });
        }

        await codeValue.fill("123");
        await codeDraft.getByRole("button", { name: "Add" }).click();
        await expect
          .poll(() => codes.locator("input[aria-label='Codes']").last().inputValue())
          .toBe("123");
      },
    );
  });

  it("keeps rejected provider model edits recoverable and discards unsaved changes", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const providerId = "custom-lab";
    const models = ["First", "Second", "Third", "Fourth"].map((name, index) => ({
      id: `model-${index + 1}`,
      name,
      input: ["text"],
      metadataSource: "models-add",
    }));
    const initial = {
      models: {
        providers: { [providerId]: { baseUrl: "https://models.example.test/v1", models } },
      },
    };
    const snapshot = (config: typeof initial, hash: string) => ({
      appliedConfigHash: hash,
      config,
      configRevisionHash: hash,
      hash,
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    });
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            "config.get": snapshot(initial, "model-row-e2e"),
            "config.schema": buildConfigSchemaCore(),
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=models`);
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
        await page.locator('[data-provider-category="custom"]').click();
        await page.locator(`[data-provider-models="${providerId}"]`).click();
        const manager = page.locator("openclaw-provider-manager form.provider-manager");
        const fourth = manager.locator('[data-model-id="model-4"]');
        await fourth.getByRole("button", { name: "Edit model", exact: true }).click();
        const name = manager.getByRole("textbox", { name: /^name$/i });
        await expect.poll(() => name.inputValue()).toBe("Fourth");
        await name.fill("Broken");
        await gateway.deferNext("config.patch");
        await manager.getByRole("button", { name: "Save", exact: true }).click();
        const rejected = await gateway.waitForRequest("config.patch");
        const params = rejected.params as {
          baseHash?: string;
          raw?: string;
          replacePaths?: string[];
        };
        expect(JSON.parse(String(params.raw))).toEqual({
          models: {
            providers: {
              [providerId]: {
                models: models.map((row, index) =>
                  index === 3 ? { ...row, name: "Broken" } : row,
                ),
              },
            },
          },
        });
        expect(params.baseHash).toBe("model-row-e2e");
        expect(params.replacePaths).toHaveLength(1);
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "Invalid model name: use another name",
          details: {
            issues: [
              {
                path: `models.providers.${providerId}.models.3.name`,
                message: "Invalid model name",
              },
            ],
          },
        });
        await manager.getByRole("alert").filter({ hasText: "Invalid model name" }).waitFor();
        expect(await name.inputValue()).toBe("Broken");
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "03-model-row-rejection.png"),
          });
          await writeFile(
            path.join(uiProofArtifactDir, "03-model-row-rejection-accessibility.yml"),
            await manager.ariaSnapshot(),
          );
        }
        await manager.getByRole("button", { name: "Back", exact: true }).click();
        await fourth.getByRole("button", { name: "Edit model", exact: true }).click();
        expect(await name.inputValue()).toBe("Fourth");
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        await name.fill("Fourth updated");
        await gateway.deferNext("config.patch");
        await manager.getByRole("button", { name: "Save", exact: true }).click();
        await gateway.waitForRequest("config.patch", { after: 1 });
        const saved = {
          models: {
            providers: {
              [providerId]: {
                ...initial.models.providers[providerId],
                models: models.map((row, index) =>
                  index === 3 ? Object.assign({}, row, { name: "Fourth updated" }) : row,
                ),
              },
            },
          },
        };
        await gateway.setMethodResponse("config.get", snapshot(saved, "model-row-saved"));
        await gateway.resolveDeferred("config.patch", { config: saved, hash: "model-row-saved" });
        await fourth.getByText("Fourth updated", { exact: true }).waitFor();
        await manager.getByRole("button", { name: "Cancel", exact: true }).click();
        await manager.waitFor({ state: "hidden" });
        await page.locator(`[data-provider-models="${providerId}"]`).click();
        await fourth.getByRole("button", { name: "Edit model", exact: true }).click();
        await expect.poll(() => name.inputValue()).toBe("Fourth updated");
        await name.fill("Cancelled change");
        await manager.getByRole("button", { name: "Close", exact: true }).click();
        await manager.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("config.patch")).toHaveLength(2);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        if (captureUiProofEnabled) {
          await page
            .getByRole("heading", { name: "Models", exact: true, level: 1 })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "04-model-page-overview.png"),
          });
        }
      },
    );
  });

  it("retries failed custom provider credentials without recreating its saved connection", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const initial = { models: { providers: {} } };
    const snapshot = (config: Record<string, unknown>, hash: string) => ({
      appliedConfigHash: hash,
      config,
      configRevisionHash: hash,
      hash,
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    });
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            "config.get": snapshot(initial, "custom-provider-initial"),
            "config.schema": buildConfigSchemaCore(),
            "models.authSetApiKey": {},
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const manager = page.locator("openclaw-provider-manager form.provider-manager");
        const openCustom = async () => {
          // The readiness banner and provider section both say "Connect provider";
          // target the section entry that opens the provider picker.
          await page.locator("[data-models-connect]").click();
          await page.locator("[data-models-login-custom]").click();
          await manager.locator('input[name="providerId"]').waitFor();
        };
        await openCustom();
        await manager.locator('input[name="providerId"]').fill("cancelled-provider");
        await manager
          .getByRole("textbox", { name: "Model Provider Base URL", exact: true })
          .fill("https://cancelled.example.test/v1");
        await manager.getByRole("button", { name: "Cancel", exact: true }).click();
        await manager.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);

        await openCustom();
        const providerId = "custom-lab";
        await manager.locator('input[name="providerId"]').fill(providerId);
        const url = manager.getByRole("textbox", { name: "Model Provider Base URL", exact: true });
        await url.fill("https://models.example.test/v1");
        await manager.locator('input[name="apiKey"]').fill("synthetic-provider-key");
        expect(await manager.locator('input[name="apiKey"]').getAttribute("type")).toBe("password");
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, "05-custom-provider-connection.png"),
          });
        }
        await gateway.deferNext("config.patch");
        await gateway.deferNext("models.authSetApiKey");
        await manager.getByRole("button", { name: "Save", exact: true }).click();
        const created = await gateway.waitForRequest("config.patch");
        expect(JSON.parse(String((created.params as { raw?: string }).raw))).toEqual({
          models: {
            providers: {
              [providerId]: {
                baseUrl: "https://models.example.test/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        });
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);
        const saved = {
          models: {
            providers: {
              [providerId]: {
                baseUrl: "https://models.example.test/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        };
        await gateway.setMethodResponse("config.get", snapshot(saved, "custom-provider-created"));
        await gateway.resolveDeferred("config.patch", {
          config: saved,
          hash: "custom-provider-created",
        });
        const credential = await gateway.waitForRequest("models.authSetApiKey");
        expect(credential.params).toMatchObject({
          provider: providerId,
          agentId: "main",
          apiKey: "synthetic-provider-key",
        });
        await gateway.rejectDeferred("models.authSetApiKey", {
          message: "Synthetic credential save failure",
        });
        await expect
          .poll(() => manager.getByRole("alert").textContent())
          .toContain("Connection settings were saved, but the API key was not saved");
        expect(await manager.locator('input[name="apiKey"]').inputValue()).toBe(
          "synthetic-provider-key",
        );
        expect(await manager.locator('input[name="providerId"]').isDisabled()).toBe(true);
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        await gateway.deferNext("models.authSetApiKey");
        await manager.getByRole("button", { name: "Save", exact: true }).click();
        const retriedCredential = await gateway.waitForRequest("models.authSetApiKey", {
          after: 1,
        });
        expect(retriedCredential.params).toMatchObject({
          provider: providerId,
          agentId: "main",
          apiKey: "synthetic-provider-key",
        });
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
        await gateway.resolveDeferred("models.authSetApiKey", {});
        await manager.waitFor({ state: "hidden" });
        await page.locator('[data-provider-category="custom"]').click();
        await page.locator(`[data-provider-settings="${providerId}"]`).click();
        await expect.poll(() => url.inputValue()).toBe("https://models.example.test/v1");
        expect(await manager.locator('input[name="apiKey"]').inputValue()).toBe("");
        await url.fill("https://changed.example.test/v1");
        expect(
          await manager.getByRole("button", { name: "Test connection", exact: true }).isDisabled(),
        ).toBe(true);
        await gateway.deferNext("config.patch");
        await manager.getByRole("button", { name: "Save", exact: true }).click();
        const changed = await gateway.waitForRequest("config.patch", { after: 1 });
        expect(JSON.parse(String((changed.params as { raw?: string }).raw))).toEqual({
          models: { providers: { [providerId]: { baseUrl: "https://changed.example.test/v1" } } },
        });
        const updated = {
          models: {
            providers: {
              [providerId]: {
                ...saved.models.providers[providerId],
                baseUrl: "https://changed.example.test/v1",
              },
            },
          },
        };
        await gateway.setMethodResponse("config.get", snapshot(updated, "custom-provider-updated"));
        await gateway.resolveDeferred("config.patch", {
          config: updated,
          hash: "custom-provider-updated",
        });
        await expect
          .poll(() => manager.getByRole("button", { name: "Save", exact: true }).isDisabled())
          .toBe(true);
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(2);
        await gateway.deferNext("models.probe");
        await manager.getByRole("button", { name: "Test connection", exact: true }).click();
        const probe = await gateway.waitForRequest("models.probe");
        expect(probe.params).toMatchObject({ provider: providerId, agentId: "main" });
        await gateway.resolveDeferred("models.probe", {
          provider: providerId,
          status: "ok",
          results: [],
        });
        await expect
          .poll(() => manager.getByRole("status").allTextContents())
          .toContainEqual(expect.stringMatching(/^Connected\s*$/));
        await manager.getByRole("button", { name: "Cancel", exact: true }).click();
        await manager.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("config.patch")).toHaveLength(2);
        if (captureUiProofEnabled) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "06-custom-provider-card.png"),
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(uiProofArtifactDir, "07-custom-provider-mobile.png"),
          });
        }
      },
    );
  });
});
