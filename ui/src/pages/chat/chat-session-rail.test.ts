/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SideConversationSummary } from "../../lib/chat/side-conversations.ts";
import { ChatSessionRailElement } from "./components/chat-session-rail.ts";
import type { SideConversationsView } from "./side-conversations-controller.ts";

function digest(health: SessionObserverDigest["health"] = "on-track"): SessionObserverDigest {
  return {
    sessionKey: "agent:main:run",
    runId: "run-1",
    revision: 1,
    updatedAt: 300_000,
    headline: "Reviewing the implementation",
    health,
  };
}

function conversation(
  overrides: Partial<SideConversationSummary> & { sessionKey?: string } = {},
): SideConversationSummary {
  return {
    sessionKey: "agent:main:dashboard:side-0123456789abcdef0123456789abcdef",
    parentSessionKey: "agent:main:run",
    intentId: "intent-1",
    ordinal: 1,
    state: "open",
    createdAt: 300_000,
    updatedAt: 300_000,
    isolation: { filesystem: "worktree", externalState: "shared" },
    worktree: {
      id: "wt-1",
      branch: "side/intent-1",
      path: "/tmp/wt-1",
      baseRef: "abc123",
    },
    ...overrides,
  };
}

function view(overrides: Partial<SideConversationsView> = {}): SideConversationsView {
  return {
    parentSessionKey: "agent:main:run",
    loading: false,
    error: null,
    conversations: [conversation()],
    cleanupPendingCount: 0,
    pendingSessionKeys: new Set(),
    notices: new Map(),
    ...overrides,
  };
}

describe("ChatSessionRailElement", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(600_000);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(overrides: Partial<ChatSessionRailElement> = {}) {
    const element = document.createElement("openclaw-chat-session-rail") as ChatSessionRailElement;
    element.sessionKey = "agent:main:run";
    element.digest = digest();
    element.running = true;
    element.activeRunId = "run-1";
    element.connected = true;
    element.sideConversations = view();
    Object.assign(element, overrides);
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it("renders the shared surface empty state before any side conversation", async () => {
    const element = await mount({ sideConversations: view({ conversations: [] }) });
    const empty = element.querySelector("openclaw-panel-empty-state");
    await empty?.updateComplete;

    expect(empty?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe("Side chat");
    expect(empty?.querySelector("svg")).not.toBeNull();
  });

  it("lists each side conversation with its state, worktree, and update time", async () => {
    const element = await mount({
      sideConversations: view({
        conversations: [
          conversation(),
          conversation({
            sessionKey: "agent:main:dashboard:side-fedcba9876543210fedcba9876543210",
            ordinal: 2,
            state: "closed",
            title: "Release notes",
            worktree: undefined,
            worktreeSkipped: "not-git",
          }),
        ],
      }),
    });

    const rows = [...element.querySelectorAll(".chat-session-rail__conversation")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".chat-session-rail__state")?.textContent?.trim()).toBe("Open");
    expect(rows[0]?.querySelector(".chat-session-rail__worktree")?.textContent).toContain(
      "side/intent-1",
    );
    expect(rows[1]?.querySelector(".chat-session-rail__conversation-title")?.textContent).toBe(
      "Release notes",
    );
    expect(rows[1]?.querySelector(".chat-session-rail__state")?.textContent?.trim()).toBe("Closed");
    expect(rows[1]?.querySelector(".chat-session-rail__worktree")?.textContent).toContain(
      "Not a Git workspace",
    );
    expect(rows[1]?.querySelector(".chat-session-rail__timestamp")?.textContent).toContain(
      "Updated",
    );
    expect(element.querySelector(".chat-session-rail__starter")).toBeNull();
  });

  it("opens a conversation from its row and only offers valid lifecycle actions", async () => {
    const onOpenConversation = vi.fn();
    const onCloseConversation = vi.fn();
    const onReopenConversation = vi.fn();
    const onMergeConversation = vi.fn();
    const onAbandonConversation = vi.fn();
    const element = await mount({
      onOpenConversation,
      onCloseConversation,
      onReopenConversation,
      onMergeConversation,
      onAbandonConversation,
    });

    (element.querySelector(".chat-session-rail__conversation-main") as HTMLButtonElement).click();
    expect(onOpenConversation).toHaveBeenCalledOnce();
    const buttons = [
      ...element.querySelectorAll(".chat-session-rail__conversation-actions button"),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Close",
      "Merge",
      "Abandon",
    ]);
    (buttons[0] as HTMLButtonElement).click();
    expect(onCloseConversation).toHaveBeenCalledOnce();
    expect(onReopenConversation).not.toHaveBeenCalled();

    element.sideConversations = view({
      conversations: [conversation({ state: "closed" })],
    });
    await element.updateComplete;
    const actions = element.querySelectorAll(".chat-session-rail__conversation-actions button");
    expect(actions[0]?.textContent?.trim()).toBe("Reopen");
    (actions[0] as HTMLButtonElement).click();
    expect(onReopenConversation).toHaveBeenCalledOnce();
    expect(element.querySelector(".chat-session-rail__conversation-actions button")).not.toBeNull();
  });

  it("shows merge outcomes and preserved failures on the row", async () => {
    const element = await mount({
      sideConversations: view({
        notices: new Map([
          [conversation().sessionKey, "already-merged"],
          [
            "agent:main:dashboard:side-fedcba9876543210fedcba9876543210",
            "Merge conflict in app.ts",
          ],
        ]),
        conversations: [
          conversation(),
          conversation({
            sessionKey: "agent:main:dashboard:side-fedcba9876543210fedcba9876543210",
            ordinal: 2,
          }),
        ],
      }),
    });
    const notices = [...element.querySelectorAll(".chat-session-rail__notice")];
    expect(notices.map((notice) => notice.textContent?.trim())).toEqual([
      "This branch was already merged.",
      "Merge conflict in app.ts",
    ]);
  });

  it("submits the rail composer to the side-conversation entry", async () => {
    const onSubmit = vi.fn();
    const element = await mount({ onSubmit, draft: "What should I verify?" });

    element.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("What should I verify?");
    expect(element.querySelector("textarea")?.value).toBe("What should I verify?");
  });

  it("uses an empty-question fallback only for images", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      attachments: [{ id: "image", mimeType: "image/png" }],
    });
    expect(element.querySelector<HTMLButtonElement>(".chat-send-btn")?.disabled).toBe(false);
    (element.querySelector(".chat-send-btn") as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("What does this image show?");
  });

  it("disables submit for a text-only attachment without a question", async () => {
    const element = await mount({
      attachments: [
        {
          id: "comment",
          mimeType: "text/plain",
          selectionAnnotation: {
            text: "Selected text",
            comment: "Explain this",
            sessionKey: "agent:main:run",
            start: 0,
            end: 13,
          },
        },
      ],
    });
    expect(element.querySelector<HTMLButtonElement>(".chat-send-btn")?.disabled).toBe(true);
  });

  it("shows the shared chat skeleton while the registry loads", async () => {
    const element = await mount({
      sideConversations: view({ loading: true, conversations: [] }),
    });
    const skeleton = element.querySelector("openclaw-panel-loading-skeleton");
    await skeleton?.updateComplete;
    expect(skeleton?.getAttribute("data-panel-skeleton")).toBe("chat");
    expect(element.querySelector("openclaw-panel-empty-state")).toBeNull();
  });

  it("offers starter questions only when no side conversation exists", async () => {
    const onSubmit = vi.fn();
    const element = await mount({
      onSubmit,
      sideConversations: view({ conversations: [] }),
    });
    const starters = [...element.querySelectorAll(".chat-session-rail__starter")];
    expect(starters.map((starter) => starter.textContent?.trim())).toEqual([
      "What changed?",
      "Why did it stop?",
      "What's left?",
    ]);
    (starters[1] as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Why did it stop?");
  });
});
