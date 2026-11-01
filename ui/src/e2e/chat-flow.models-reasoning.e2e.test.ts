import { writeFile } from "node:fs/promises";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

async function createReasoningProofPage(scope: string) {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const artifactDir = parent ? createControlUiE2eArtifactDir(scope, parent) : undefined;
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  const page = await context.newPage();
  const capture = async (fileName: string, surface: Locator, content: Locator) => {
    if (artifactDir) {
      await writeFile(
        `${artifactDir}/${fileName}.png`,
        await takeControlUiViewportScreenshot(page, surface, [content]),
      );
    }
  };
  return { context, page, capture };
}

suite.define(() => {
  it("patches a selectable Claude CLI context window", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:main:session-a";
    const contextWindows = [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ];
    const session = {
      key: sessionKey,
      sessionId: "session-a-context-window",
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      contextWindow: "1m",
      contextWindowDefault: "1m",
      contextWindows,
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindowDefault: "1m",
          contextWindows,
        },
      ],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__model-picker");
      await picker.locator('[data-chat-model-select="true"]').click();
      const toggle = picker.locator("[data-chat-context-window-toggle]");
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
      await gateway.deferNext("sessions.patch");
      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      await toggle.click();
      const patch = await gateway.waitForRequest("sessions.patch", { after: patchCount });
      expect(requireRecord(patch.params)).toMatchObject({
        key: sessionKey,
        contextWindow: "200k",
      });
      // Patch acknowledgements and history must see the same committed context window.
      await gateway.setSessionsListResponse(
        chatSessionListResponse([{ ...session, contextWindow: "200k" }]),
      );
      await gateway.resolveDeferred("sessions.patch");
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await expect
        .poll(async () =>
          (await picker.locator("[data-chat-model-context-badge]").textContent())?.trim(),
        )
        .toBe("200K");
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("routes runtime-aware model commands through the server directive path", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const command = "/model openai/gpt-5.6-luna --runtime codex continue with the selected model";
      await page.locator(".agent-chat__composer-combobox textarea").fill(command);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(requireRecord(sendRequest.params)).toMatchObject({
        message: command,
        sessionKey: "agent:main:main",
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps high-velocity model scrolling inside the picker", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ...Array.from({ length: 32 }, (_value, index) => ({
        id: `scroll-model-${index + 1}`,
        name: `Scroll Model ${index + 1}`,
        provider: "openai",
      })),
    ];
    await installMockGateway(page, {
      models,
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      await main.locator(".chat-composer-model-control").evaluate((element) => {
        Object.assign((element as HTMLElement).style, {
          position: "fixed",
          right: "80px",
          top: "640px",
        });
      });
      await page.evaluate(() => {
        document.documentElement.style.overflowY = "auto";
        document.body.style.height = "1800px";
        window.scrollTo(0, 300);
      });
      expect(await page.evaluate(() => window.scrollY)).toBe(300);

      await main.locator('[data-chat-model-select="true"]').click();
      const modelScroller = main.locator(".chat-controls__model-options");
      await expect.poll(() => modelScroller.isVisible()).toBe(true);
      await modelScroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      // The wheel owns this scroll assertion; Playwright must not scroll ancestors first.
      await modelScroller.hover({ scroll: "none" });
      expect(await page.evaluate(() => window.scrollY)).toBe(300);
      await page.mouse.wheel(0, -5_000);
      await page.waitForTimeout(100);

      expect(await page.evaluate(() => window.scrollY)).toBe(300);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows one canonical default model with matching inherited reasoning", async () => {
    const { context, page, capture } = await createReasoningProofPage("chat-flow.models-reasoning");
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
      (id) => ({ id, label: id }),
    );
    const agentsList = {
      agents: [
        {
          id: "main",
          model: { primary: "openai/gpt-5.6-sol" },
          name: "Main",
          thinkingDefault: "medium",
          thinkingLevels,
          thinkingOptions: thinkingLevels.map((level) => level.label),
        },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = {
      count: 2,
      defaults: {
        contextTokens: null,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        thinkingDefault: "medium",
        thinkingLevels,
        thinkingOptions: thinkingLevels.map((level) => level.label),
      },
      path: "",
      sessions: [
        {
          key: "agent:main:session-default",
          sessionId: "control-ui-profile-default-proof",
          kind: "direct",
          label: "Default Sol",
          updatedAt: 2,
        },
        {
          key: "agent:main:session-explicit",
          kind: "direct",
          label: "Explicit Sol",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          updatedAt: 1,
        },
      ],
      ts: Date.now(),
    };
    const models = [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models },
          sessionId: "control-ui-profile-default-proof",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models,
      sessionKey: "agent:main:session-default",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-default"));
      const main = page.getByRole("main");
      const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
      const modelSelect = activePane.locator('[data-chat-model-select="true"]');
      const modelPopup = activePane.locator('.chat-controls__model-picker wa-popup [part="popup"]');
      const modelOption = activePane.locator('[data-chat-model-option="openai/gpt-5.6-sol"]');
      const effortSelect = activePane.locator('[data-chat-thinking-select="true"]');
      const thinkingSlider = activePane.locator('[data-chat-thinking-slider="true"]');
      const expectedThinkingValues = thinkingLevels.map((level) => level.id).join(",");

      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await modelSelect.textContent()).toContain("GPT-5.6 Sol");
      expect(await modelSelect.textContent()).not.toContain("@openai:");
      await modelSelect.click();
      await expect.poll(() => modelOption.count()).toBe(1);
      expect(
        (await main.locator("[data-chat-model-option]").allTextContents()).join(" "),
      ).not.toContain("@openai:");
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe(expectedThinkingValues);
      const defaultThinkingValue = await effortSelect.getAttribute("data-chat-thinking-value");
      await revealChatModelOption(modelOption);
      await capture("default-sol", modelPopup, modelOption);

      await page.keyboard.press("Escape");
      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-explicit"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Explicit Sol").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => activePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
        .toBe("agent:main:session-explicit");
      await modelSelect.click();
      await expect.poll(() => modelOption.count()).toBe(1);
      await expect
        .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
        .toBe(expectedThinkingValues);
      expect(await effortSelect.getAttribute("data-chat-thinking-value")).toBe(
        defaultThinkingValue,
      );
      await revealChatModelOption(modelOption);
      await capture("explicit-sol", modelPopup, modelOption);

      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not reuse catalog reasoning for a different session runtime", async () => {
    const { context, page, capture } = await createReasoningProofPage(
      "chat-flow.runtime-reasoning",
    );
    const sessionKey = "agent:main:codex-luna";
    await installMockGateway(page, {
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          reasoning: true,
          agentRuntime: { id: "openclaw", source: "model" },
          thinkingLevels: ["max", "ultra"].map((id) => ({ id, label: id })),
          thinkingDefault: "ultra",
        },
      ],
      sessionKey,
      sessions: [
        {
          key: sessionKey,
          kind: "direct",
          label: "Codex Luna",
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          agentRuntime: { id: "codex", source: "session-key" },
          thinkingLevels: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          thinkingDefault: "high",
          updatedAt: 1,
        },
      ],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      // Summary click actionability does not wait for our history-loading disabled state.
      const effortSelect = pane.locator(
        '[data-chat-thinking-select="true"][aria-disabled="false"]',
      );
      await effortSelect.click();
      const thinkingSlider = pane.locator('[data-chat-thinking-slider="true"]');
      await thinkingSlider.waitFor({ state: "visible" });
      await capture(
        "codex-luna-reasoning",
        pane.locator('.chat-controls__effort-picker wa-popup [part="popup"]'),
        thinkingSlider,
      );

      expect(await thinkingSlider.getAttribute("data-chat-thinking-values")).toBe("low,high");
      expect(await effortSelect.getAttribute("data-chat-thinking-value")).not.toBe("ultra");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("lists authored models only, keeping the selection and default visible", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      models: {
        providers: { openai: { models: [{ id: "gpt-5.5-mini", name: "GPT-5.5 Mini" }] } },
      },
    };
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "config.get": {
          config,
          hash: "custom-models-e2e",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.5-mini", name: "GPT-5.5 Mini", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      const main = page.getByRole("main");
      const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
      const modelSelect = activePane.locator('[data-chat-model-select="true"]');
      await modelSelect.waitFor({ state: "visible", timeout: 10_000 });
      await modelSelect.click();
      // With an authored entry present, catalog-only rows hide: the picker
      // lists the authored mini plus the retained default, never bedrock.
      const options = activePane.locator("[data-chat-model-option]");
      await expect.poll(() => options.count()).toBe(2);
      await revealChatModelOption(
        activePane.locator('[data-chat-model-option="openai/gpt-5.5-mini"]'),
      );
      expect(
        await activePane.locator('[data-chat-model-option="bedrock/claude-opus-4.5"]').count(),
      ).toBe(0);
      const defaultOption = activePane.locator('[data-chat-model-default="true"]');
      await expect.poll(() => defaultOption.getAttribute("aria-selected")).toBe("true");
      expect(await defaultOption.getAttribute("data-chat-model-option")).toBe("openai/gpt-5.5");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
