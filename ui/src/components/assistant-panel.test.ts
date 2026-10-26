/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { AssistantDock } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  CHAT_ROUTE_READY_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import { publishChatWorkContext, type ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./assistant-panel.ts";
import "./assistant-panel-content.ts";

vi.mock("./home-session.runtime.ts", () => {
  if (!customElements.get("openclaw-home-session")) {
    customElements.define("openclaw-home-session", class extends HTMLElement {});
  }
  return {};
});

type TestAssistantPanel = HTMLElement & {
  homeAvailable: boolean;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  pageRouteFailed: boolean;
  assistantPanelOpen: boolean;
  updateComplete: Promise<boolean>;
};

function buildContext(options: { global?: boolean } = {}) {
  const { gateway, publish } = createApplicationGateway({
    client: { request: vi.fn().mockResolvedValue(null) } as never,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      server: { version: "1.0.0" },
    },
    sessionKey: "agent:main:task",
  } as never);
  const agents = createAgentCapability(gateway);
  agents.state.agentsList = {
    defaultId: "main",
    mainKey: "home",
    scope: options.global ? "global" : "per-sender",
    agents: [
      { id: "main", model: { primary: "openai/gpt-5.5" } },
      { id: "research" },
      { id: "care", kind: "system" },
    ],
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

async function mountPanel(options: { global?: boolean } = {}) {
  const { context, agents, publish } = buildContext(options);
  // The app owns this capability; removing its panel does not stop subscription retries.
  onTestFinished(() => (context as { sessions: { dispose: () => void } }).sessions.dispose());
  onTestFinished(() => agents.dispose());
  const provider = createApplicationContextProvider(context);
  const panel = document.createElement("openclaw-assistant-panel") as TestAssistantPanel;
  panel.homeAvailable = true;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { context, panel, provider, publish };
}

async function restoreHomePanel() {
  const { panel } = await mountPanel();
  panel.homeAvailable = true;
  await panel.updateComplete;
  window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
  await vi.dynamicImportSettled();
  await panel.updateComplete;
  panel.remove();
  const restored = await mountPanel();
  restored.panel.homeAvailable = true;
  restored.panel.pageSessionKey = "agent:main:task";
  await restored.panel.updateComplete;
  return restored;
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

  it.each([false, true])(
    "follows the sidebar agent switcher and suppresses only the selected conversation (global=%s)",
    async (global) => {
      const { context, panel, publish } = await mountPanel({ global });
      panel.pageSessionKey = "agent:research:task";
      panel.pageAgentId = "research";
      panel.pageRouteId = "chat";
      await panel.updateComplete;
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      await vi.dynamicImportSettled();
      await panel.updateComplete;
      const home = () =>
        panel.querySelector<HTMLElement & { sessionKey: string; agentId: string }>(
          "openclaw-home-session",
        );
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:main:home");
      expect(home()?.agentId).toBe("main");
      expect(chatInputOwnerForContext(context).current).toBe("dock");
      // One switcher: the dock renders no agent selector of its own.
      expect(panel.querySelector("select")).toBeNull();

      // The dock follows the sidebar agent switcher.
      (
        context as { agentSelection: { state: { selectedId: string | null } } }
      ).agentSelection.state.selectedId = "research";
      panel.pageSessionKey = "agent:research:other-task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(panel.assistantPanelOpen).toBe(true);

      // System agents stay valid chat targets elsewhere but never become the dock target.
      (
        context as { agentSelection: { state: { selectedId: string | null } } }
      ).agentSelection.state.selectedId = "care";
      panel.pageSessionKey = "agent:research:task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("main");
      (
        context as { agentSelection: { state: { selectedId: string | null } } }
      ).agentSelection.state.selectedId = "research";

      // The selected agent's own Home page suppresses the dock; leaving restores it.
      panel.pageSessionKey = global ? "global" : "agent:research:home";
      await panel.updateComplete;
      expect(home()).toBeNull();
      expect(chatInputOwnerForContext(context).current).toBe("page");
      panel.pageRouteId = "appearance";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");

      publish({
        ...(context as { gateway: ApplicationGateway }).gateway.snapshot,
        phase: "offline",
        hello: null,
      } as never);
      (context as { agents: { state: { agentsList: unknown } } }).agents.state.agentsList = null;
      panel.pageSessionKey = "agent:research:offline-task";
      await panel.updateComplete;
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(home()?.agentId).toBe("research");
      panel.remove();
      expect(chatInputOwnerForContext(context).current).toBe("page");
    },
  );

  it("replaces the Home toggle with an activation-owned session and follows navigation without restoring closed docks", async () => {
    const { context, panel } = await mountPanel();
    panel.pageRouteId = "plugin";
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    const activation = {};
    const hint = { page: "review:board", detail: { filter: "stuck" } };
    const keys: (string | null)[] = [];
    const stop = (context as { assistantDock: AssistantDock }).assistantDock.subscribe(() =>
      keys.push((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey),
    );
    onTestFinished(stop);
    (context as { assistantDock: AssistantDock }).assistantDock.openSession(
      {
        sessionKey: "agent:research:review",
        agentId: "research",
        label: "Review conversation",
        context: hint,
      },
      activation,
    );
    hint.detail.filter = "changed after opening";
    await panel.updateComplete;
    const home = () =>
      panel.querySelector<
        HTMLElement & {
          sessionKey: string;
          agentId: string;
          workContext: ChatWorkContext;
        }
      >("openclaw-home-session");
    expect(home()).toMatchObject({
      sessionKey: "agent:research:review",
      agentId: "research",
      workContext: { page: "review:board", detail: { filter: "stuck" } },
    });
    expect(panel.textContent).toContain("Review conversation");
    expect((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey).toBe(
      "agent:research:review",
    );
    panel.pageRouteId = "appearance";
    await panel.updateComplete;
    expect(home()).not.toBeNull();
    panel.pageSessionKey = "agent:research:review";
    panel.pageAgentId = "research";
    for (const route of ["chat", "dashboard"] as const) {
      panel.pageRouteId = route;
      await panel.updateComplete;
      expect(home(), route).toBeNull();
      expect((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey).toBeNull();
      panel.pageRouteId = "plugin";
      await panel.updateComplete;
      expect(home()?.sessionKey).toBe("agent:research:review");
    }
    (context as { assistantDock: AssistantDock }).assistantDock.close({});
    expect(panel.assistantPanelOpen).toBe(true);
    (context as { assistantDock: AssistantDock }).assistantDock.close(activation);
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    // Home is the only built-in destination; no dock target is persisted anymore.
    const storedTargets = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key) => key?.startsWith("openclaw.assistant.panel.target.v1:"));
    expect(storedTargets).toEqual([]);
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    expect((context as { assistantDock: AssistantDock }).assistantDock.openSessionKey).toBeNull();
    expect(panel.querySelector("openclaw-home-session")).not.toBeNull();
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    panel.pageRouteId = "appearance";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    expect(keys).toEqual([
      "agent:research:review",
      null,
      "agent:research:review",
      null,
      "agent:research:review",
      null,
    ]);
  });

  it("opens for read-only viewers and distinguishes agents sharing a global session key", async () => {
    const { context, panel } = await mountPanel({ global: true });
    panel.pageSessionKey = "global";
    panel.pageAgentId = "main";
    await panel.updateComplete;
    (context as { assistantDock: AssistantDock }).assistantDock.openSession(
      { sessionKey: "global", agentId: "research", label: "Research" },
      {},
    );
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-home-session")).toMatchObject({
      sessionKey: "global",
      agentId: "research",
    });
    panel.pageAgentId = "research";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    panel.pageAgentId = "main";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("restores the Home destination after remount", async () => {
    const { panel } = await mountPanel();
    panel.homeAvailable = true;
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-home-session")).not.toBeNull();
    panel.remove();

    const { panel: replacement } = await mountPanel();
    replacement.homeAvailable = true;
    replacement.pageRouteId = "appearance";
    await replacement.updateComplete;
    const home = replacement.querySelector<HTMLElement & { agentId: string }>(
      "openclaw-home-session",
    );
    expect(home?.agentId).toBe("main");
    expect(replacement.assistantPanelOpen).toBe(true);
    expect(replacement.querySelectorAll(".assistant-panel")).toHaveLength(1);
  });

  it("restores Home only after the selected transcript has rendered, preserving dock geometry", async () => {
    const { panel: replacement, provider } = await restoreHomePanel();
    const home = () => replacement.querySelector("openclaw-home-session");
    expect(replacement.assistantPanelOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
      "440px",
    );
    expect(home()).toBeNull();

    let finishRender!: () => void;
    const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
      sessionKey: "agent:main:task",
      presented: true,
      transcriptReady: false,
      updateComplete: new Promise<void>((resolve) => {
        finishRender = resolve;
      }),
    });
    pane.classList.add("chat-pane-cache__pane--active");
    provider.prepend(pane);
    pane.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true }));
    await replacement.updateComplete;
    expect(home()).toBeNull();
    pane.transcriptReady = true;
    pane.dispatchEvent(new Event(CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, { bubbles: true }));
    await replacement.updateComplete;
    expect(home()).toBeNull();
    // A superseded route must not release Home from the old pane's late commit.
    replacement.pageSessionKey = "agent:main:next-task";
    await replacement.updateComplete;
    finishRender();
    await pane.updateComplete;
    await replacement.updateComplete;
    expect(home()).toBeNull();
    replacement.pageSessionKey = "agent:main:task";
    await replacement.updateComplete;
    await vi.waitFor(() => expect(home()).not.toBeNull());
    expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
      "440px",
    );

    replacement.pageSessionKey = "agent:main:next-task";
    await replacement.updateComplete;
    expect(home()).not.toBeNull();
  });

  it.each(["explicit", "non-chat", "failed"] as const)(
    "releases restored Home without a primary transcript for %s navigation",
    async (release) => {
      const { panel: replacement } = await restoreHomePanel();
      expect(replacement.querySelector("openclaw-home-session")).toBeNull();
      if (release === "explicit") {
        window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
      } else if (release === "non-chat") {
        replacement.pageRouteId = "appearance";
      } else {
        replacement.pageRouteFailed = true;
      }
      await replacement.updateComplete;
      expect(replacement.querySelector("openclaw-home-session")).not.toBeNull();
    },
  );

  it.each(["right", "bottom"])("drags only passive header chrome when docked %s", async (dock) => {
    const { panel } = await mountPanel();
    await panel.updateComplete;
    window.dispatchEvent(
      new CustomEvent(HOME_PANEL_TOGGLE_EVENT, { detail: { open: true, dock } }),
    );
    await panel.updateComplete;

    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
    const cases = [
      [".assistant-panel-header", true],
      [".assistant-panel-title", true],
      [".assistant-panel-actions", true],
      [".assistant-panel-actions button", false],
      [".assistant-panel-actions button svg", false],
    ] as const;
    for (const [selector, draggable] of cases) {
      postMessage.mockClear();
      const target = panel.querySelector(selector);
      expect(target, selector).not.toBeNull();
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      });
      target!.dispatchEvent(event);
      expect(postMessage, selector).toHaveBeenCalledTimes(draggable ? 1 : 0);
      if (draggable) {
        expect(postMessage).toHaveBeenCalledWith({ type: "window-drag" });
      }
      expect(event.defaultPrevented, selector).toBe(draggable);
    }

    const dockButton = Array.from(
      panel.querySelectorAll<HTMLButtonElement>(".assistant-panel-actions button"),
    ).find((button) => button.getAttribute("aria-label")?.startsWith("Dock"));
    dockButton!.click();
    await panel.updateComplete;
    expect(
      panel.querySelector(`.assistant-panel--${dock === "right" ? "bottom" : "right"}`),
    ).not.toBeNull();
  });

  it("ignores toggle requests while unavailable", async () => {
    const { panel } = await mountPanel();
    panel.homeAvailable = false;
    await panel.updateComplete;

    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
    await panel.updateComplete;

    expect(panel.assistantPanelOpen).toBe(false);
  });
});
