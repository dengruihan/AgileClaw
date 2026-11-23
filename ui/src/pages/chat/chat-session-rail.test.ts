/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SideConversationSummary } from "../../lib/chat/side-conversations.ts";
import {
  ChatSessionCompanionThreads,
  requestSessionCompanionAnswer,
  requestSessionCompanionState,
  resetSessionCompanion,
} from "./chat-session-companion.ts";
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

describe("ChatSessionCompanionThreads", () => {
  it("uses the exact companion RPC methods and payloads", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.companion.ask") {
        return { answer: "Answer", ts: 1 };
      }
      if (method === "sessions.companion.state") {
        return { exchanges: [] };
      }
      return { ok: true as const };
    });
    const client = { request: request as GatewayBrowserClient["request"] };

    await requestSessionCompanionAnswer(client, "one", "Question", "work");
    await requestSessionCompanionState(client, "one", "work");
    await resetSessionCompanion(client, "one", "work");

    expect(request.mock.calls).toEqual([
      [
        "sessions.companion.ask",
        { sessionKey: "one", agentId: "work", question: "Question" },
        { timeoutMs: 70_000 },
      ],
      ["sessions.companion.state", { sessionKey: "one", agentId: "work" }],
      ["sessions.companion.reset", { sessionKey: "one", agentId: "work" }],
    ]);
  });

  it("sends a full selected passage as context, not an unsupported file", async () => {
    const selectedText = "Full selected passage " + "x".repeat(2_000);
    const request = vi.fn(async (_method: string, _params: unknown) => ({
      answer: "Answer",
      ts: 1,
    }));
    const client = { request: request as GatewayBrowserClient["request"] };
    await requestSessionCompanionAnswer(client, "one", "Regarding the selection", "work", [
      {
        id: "comment",
        mimeType: "text/plain",
        selectionAnnotation: {
          text: selectedText,
          comment: "Why does this matter?",
          sessionKey: "one",
          start: 2,
          end: selectedText.length + 2,
        },
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      "sessions.companion.ask",
      {
        sessionKey: "one",
        agentId: "work",
        question: "Regarding the selection",
        selectionContext: expect.stringContaining("User comment:\nWhy does this matter?"),
      },
      { timeoutMs: 70_000 },
    );
    expect(request.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        selectionContext: expect.stringContaining(`Selected text:\n${selectedText}`),
      }),
    );
  });

  it("hydrates and retains independent per-session threads", async () => {
    const threads = new ChatSessionCompanionThreads();
    const load = vi.fn(async (sessionKey: string) => ({
      exchanges: [
        {
          question: `Question for ${sessionKey}`,
          answer: `Answer for ${sessionKey}`,
          ts: sessionKey === "one" ? 1 : 2,
        },
      ],
    }));

    await threads.hydrate("one", load);
    await threads.hydrate("two", load);

    expect(threads.view("one").turns).toMatchObject([
      { question: "Question for one", status: "answered", answer: "Answer for one", ts: 1 },
    ]);
    expect(threads.view("two").turns).toMatchObject([
      { question: "Question for two", status: "answered", answer: "Answer for two", ts: 2 },
    ]);
  });

  it("records hydration until the authoritative companion state settles", async () => {
    let resolveLoad!: (value: { exchanges: [] }) => void;
    const threads = new ChatSessionCompanionThreads();
    const pending = threads.hydrate(
      "one",
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    );

    expect(threads.view("one").loading).toBe(true);
    resolveLoad({ exchanges: [] });
    await pending;
    expect(threads.view("one").loading).toBe(false);
  });

  it("keeps matching bare session keys isolated by agent", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("global", "main draft", "main");
    threads.setDraft("global", "work draft", "work");

    expect(threads.view("global", "main").draft).toBe("main draft");
    expect(threads.view("global", "work").draft).toBe("work draft");
  });

  it("moves a composer submission through pending to a timestamped answer", async () => {
    let resolveAnswer!: (value: { answer: string; ts: number }) => void;
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "Why is it rerunning that test?");
    const pending = threads.submit(
      "one",
      threads.view("one").draft,
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );

    expect(threads.view("one").turns).toMatchObject([
      { question: "Why is it rerunning that test?", status: "pending" },
    ]);
    expect(threads.view("one").draft).toBe("");
    resolveAnswer({ answer: "It is verifying the focused regression.", ts: 42 });
    await pending;

    expect(threads.view("one")).toMatchObject({
      turns: [
        {
          question: "Why is it rerunning that test?",
          status: "answered",
          answer: "It is verifying the focused regression.",
          ts: 42,
        },
      ],
    });
  });

  it("maps the typed busy error to the rail hint", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "Is it stuck?", async () => {
      throw Object.assign(new Error("busy"), {
        details: { code: "SESSION_COMPANION_BUSY" },
        retryable: true,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      { question: "Is it stuck?", status: "failed", hint: "busy", retryable: true },
    ]);
  });

  it("preserves a context failure for an explicit retry", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error("history unavailable"), {
        details: { reason: "context-unavailable" },
        retryable: true,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "failed", hint: "history-unavailable", retryable: true },
    ]);
    await threads.hydrate("one", async () => ({ exchanges: [] }));
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "failed", hint: "history-unavailable", retryable: true },
    ]);
  });

  it.each([
    { reason: "rate-limited", retryable: true, hint: "rate-limited" },
    { reason: "utility-model-unavailable", retryable: false, hint: "model-unavailable" },
    { reason: "unavailable", retryable: false, hint: "unavailable" },
  ] as const)("maps $reason to its specific retry state", async (expected) => {
    const threads = new ChatSessionCompanionThreads();
    await threads.submit("one", "What changed?", async () => {
      throw Object.assign(new Error(expected.reason), {
        details: { reason: expected.reason },
        retryable: expected.retryable,
      });
    });

    expect(threads.view("one").turns).toMatchObject([
      {
        question: "What changed?",
        status: "failed",
        hint: expected.hint,
        retryable: expected.retryable,
      },
    ]);
  });

  it("hydrates only a newly committed repeated question after a lost response", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    await threads.submit("one", "What changed?", async () => {
      throw new Error("socket closed");
    });
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "failed", hint: "unavailable", retryable: true },
    ]);

    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "What changed?", answer: "Earlier answer.", ts: 1 }],
    }));
    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "failed", hint: "unavailable", retryable: true },
    ]);

    await threads.hydrate("one", async () => ({
      exchanges: [
        { question: "What changed?", answer: "Earlier answer.", ts: 1 },
        { question: "What changed?", answer: "The fix committed.", ts: 4 },
      ],
    }));

    expect(threads.view("one").turns).toMatchObject([
      { question: "What changed?", status: "answered", answer: "Earlier answer.", ts: 1 },
      { question: "What changed?", status: "answered", answer: "The fix committed.", ts: 4 },
    ]);
  });

  it("clears local state only after the reset RPC succeeds", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Q", answer: "A", ts: 1 }],
    }));
    await expect(
      threads.reset("one", async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(threads.view("one").turns).toHaveLength(1);

    await threads.reset("one", async () => ({ ok: true as const }));
    expect(threads.view("one").turns).toMatchObject([]);
  });

  it("retires one session without clearing unrelated companion state", () => {
    const threads = new ChatSessionCompanionThreads();
    threads.setDraft("one", "retire me", "main");
    threads.setDraft("two", "keep me", "main");

    threads.retire("one", "main");

    expect(threads.view("one", "main").draft).toBe("");
    expect(threads.view("two", "main").draft).toBe("keep me");
  });

  it("adopts an empty restarted-Gateway thread without discarding its local draft", async () => {
    const threads = new ChatSessionCompanionThreads();
    await threads.hydrate("one", async () => ({
      exchanges: [{ question: "Before restart", answer: "Old answer", ts: 1 }],
    }));
    threads.setDraft("one", "unsent local draft");

    await threads.hydrate("one", async () => ({ exchanges: [] }));

    expect(threads.view("one")).toMatchObject({
      draft: "unsent local draft",
      turns: [],
    });
  });

  it.each(["resolve", "reject"] as const)(
    "does not resurrect a reset request after a late $outcome",
    async (outcome) => {
      let resolveAnswer!: (value: { answer: string; ts: number }) => void;
      let rejectAnswer!: (error: Error) => void;
      const threads = new ChatSessionCompanionThreads();
      const pending = threads.submit(
        "one",
        "Will reset keep this?",
        () =>
          new Promise((resolve, reject) => {
            resolveAnswer = resolve;
            rejectAnswer = reject;
          }),
      );

      await threads.reset("one", async () => ({ ok: true as const }));
      if (outcome === "resolve") {
        resolveAnswer({ answer: "late answer", ts: 5 });
      } else {
        rejectAnswer(new Error("late error"));
      }
      await pending;

      expect(threads.view("one").turns).toMatchObject([]);
    },
  );
});

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
