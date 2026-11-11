/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import {
  chatRevealBufferForPane,
  type ChatRevealBuffer,
} from "./components/chat-message-reveal-buffer.ts";

// Platform-boundary stubs keep reveal scheduling observable without a browser.
let pendingFrames = 0;
let nextFrame = 0;
const queuedFrames = new Map<number, FrameRequestCallback>();

function installRevealPlatform() {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pendingFrames += 1;
    const id = ++nextFrame;
    queuedFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    if (queuedFrames.delete(id)) {
      pendingFrames -= 1;
    }
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  pendingFrames = 0;
  queuedFrames.clear();
  installRevealPlatform();
});

afterEach(() => {
  vi.unstubAllGlobals();
  pendingFrames = 0;
  queuedFrames.clear();
});

function createRevealingPane(paneId: string) {
  const { pane } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
  });
  (pane as unknown as { paneId: string }).paneId = paneId;
  // The progress controller reads the presentation setting during visibility handling.
  (pane.state as unknown as { settings: Record<string, unknown> }).settings = {
    chatShowTaskProgress: false,
  };
  const buffer = chatRevealBufferForPane(paneId);
  for (const _ of [0, 1]) {
    buffer.beginPass({
      sessionKey: "agent:main:current",
      connectionEpoch: pane.connectionGeneration,
      runId: "reveal-run",
      live: true,
      historySettled: true,
      scheduleUpdate: () => {},
    });
  }
  buffer.noteLiveStream("reveal-run", "live");
  buffer.visibleText({
    key: "live",
    runId: "reveal-run",
    text: "A pane reply that keeps arriving while the lifecycle changes.",
    streaming: true,
  });
  expect(pendingFrames).toBe(1);
  return { pane, buffer };
}

function settleRun(buffer: ChatRevealBuffer) {
  buffer.focusTail(
    { kind: "group", key: "group:assistant:final", role: "assistant", messages: [] },
    "reveal-run",
  );
  buffer.beginPass({
    sessionKey: "agent:main:current",
    runId: "reveal-run",
    live: false,
    historySettled: true,
    scheduleUpdate: () => {},
  });
  const final = buffer.visibleText({
    key: "final",
    runId: "reveal-run",
    text: "A pane reply that keeps arriving while the lifecycle changes. Done.",
    streaming: false,
    liveTail: true,
  });
  expect(final.revealing).toBe(true);
  expect(pendingFrames).toBe(1);
}

it("disposes reveal work on pane teardown without waiting for another projection", () => {
  const { pane, buffer } = createRevealingPane("pane-teardown");
  pane.disconnectedCallback();
  expect(pendingFrames).toBe(0);
  expect(buffer.versionForRun("reveal-run")).toBe(0);
  expect(chatRevealBufferForPane("pane-teardown")).not.toBe(buffer);
});

// Registers the real base visibility handler without a full Lit mount: the
// update cycle needs app settings this harness does not model.
function attachVisibilityOwner(pane: TestPane) {
  const host = pane as unknown as {
    requestUpdate: () => void;
    performUpdate: () => void;
    progressCard: { hostUpdate: () => void };
  };
  host.requestUpdate = () => {};
  // This harness asserts reveal cleanup, not pane rendering.
  host.performUpdate = () => {};
  // Progress polling needs app settings this harness does not mount.
  host.progressCard.hostUpdate = () => {};
  ChatPaneBase.prototype.connectedCallback.call(pane as never);
  return () => ChatPaneBase.prototype.disconnectedCallback.call(pane as never);
}

type TestPane = ReturnType<typeof createTestChatPane>["pane"];

it("cancels reveal work when the browser document hides", () => {
  const { pane, buffer } = createRevealingPane("pane-document-hidden");
  const detach = attachVisibilityOwner(pane);
  try {
    expect(pendingFrames).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pendingFrames).toBe(0);
    expect(buffer.versionForRun("reveal-run")).toBe(0);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
    detach();
  }
});

it("cancels reveal work when the conversation slot stops being visible", () => {
  const { pane, buffer } = createRevealingPane("pane-conversation-hidden");
  (
    pane as unknown as { setConversationVisible: (visible: boolean) => void }
  ).setConversationVisible(false);
  expect(pendingFrames).toBe(0);
  expect(buffer.versionForRun("reveal-run")).toBe(0);
});

it("cancels reveal work when the pane stops being presented or visible", () => {
  const { pane, buffer } = createRevealingPane("pane-presented");
  pane.presented = false;
  expect(pendingFrames).toBe(0);
  expect(buffer.versionForRun("reveal-run")).toBe(0);
  expect(chatRevealBufferForPane("pane-presented")).toBe(buffer);

  for (const _ of [0, 1]) {
    buffer.beginPass({
      sessionKey: "agent:main:current",
      runId: "reveal-run",
      live: true,
      historySettled: true,
      scheduleUpdate: () => {},
    });
  }
  buffer.visibleText({
    key: "live",
    runId: "reveal-run",
    text: "Second attempt after re-presenting the pane.",
    streaming: true,
  });
  expect(pendingFrames).toBe(1);
  pane.visuallyPresented = false;
  expect(pendingFrames).toBe(0);
  expect(buffer.versionForRun("reveal-run")).toBe(0);
});

it("cancels reveal work on gateway disconnect but keeps an ordinary settled drain", () => {
  const { pane, buffer } = createRevealingPane("pane-disconnect");
  settleRun(buffer);
  // A connected snapshot is an ordinary same-connection pass: the settled drain lives.
  pane.handleGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "connected" });
  expect(pendingFrames).toBe(1);
  // A gateway disconnect cancels at once, without a later projection.
  pane.handleGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    phase: "reconnecting",
    hello: null,
  });
  expect(pendingFrames).toBe(0);
  expect(buffer.versionForRun("reveal-run")).toBe(0);
});
