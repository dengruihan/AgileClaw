/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { AssistantDock } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./assistant-panel.ts";
import "./assistant-panel-content.ts";

vi.mock("./assistant-session.runtime.ts", () => {
  if (!customElements.get("openclaw-assistant-session")) {
    customElements.define("openclaw-assistant-session", class extends HTMLElement {});
  }
  return {};
});

type TestAssistantPanel = HTMLElement & {
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  assistantPanelOpen: boolean;
  updateComplete: Promise<boolean>;
};

function buildContext() {
  const { gateway, publish } = createApplicationGateway({
    client: { request: vi.fn().mockResolvedValue(null) } as never,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      server: { version: "1.0.0" },
    },
    sessionKey: "agent:main:task",
  } as never);
  const agents = createAgentCapability(gateway);
  agents.state.agentsList = {
    defaultId: "main",
    mainKey: "home",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "research" }, { id: "care", kind: "system" }],
  } as never;
  const agentSelection = {
    state: { selectedId: "main" as string | null },
    subscribe: () => () => undefined,
  };
  const context = {
    gateway,
    agents,
    agentSelection,
    assistantDock: new AssistantDock(),
    sessions: createSessionCapability(gateway, agentSelection as never),
    basePath: "",
    navigate: vi.fn(),
  } as never;
  return { context, publish, agents };
}

async function mountPanel() {
  const { context, agents } = buildContext();
  // The app owns this capability; removing its panel does not stop subscription retries.
  onTestFinished(() => (context as { sessions: { dispose: () => void } }).sessions.dispose());
  onTestFinished(() => agents.dispose());
  const provider = createApplicationContextProvider(context);
  const panel = document.createElement("openclaw-assistant-panel") as TestAssistantPanel;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { context, panel, provider };
}

function openDock(
  context: unknown,
  params: { sessionKey: string; agentId: string; label: string },
) {
  (context as { assistantDock: AssistantDock }).assistantDock.openSession(params, {});
}

function dockSession(panel: TestAssistantPanel) {
  return panel.querySelector<HTMLElement & { sessionKey: string; agentId: string }>(
    "openclaw-assistant-session",
  );
}

describe("assistant panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-assistant-reserve-bottom");
    document.documentElement.style.removeProperty("--oc-assistant-reserve-right");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens an explicit dock session without a built-in destination", async () => {
    const { context, panel } = await mountPanel();
    expect(panel.assistantPanelOpen).toBe(false);
    expect(dockSession(panel)).toBeNull();

    openDock(context, {
      sessionKey: "agent:research:task",
      agentId: "research",
      label: "Research",
    });
    await vi.dynamicImportSettled();
    await panel.updateComplete;

    expect(panel.assistantPanelOpen).toBe(true);
    expect(dockSession(panel)).toMatchObject({
      sessionKey: "agent:research:task",
      agentId: "research",
    });
    expect(chatInputOwnerForContext(context).current).toBe("dock");
    expect((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey).toBe(
      "agent:research:task",
    );
    // One switcher: the dock renders no agent selector of its own.
    expect(panel.querySelector("select")).toBeNull();
  });

  it("hides while the docked conversation owns the page and returns after navigation", async () => {
    const { context, panel } = await mountPanel();
    panel.pageSessionKey = "agent:research:task";
    panel.pageAgentId = "research";
    panel.pageRouteId = "chat";
    await panel.updateComplete;
    openDock(context, {
      sessionKey: "agent:research:task",
      agentId: "research",
      label: "Research",
    });
    await vi.dynamicImportSettled();
    await panel.updateComplete;

    expect(dockSession(panel)).toBeNull();
    expect(chatInputOwnerForContext(context).current).toBe("page");
    expect((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey).toBeNull();

    panel.pageRouteId = "appearance";
    await panel.updateComplete;
    expect(dockSession(panel)?.agentId).toBe("research");
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("distinguishes agents sharing a global session key", async () => {
    const { context, panel } = await mountPanel();
    panel.pageSessionKey = "global";
    panel.pageAgentId = "main";
    await panel.updateComplete;
    openDock(context, { sessionKey: "global", agentId: "research", label: "Research" });
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(dockSession(panel)).toMatchObject({ sessionKey: "global", agentId: "research" });
    panel.pageAgentId = "research";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    panel.pageAgentId = "main";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("closes without a destination and stays closed after remount", async () => {
    const { context, panel } = await mountPanel();
    openDock(context, { sessionKey: "agent:main:task", agentId: "main", label: "Task" });
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);

    (context as { assistantDock: AssistantDock }).assistantDock.close();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    expect(dockSession(panel)).toBeNull();

    panel.remove();
    const { panel: replacement } = await mountPanel();
    replacement.pageRouteId = "appearance";
    await replacement.updateComplete;
    expect(replacement.assistantPanelOpen).toBe(false);
    expect(dockSession(replacement)).toBeNull();
    expect(replacement.querySelectorAll(".assistant-panel")).toHaveLength(1);
  });

  it("ignores a close activation from another dock owner", async () => {
    const { context, panel } = await mountPanel();
    const activation = {};
    (context as { assistantDock: AssistantDock }).assistantDock.openSession(
      { sessionKey: "agent:main:task", agentId: "main", label: "Task" },
      activation,
    );
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    (context as { assistantDock: AssistantDock }).assistantDock.close({});
    expect(panel.assistantPanelOpen).toBe(true);
    (context as { assistantDock: AssistantDock }).assistantDock.close(activation);
    expect(panel.assistantPanelOpen).toBe(false);
  });
});
