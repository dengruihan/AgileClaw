// Control UI provider-brand icon tests cover the Models settings page against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  requestRaw,
  selectProviderEditor,
  resolveConfigMutation,
  createProviderProofCapture,
} from "./model-providers.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string;
const captureProviderProof = createProviderProofCapture(() => artifactDir);
beforeEach(() => {
  if (recordVisuals) {
    artifactDir = createControlUiE2eArtifactDir("model-provider-icons");
  }
});

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI model provider icons mocked Gateway E2E", () => {
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

  it("uses a saved custom model id for matching sidebar and editor brand icons", async () => {
    const providerId = "custom-zai";
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    let config: unknown = {
      models: {
        providers: {
          [providerId]: { baseUrl: "https://example.test/v1", models: [] },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      models: [],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          hash: "custom-model-brand",
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
      const editor = await selectProviderEditor(page, providerId);
      await editor.getByRole("button", { name: "Add model", exact: true }).click();
      const modelForm = editor.locator(".provider-manager--model");
      await modelForm.locator('input[name="id"]').fill("glm-4.6");
      await modelForm.locator('input[name="name"]').fill("GLM 4.6");
      const patchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await modelForm.getByRole("button", { name: "Save", exact: true }).click();
      const patch = await gateway.waitForRequest("config.patch", { after: patchCount });
      config = applyMergePatch(config, requestRaw(patch));
      await resolveConfigMutation(
        gateway,
        config as Record<string, unknown>,
        "custom-model-brand-saved",
      );
      await gateway.emitGatewayEvent("config.changed", {});
      await expect.poll(() => modelForm.count()).toBe(0);

      const sidebarIcon = page.locator(`[data-provider-id="${providerId}"] .provider-brand-icon`);
      const editorIcon = editor.locator(".provider-manager__identity .provider-brand-icon");
      await sidebarIcon.waitFor();
      await editorIcon.waitFor();
      if (recordVisuals) {
        await captureProviderProof(
          "custom-model-brand.png",
          page.locator(".model-providers__workspace"),
        );
      }
      await expect.poll(() => sidebarIcon.getAttribute("data-provider-icon")).toBe("zai");
      await expect.poll(() => editorIcon.getAttribute("data-provider-icon")).toBe("zai");
      const iconResource = await editorIcon.evaluate((node) => {
        const value = getComputedStyle(node).getPropertyValue("--provider-icon-url");
        return value.match(/url\(["']?([^"')]+)/)?.[1] ?? null;
      });
      const iconUrl = new URL(iconResource!, server.baseUrl);
      expect(iconUrl.pathname).toBe("/provider-icons/ProviderIcon-zai.svg");
      const iconResponse = await page.request.get(iconUrl.toString());
      expect(iconResponse.ok()).toBe(true);
      expect(iconResponse.headers()["content-type"]).toContain("image/svg+xml");
      for (const icon of [sidebarIcon, editorIcon]) {
        const bounds = await icon.boundingBox();
        expect(bounds?.width).toBeGreaterThan(0);
        expect(bounds?.height).toBeGreaterThan(0);
      }
    } finally {
      await context.close();
    }
  });
});
