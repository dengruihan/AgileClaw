// Control UI provider-brand icon E2E tests cover the icons stored in provider
// config: the Models settings page and the chat model picker against a mocked
// Gateway. Matching runs when a name is saved; every surface only reads the
// stored `icon`/`iconManual` pair.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createProviderProofCapture,
  requestRaw,
  resolveConfigMutation,
  selectProviderEditor,
} from "./model-providers.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const NOW = Date.now();
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
let artifactDir: string | undefined;
/**
 * One directory per recorded run keeps every stage's screenshots and video
 * together, and scenarios that capture nothing do not leave an empty directory
 * behind to be mistaken for the run's result.
 */
function proofArtifactDir(): string {
  return (artifactDir ??= createControlUiE2eArtifactDir("model-provider-icons"));
}
const captureProviderProof = createProviderProofCapture(proofArtifactDir);

const iconAssetIds = readdirSync(
  fileURLToPath(new URL("../../public/provider-icons/", import.meta.url)),
)
  .filter((file) => /^ProviderIcon-.+\.svg$/.test(file))
  .map((file) => file.slice("ProviderIcon-".length, -".svg".length))
  .toSorted();

function configSnapshot(config: unknown, hash: string) {
  return {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

type ProvidersConfig = {
  models: { providers: Record<string, Record<string, unknown>> };
};

function configuredProvider(config: ProvidersConfig, id: string): Record<string, unknown> {
  const entry = config.models.providers[id];
  if (!entry) {
    throw new Error(`Expected an authored ${id} provider`);
  }
  return entry;
}

function sidebarMark(page: Page, id: string): Locator {
  return page.locator(`[data-provider-id="${id}"] .provider-brand-icon`).first();
}

function editorMark(editor: Locator): Locator {
  return editor.locator(".provider-icon-picker__trigger .provider-brand-icon").first();
}

function editorIconId(editor: Locator): Locator {
  return editor.locator(".provider-icon-picker__trigger [data-provider-icon]");
}

function editorFallback(editor: Locator): Locator {
  return editor.locator(".provider-icon-picker__trigger .provider-brand-icon--fallback");
}

function iconPicker(editor: Locator): Locator {
  return editor.locator("openclaw-provider-icon-picker");
}

async function openIconPicker(editor: Locator): Promise<Locator> {
  const picker = iconPicker(editor);
  await picker.locator(".provider-icon-picker__trigger").click();
  await expect.poll(() => picker.locator(".provider-icon-picker__search").isVisible()).toBe(true);
  return picker;
}

async function chooseIcon(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  locator: Locator,
): Promise<Record<string, unknown>> {
  const before = (await gateway.getRequests("config.patch")).length;
  await gateway.deferNext("config.patch");
  await locator.click();
  return requestRaw(await gateway.waitForRequest("config.patch", { after: before }));
}

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

  it("renders stored icons on the settings sidebar and editor title", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: proofArtifactDir(), size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const config = {
      models: {
        providers: {
          "auto-glm": {
            baseUrl: "https://glm.example.test/v1",
            displayName: "GLM Team",
            icon: "zai",
            models: [],
          },
          "manual-kimi": {
            baseUrl: "https://kimi.example.test/v1",
            // The name would auto-match OpenAI, so a kimi mark proves the stored
            // manual icon wins over display-time matching.
            displayName: "OpenAI Gateway",
            icon: "kimi",
            iconManual: true,
            models: [],
          },
          anthropic: {
            baseUrl: "https://relay.example.test/v1",
            displayName: "Claude Relay",
            iconManual: true,
            models: [],
          },
          "plain-relay": {
            baseUrl: "https://plain.example.test/v1",
            displayName: "Acme Gateway",
            models: [],
          },
          "cjk-relay": {
            baseUrl: "https://cjk.example.test/v1",
            // The badge takes its first letter from the saved name; the manual
            // flag keeps the name's Alibaba match from restoring an icon.
            displayName: "通义千问",
            iconManual: true,
            models: [],
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      models: [],
      methodResponses: {
        "config.get": configSnapshot(config, "stored-provider-icons"),
        "models.authStatus": { ts: NOW, providerCapabilities: [], providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await page.locator(".page-title", { hasText: "Models" }).first().waitFor();

      await expect
        .poll(() => sidebarMark(page, "auto-glm").getAttribute("data-provider-icon"))
        .toBe("zai");
      await expect
        .poll(() => sidebarMark(page, "manual-kimi").getAttribute("data-provider-icon"))
        .toBe("kimi");
      // A manual removal suppresses anthropic's built-in exact-id mark.
      await expect
        .poll(async () => (await sidebarMark(page, "anthropic").textContent())?.trim())
        .toBe("C");
      await expect
        .poll(() => sidebarMark(page, "anthropic").getAttribute("data-provider-icon"))
        .toBeNull();
      await expect
        .poll(async () => (await sidebarMark(page, "plain-relay").textContent())?.trim())
        .toBe("A");
      await expect
        .poll(() => sidebarMark(page, "plain-relay").getAttribute("data-provider-icon"))
        .toBeNull();
      // The badge reads the configured name, so a CJK first character proves the
      // fallback is not derived from the provider id.
      await expect
        .poll(async () => (await sidebarMark(page, "cjk-relay").textContent())?.trim())
        .toBe("通");
      await expect
        .poll(() => sidebarMark(page, "cjk-relay").getAttribute("data-provider-icon"))
        .toBeNull();

      const autoEditor = await selectProviderEditor(page, "auto-glm");
      await expect
        .poll(async () =>
          (await autoEditor.locator(".provider-manager__identity h2").textContent())?.trim(),
        )
        .toBe("GLM Team");
      await expect
        .poll(() => editorMark(autoEditor).getAttribute("data-provider-icon"))
        .toBe("zai");
      const iconResource = await editorMark(autoEditor).evaluate((node) => {
        const value = getComputedStyle(node).getPropertyValue("--provider-icon-url");
        return value.match(/url\(["']?([^"')]+)/)?.[1] ?? null;
      });
      const iconUrl = new URL(iconResource!, server.baseUrl);
      expect(iconUrl.pathname).toBe("/provider-icons/ProviderIcon-zai.svg");
      const iconResponse = await page.request.get(iconUrl.toString());
      expect(iconResponse.ok()).toBe(true);
      expect(iconResponse.headers()["content-type"]).toContain("image/svg+xml");

      const manualEditor = await selectProviderEditor(page, "manual-kimi");
      await expect
        .poll(() => editorMark(manualEditor).getAttribute("data-provider-icon"))
        .toBe("kimi");

      const noneEditor = await selectProviderEditor(page, "anthropic");
      await expect
        .poll(async () => (await editorFallback(noneEditor).textContent())?.trim())
        .toBe("C");
      await expect.poll(() => editorIconId(noneEditor).count()).toBe(0);

      const plainEditor = await selectProviderEditor(page, "plain-relay");
      await expect
        .poll(async () => (await editorFallback(plainEditor).textContent())?.trim())
        .toBe("A");
      await expect.poll(() => editorIconId(plainEditor).count()).toBe(0);

      // Capture the no-icon CJK name in the editor title so the letter badge's
      // glyph can be checked for clipping, not only asserted as DOM text.
      const cjkEditor = await selectProviderEditor(page, "cjk-relay");
      await expect
        .poll(async () =>
          (await cjkEditor.locator(".provider-manager__identity h2").textContent())?.trim(),
        )
        .toBe("通义千问");
      await expect
        .poll(async () => (await editorFallback(cjkEditor).textContent())?.trim())
        .toBe("通");
      await expect.poll(() => editorIconId(cjkEditor).count()).toBe(0);
      if (recordVisuals) {
        await captureProviderProof("cjk-fallback.png", page.locator(".model-providers__workspace"));
      }

      await selectProviderEditor(page, "auto-glm");
      if (recordVisuals) {
        await captureProviderProof("stored-icons.png", page.locator(".model-providers__workspace"));
      }
      // Viewing stored icons never rewrites config: switching editors leaves the
      // mocked Gateway without a single config.patch.
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("previews and stores the name-matched icon when a provider is created", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
    });
    const page = await context.newPage();
    let config: ProvidersConfig = { models: { providers: {} } };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      models: [],
      methodResponses: {
        "config.get": configSnapshot(config, "create-provider"),
        "models.authStatus": { ts: NOW, providerCapabilities: [], providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      await page.locator(".model-providers__workspace").waitFor();
      await page.locator("[data-custom-provider]").first().click();
      const editor = page.locator(".model-providers__editor");
      await editor.locator("openclaw-provider-manager").waitFor();

      const name = editor.locator('input[name="displayName"]');
      await name.fill("通义千问");
      await expect
        .poll(() => editorMark(editor).getAttribute("data-provider-icon"))
        .toBe("alibaba");
      await name.blur();

      const patchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await editor.locator('input[name="baseUrl"]').fill("https://tongyi.example.test/v1");
      const raw = requestRaw(await gateway.waitForRequest("config.patch", { after: patchCount }));
      const createdId = "custom-tongyi-example-test";
      const providers = raw.models as { providers: Record<string, Record<string, unknown>> };
      expect(Object.keys(providers.providers)).toEqual([createdId]);
      expect(providers.providers[createdId]).toEqual({
        baseUrl: "https://tongyi.example.test/v1",
        displayName: "通义千问",
        icon: "alibaba",
        api: "openai-completions",
        models: [],
      });

      config = applyMergePatch(config as Record<string, unknown>, raw) as ProvidersConfig;
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "create-provider-saved",
      );
      await gateway.emitGatewayEvent("config.changed", {});

      await expect
        .poll(() => sidebarMark(page, createdId).getAttribute("data-provider-icon"))
        .toBe("alibaba");
      await expect
        .poll(async () =>
          (await editor.locator(".provider-manager__identity h2").textContent())?.trim(),
        )
        .toBe("通义千问");
      await expect
        .poll(() => editorMark(editor).getAttribute("data-provider-icon"))
        .toBe("alibaba");
      expect(configuredProvider(config, createdId)).not.toHaveProperty("iconManual");
    } finally {
      await context.close();
    }
  });

  it("rewrites automatic icons and preserves manual icons when a provider is renamed", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
    });
    const page = await context.newPage();
    let config: ProvidersConfig = {
      models: {
        providers: {
          "auto-brand": {
            baseUrl: "https://auto.example.test/v1",
            displayName: "OpenAI",
            icon: "codex",
            models: [],
          },
          "manual-brand": {
            baseUrl: "https://manual.example.test/v1",
            displayName: "Relay",
            icon: "kimi",
            iconManual: true,
            models: [],
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      models: [],
      methodResponses: {
        "config.get": configSnapshot(config, "rename-provider"),
        "models.authStatus": { ts: NOW, providerCapabilities: [], providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const autoEditor = await selectProviderEditor(page, "auto-brand");
      const autoName = autoEditor.locator('input[name="displayName"]');
      const autoPatchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await autoName.fill("Claude Gateway");
      await autoName.blur();
      const autoRaw = requestRaw(
        await gateway.waitForRequest("config.patch", { after: autoPatchCount }),
      );
      expect(autoRaw).toEqual({
        models: {
          providers: { "auto-brand": { displayName: "Claude Gateway", icon: "claude" } },
        },
      });
      config = applyMergePatch(config as Record<string, unknown>, autoRaw) as ProvidersConfig;
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "rename-auto",
      );
      await gateway.emitGatewayEvent("config.changed", {});
      await expect
        .poll(() => sidebarMark(page, "auto-brand").getAttribute("data-provider-icon"))
        .toBe("claude");
      await expect
        .poll(() => editorMark(autoEditor).getAttribute("data-provider-icon"))
        .toBe("claude");
      await expect
        .poll(async () =>
          (await autoEditor.locator(".provider-manager__identity h2").textContent())?.trim(),
        )
        .toBe("Claude Gateway");

      const manualEditor = await selectProviderEditor(page, "manual-brand");
      const manualName = manualEditor.locator('input[name="displayName"]');
      const manualPatchCount = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await manualName.fill("OpenAI Proxy");
      await manualName.blur();
      const manualRaw = requestRaw(
        await gateway.waitForRequest("config.patch", { after: manualPatchCount }),
      );
      const manualEntry = (manualRaw.models as { providers: Record<string, unknown> }).providers[
        "manual-brand"
      ];
      expect(manualEntry).toEqual({ displayName: "OpenAI Proxy" });
      expect(manualEntry).not.toHaveProperty("icon");
      expect(manualEntry).not.toHaveProperty("iconManual");
      config = applyMergePatch(config as Record<string, unknown>, manualRaw) as ProvidersConfig;
      expect(configuredProvider(config, "manual-brand")).toMatchObject({
        icon: "kimi",
        iconManual: true,
      });
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "rename-manual",
      );
      await gateway.emitGatewayEvent("config.changed", {});
      await expect
        .poll(() => sidebarMark(page, "manual-brand").getAttribute("data-provider-icon"))
        .toBe("kimi");
      await expect
        .poll(() => editorMark(manualEditor).getAttribute("data-provider-icon"))
        .toBe("kimi");
    } finally {
      await context.close();
    }
  });

  it("writes manual, automatic, and no-icon choices from the icon picker", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
      ...(recordVisuals
        ? { recordVideo: { dir: proofArtifactDir(), size: { height: 1000, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    let config: ProvidersConfig = {
      models: {
        providers: {
          "custom-relay": {
            baseUrl: "https://relay.example.test/v1",
            displayName: "OpenAI",
            icon: "codex",
            models: [],
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "config.patch"],
      models: [],
      methodResponses: {
        "config.get": configSnapshot(config, "picker-provider"),
        "models.authStatus": { ts: NOW, providerCapabilities: [], providers: [] },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/model-providers`);
      const editor = await selectProviderEditor(page, "custom-relay");
      const picker = await openIconPicker(editor);

      const choices = picker.locator("[data-provider-icon-choice]");
      await expect.poll(() => choices.count()).toBe(iconAssetIds.length);
      const choiceIds = (
        await choices.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-provider-icon-choice") ?? ""),
        )
      ).toSorted();
      expect(choiceIds).toEqual(iconAssetIds);
      const choiceLabels = await choices.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label") ?? ""),
      );
      expect(choiceLabels.filter((label) => label.trim().length > 0)).toHaveLength(
        iconAssetIds.length,
      );

      if (recordVisuals) {
        await captureProviderProof(
          "icon-picker.png",
          picker.locator(".provider-icon-picker__panel"),
        );
      }

      const search = picker.locator(".provider-icon-picker__search");
      await search.fill("mistral");
      await expect.poll(() => choices.count()).toBe(1);
      await expect
        .poll(() =>
          picker.locator('[data-provider-icon-choice="mistral"]').getAttribute("aria-label"),
        )
        .toBe("Mistral AI");

      const manualPatch = await chooseIcon(
        gateway,
        picker.locator('[data-provider-icon-choice="mistral"]'),
      );
      expect(manualPatch).toEqual({
        models: { providers: { "custom-relay": { icon: "mistral", iconManual: true } } },
      });
      config = applyMergePatch(config as Record<string, unknown>, manualPatch) as ProvidersConfig;
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "picker-manual",
      );
      await gateway.emitGatewayEvent("config.changed", {});
      await expect
        .poll(() => sidebarMark(page, "custom-relay").getAttribute("data-provider-icon"))
        .toBe("mistral");
      await expect
        .poll(() => editorMark(editor).getAttribute("data-provider-icon"))
        .toBe("mistral");
      // The picker closes on selection; caption the settled editor rather than
      // its fade-out frame.
      await expect
        .poll(() => picker.locator(".provider-icon-picker__search").isVisible())
        .toBe(false);
      if (recordVisuals) {
        await captureProviderProof(
          "after-manual-pick.png",
          page.locator(".model-providers__workspace"),
        );
      }

      await openIconPicker(editor);
      const automaticPatch = await chooseIcon(
        gateway,
        picker.getByRole("button", { name: "Automatic", exact: true }),
      );
      expect(automaticPatch).toEqual({
        models: { providers: { "custom-relay": { icon: "codex", iconManual: null } } },
      });
      config = applyMergePatch(
        config as Record<string, unknown>,
        automaticPatch,
      ) as ProvidersConfig;
      expect(configuredProvider(config, "custom-relay")).not.toHaveProperty("iconManual");
      expect(configuredProvider(config, "custom-relay")).toMatchObject({ icon: "codex" });
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "picker-automatic",
      );
      await gateway.emitGatewayEvent("config.changed", {});

      await expect
        .poll(() => picker.locator(".provider-icon-picker__search").isVisible())
        .toBe(false);
      await openIconPicker(editor);
      const nonePatch = await chooseIcon(
        gateway,
        picker.getByRole("button", { name: "No icon", exact: true }),
      );
      expect(nonePatch).toEqual({
        models: { providers: { "custom-relay": { icon: null, iconManual: true } } },
      });
      config = applyMergePatch(config as Record<string, unknown>, nonePatch) as ProvidersConfig;
      const stored = configuredProvider(config, "custom-relay");
      expect(stored).not.toHaveProperty("icon");
      expect(stored).toMatchObject({ iconManual: true });
      await resolveConfigMutation(
        gateway,
        config as unknown as Record<string, unknown>,
        "picker-none",
      );
      await gateway.emitGatewayEvent("config.changed", {});
      await expect.poll(async () => (await editorFallback(editor).textContent())?.trim()).toBe("O");
      await expect
        .poll(async () => (await sidebarMark(page, "custom-relay").textContent())?.trim())
        .toBe("O");
    } finally {
      await context.close();
    }
  });

  it("shows a stored provider icon in the chat model picker", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const config = {
      models: {
        providers: {
          "custom-relay": {
            baseUrl: "https://relay.example.test/v1",
            displayName: "Relay",
            icon: "mistral",
            models: [{ id: "relay-model", name: "Relay Model" }],
          },
        },
      },
    };
    const session = {
      key: sessionKey,
      kind: "direct",
      updatedAt: 1,
      sessionId: "stored-icon-proof",
      model: "relay-model",
      modelProvider: "custom-relay",
      modelOverrideSource: "user",
    };
    const gateway = await installMockGateway(page, {
      sessionKey,
      models: [
        { id: "relay-model", name: "Relay Model", provider: "custom-relay", available: true },
      ],
      methodResponses: {
        "config.get": configSnapshot(config, "chat-stored-icon"),
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            contextTokens: null,
            model: "relay-model",
            modelProvider: "custom-relay",
            modelSelectionTarget: "session",
          },
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await gateway.waitForRequest("models.list");
      await gateway.waitForRequest("config.get");
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await expect
        .poll(() =>
          picker
            .locator("[data-chat-model-select] [data-provider-icon]")
            .getAttribute("data-provider-icon"),
        )
        .toBe("mistral");
    } finally {
      await context.close();
    }
  });
});
