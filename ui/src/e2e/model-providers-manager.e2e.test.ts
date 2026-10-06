// Control UI E2E proves the unified provider manager walkthrough: add provider →
// template library (custom first) → prefilled draft → pull models → edit → save.
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI provider manager",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("provider-manager");
  }
});

const templatesResponse = {
  templates: [
    {
      id: "ollama",
      name: "Ollama",
      requiresApiKey: false,
      defaults: {
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        discovery: { endpointPath: "api/tags" },
        models: [],
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      requiresApiKey: true,
      defaults: {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        models: [],
      },
    },
  ],
};

const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
const schema = buildConfigSchemaCore();

const discoveredModels = Array.from({ length: 24 }, (_, index) => ({
  id: `discovered-${index + 1}`,
  name: `Discovered ${index + 1}`,
  metadataSource: "provider-discovery",
}));

const baseConfig = {
  agents: {
    defaults: { model: "openai/gpt-5.5" },
    entries: { main: {} },
  },
};

function savedConfigAck() {
  const config = structuredClone(baseConfig) as Record<string, unknown>;
  return {
    config,
    hash: "manager-e2e-2",
    appliedConfigHash: "manager-e2e-2",
    configRevisionHash: "manager-e2e-2",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function baseScenario(extraResponses: Record<string, unknown> = {}) {
  return {
    methodResponses: {
      "config.schema": schema,
      "config.get": {
        hash: "manager-e2e",
        config: baseConfig,
        issues: [],
        raw: JSON.stringify(baseConfig),
        valid: true,
      },
      "models.providerTemplates": templatesResponse,
      "models.discover": { models: discoveredModels },
      "models.authSetApiKey": { ok: true },
      ...extraResponses,
    },
  };
}

suite.define(() => {
  it("walks add provider → custom-first templates → prefill → pull → edit → save", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, baseScenario());
      const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);

      // Template library opens with Custom provider fixed in first position.
      await page.locator("[data-models-connect]").first().click();
      const manager = page.locator("openclaw-provider-manager .provider-manager");
      await manager.locator(".provider-manager__template input[value=custom]").first().waitFor();
      await expect
        .poll(() =>
          manager
            .locator(".provider-manager__template input[type=radio]")
            .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        )
        .toEqual(["custom", "ollama", "openai"]);
      if (captureUiProof) {
        await page.locator("openclaw-provider-manager .provider-manager").screenshot({
          path: `${proofDir}/01-template-library-custom-first.png`,
          animations: "disabled",
        });
      }

      // Template search narrows the library while custom stays reachable.
      await manager.locator("input[name=templateSearch]").fill("oll");
      await expect.poll(() => manager.locator(".provider-manager__template").count()).toBe(2);

      // Select the OpenAI template and confirm to prefill the draft.
      await manager.locator("input[name=templateSearch]").fill("openai");
      await manager.locator(".provider-manager__template input[value=openai]").check();
      await manager.getByRole("button", { name: /^confirm$/iu }).click();
      await expect
        .poll(() => manager.getByLabel(/base url/iu).inputValue())
        .toBe("https://api.openai.com/v1");
      if (captureUiProof) {
        await page.locator("openclaw-provider-manager .provider-manager").screenshot({
          path: `${proofDir}/02-prefilled-openai-draft.png`,
          animations: "disabled",
        });
      }

      // Provide the API key, then pull models with the current draft values.
      await manager.locator("input[name=apiKey]").fill("e2e-manager-key");
      await manager.getByRole("button", { name: /fetch models|refresh models/iu }).click();
      await expect
        .poll(() => manager.locator(".provider-manager__model").count())
        .toBe(discoveredModels.length);
      expect(await manager.locator(".provider-manager__badge").first().textContent()).toContain(
        "Discovered",
      );
      const discoverRequests = await gateway.getRequests("models.discover");
      expect(discoverRequests).toHaveLength(1);
      expect(discoverRequests[0]?.params).toMatchObject({
        config: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          apiKey: "e2e-manager-key",
        },
      });

      // Manual and discovered rows are equal: rename one, add a manual row, delete one.
      await manager
        .locator(".provider-manager__model")
        .first()
        .getByRole("button", { name: /edit/iu })
        .click();
      const editor = manager.locator("[data-model-editor]");
      await editor.getByLabel("Name", { exact: true }).fill("Renamed model");
      await manager.getByRole("button", { name: /^apply to draft$/iu }).click();

      await manager.getByRole("button", { name: /add model/iu }).click();
      await manager
        .locator("[data-model-editor]")
        .getByLabel("Id", { exact: true })
        .fill("manual-model");
      await manager
        .locator("[data-model-editor]")
        .getByLabel("Name", { exact: true })
        .fill("Manual model");
      await manager.getByRole("button", { name: /^apply to draft$/iu }).click();

      await manager
        .locator(".provider-manager__model")
        .nth(2)
        .getByRole("button", { name: /^delete$/iu })
        .click();
      await expect
        .poll(() => manager.locator(".provider-manager__model").count())
        .toBe(discoveredModels.length);
      if (captureUiProof) {
        await page.locator("openclaw-provider-manager .provider-manager").screenshot({
          path: `${proofDir}/03-edited-dense-models.png`,
          animations: "disabled",
        });
      }

      // Saving writes the full provider row with its merged model list.
      await gateway.deferNext("config.set");
      await gateway.deferNext("config.patch");
      await manager.getByRole("button", { name: /^save$/iu }).click();
      const saved =
        (await gateway.waitForRequest("config.set").catch(() => null)) ??
        (await gateway.waitForRequest("config.patch"));
      const ack = savedConfigAck();
      await gateway.resolveDeferred("config.set", ack).catch(() => undefined);
      await gateway.resolveDeferred("config.patch", ack).catch(() => undefined);
      const serialized = JSON.stringify(saved?.params ?? {});
      expect(serialized).toContain("manual-model");
      expect(serialized).toContain("Renamed model");
      // The API key saves through its own credential channel, never the config patch.
      expect(serialized).not.toContain("e2e-manager-key");
      await expect
        .poll(async () => (await gateway.getRequests("models.authSetApiKey")).length)
        .toBe(1);
      const keyWrites = await gateway.getRequests("models.authSetApiKey");
      expect(keyWrites[0]?.params).toMatchObject({ apiKey: "e2e-manager-key" });
      await expect
        .poll(() => page.locator("openclaw-provider-manager .provider-manager").count())
        .toBe(0);
      if (captureUiProof) {
        await page.screenshot({
          path: `${proofDir}/04-saved-provider-list.png`,
          animations: "disabled",
        });
      }
    });
  });

  it("covers loading, empty, error, and dense states on desktop and narrow viewports", async () => {
    const viewports = [
      { name: "desktop", width: 1280, height: 900 },
      { name: "narrow", width: 390, height: 844 },
    ] as const;
    for (const viewport of viewports) {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          // Loading: the template library is held while its RPC is pending.
          const loadingGateway = await installMockGateway(page, {
            ...baseScenario(),
            heldMethods: ["models.providerTemplates"],
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          await page.locator("[data-models-connect]").click();
          const loadingManager = page.locator("openclaw-provider-manager");
          await loadingManager.locator(".provider-manager__template input[value=custom]").waitFor();
          if (captureUiProof) {
            await page.locator("openclaw-provider-manager .provider-manager").screenshot({
              path: `${proofDir}/10-${viewport.name}-loading-templates.png`,
              animations: "disabled",
            });
          }
          await loadingGateway.waitForRequest("models.providerTemplates");
          await loadingGateway.resolveDeferred("models.providerTemplates", templatesResponse);

          // Empty, error, and dense states flow through one manager session.
          const gateway = await installMockGateway(
            page,
            baseScenario({
              "models.discover": {
                __mockError: {
                  code: "UNAVAILABLE",
                  message: "The endpoint returned no usable models.",
                  retryable: true,
                },
              },
            }),
          );
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          await page.locator("[data-models-connect]").first().click();
          const manager = page.locator("openclaw-provider-manager .provider-manager");
          await manager
            .locator(".provider-manager__template input[value=custom]")
            .first()
            .waitFor();

          // Empty: the custom template starts with no models.
          await manager.locator(".provider-manager__template input[value=custom]").check();
          await manager.getByRole("button", { name: /^confirm$/iu }).click();
          await manager
            .getByText(/no models yet|no models/iu)
            .first()
            .waitFor();
          if (captureUiProof) {
            await page.locator("openclaw-provider-manager .provider-manager").screenshot({
              path: `${proofDir}/11-${viewport.name}-empty-models.png`,
              animations: "disabled",
            });
          }

          // Error: discovery failure surfaces the actionable message.
          await manager.getByLabel(/base url/iu).fill("https://fixture.invalid/v1");
          await manager.getByRole("button", { name: /fetch models|refresh models/iu }).click();
          await manager
            .getByText(/no usable models/iu)
            .first()
            .waitFor();
          if (captureUiProof) {
            await page.locator("openclaw-provider-manager .provider-manager").screenshot({
              path: `${proofDir}/12-${viewport.name}-discovery-error.png`,
              animations: "disabled",
            });
          }

          // Dense: a successful refresh fills the list.
          await gateway.setMethodResponse("models.discover", { models: discoveredModels });
          await manager.getByRole("button", { name: /fetch models|refresh models/iu }).click();
          await expect
            .poll(() => manager.locator(".provider-manager__model").count())
            .toBe(discoveredModels.length);
          if (captureUiProof) {
            await page.locator("openclaw-provider-manager .provider-manager").screenshot({
              path: `${proofDir}/13-${viewport.name}-dense-models.png`,
              animations: "disabled",
            });
          }
        },
      );
    }
  });
});
