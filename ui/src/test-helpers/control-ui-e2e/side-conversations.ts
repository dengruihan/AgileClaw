// Serialized into the page realm with installControlUiMockGateway; keep it free of module captures.
import type { SideConversationSummary } from "@openclaw/gateway-protocol";
import type { ControlUiSessionFixture } from "../control-ui-session-fixtures.ts";

export type SideConversationMockReply = { matched: false } | { matched: true; reply: unknown };

/**
 * Parent-owned side-conversation registry for the mock Gateway. Create, list,
 * and lifecycle round-trips mutate the same membership a real Gateway owns, and
 * sessionStorage keeps created children resolvable across a page reload.
 */
export function createControlUiMockSideConversations(input: {
  conversations: SideConversationSummary[];
  defaultAgentId: string;
  addSession: (key: string, row: ControlUiSessionFixture) => void;
  isRecord: (value: unknown) => value is Record<string, unknown>;
}) {
  const { addSession, defaultAgentId, isRecord } = input;
  const stateKey = "openclaw.control-ui-e2e.side-conversations.v1";
  let conversations = [...input.conversations];
  let sequence = 0;
  try {
    const stored = window.sessionStorage.getItem(stateKey);
    const parsed = stored ? (JSON.parse(stored) as unknown) : null;
    if (Array.isArray(parsed)) {
      conversations = parsed as SideConversationSummary[];
      sequence = conversations.length;
    }
  } catch {
    // The scenario registry remains authoritative without browser storage.
  }
  const persist = () => {
    try {
      window.sessionStorage.setItem(stateKey, JSON.stringify(conversations));
    } catch {
      // Current-document transitions still apply.
    }
  };
  const row = (summary: SideConversationSummary): ControlUiSessionFixture => ({
    key: summary.sessionKey,
    displayName: summary.title ?? `Side chat ${summary.ordinal}`,
    kind: "direct",
    model: summary.model ?? "gpt-5.5",
    modelProvider: summary.modelProvider ?? "openai",
    modelOverrideSource: "inherited",
    updatedAt: summary.updatedAt,
    sideConversation: {
      parentSessionKey: summary.parentSessionKey,
      intentId: summary.intentId,
      ordinal: summary.ordinal,
      state: summary.state,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
  });
  // Hidden children store exact rows without joining list membership.
  for (const summary of conversations) {
    addSession(summary.sessionKey, row(summary));
  }
  const byKey = (sessionKey: unknown) =>
    typeof sessionKey === "string"
      ? conversations.find((conversation) => conversation.sessionKey === sessionKey)
      : undefined;
  const scope = (params: unknown) => {
    const parentSessionKey =
      isRecord(params) && typeof params.parentSessionKey === "string"
        ? params.parentSessionKey.trim()
        : "";
    const agentId =
      isRecord(params) && typeof params.agentId === "string" ? params.agentId.trim() : "";
    return { parentSessionKey, agentId };
  };
  const create = (params: unknown) => {
    const { parentSessionKey, agentId } = scope(params);
    const intentId =
      isRecord(params) && typeof params.intentId === "string" ? params.intentId.trim() : "";
    if (!parentSessionKey || !intentId) {
      return { __mockError: { code: "INVALID_REQUEST", message: "side conversation target" } };
    }
    const existing = conversations.find(
      (conversation) =>
        conversation.parentSessionKey === parentSessionKey && conversation.intentId === intentId,
    );
    if (existing) {
      return { ok: true, created: false, conversation: existing };
    }
    const parentAgentId = agentId || parentSessionKey.split(":")[1] || defaultAgentId;
    const ordinal =
      Math.max(
        0,
        ...conversations
          .filter((conversation) => conversation.parentSessionKey === parentSessionKey)
          .map((conversation) => conversation.ordinal),
      ) + 1;
    const digest = (++sequence).toString(16).padStart(32, "0");
    const sessionKey = `agent:${parentAgentId}:dashboard:side-${digest}`;
    const now = Date.now();
    const summary: SideConversationSummary = {
      sessionKey,
      sessionId: `session:${sessionKey}`,
      parentSessionKey,
      intentId,
      ordinal,
      state: "open",
      createdAt: now,
      updatedAt: now,
      isolation: { filesystem: "worktree", externalState: "shared" },
      worktree: {
        id: `wt-${digest.slice(-8)}`,
        branch: `side/${digest.slice(-8)}`,
        path: `/mock/worktrees/${digest.slice(-8)}`,
        baseRef: "mock-base",
      },
    };
    conversations.push(summary);
    addSession(sessionKey, row(summary));
    persist();
    return { ok: true, created: true, conversation: summary };
  };
  const transition = (params: unknown, nextState: SideConversationSummary["state"]) => {
    const conversation = byKey(isRecord(params) ? params.sessionKey : undefined);
    if (!conversation) {
      return { __mockError: { code: "NOT_FOUND", message: "side conversation not found" } };
    }
    const now = Date.now();
    Object.assign(conversation, {
      state: nextState,
      updatedAt: now,
      ...(nextState === "closed" ? { closedAt: now } : {}),
    });
    if (nextState === "open") {
      delete conversation.closedAt;
    }
    persist();
    return { ok: true, conversation };
  };
  return {
    handle(method: string, params: unknown): SideConversationMockReply {
      switch (method) {
        case "sideConversations.list": {
          const { parentSessionKey } = scope(params);
          const state =
            isRecord(params) && typeof params.state === "string" ? params.state : undefined;
          return {
            matched: true,
            reply: {
              ok: true,
              parentSessionKey,
              sideConversations: conversations.filter(
                (conversation) =>
                  conversation.parentSessionKey === parentSessionKey &&
                  (state === undefined || conversation.state === state),
              ),
            },
          };
        }
        case "sideConversations.create":
          return { matched: true, reply: create(params) };
        case "sideConversations.close":
          return { matched: true, reply: transition(params, "closed") };
        case "sideConversations.reopen":
          return { matched: true, reply: transition(params, "open") };
        case "sideConversations.abandon":
          return { matched: true, reply: transition(params, "abandoned") };
        case "sideConversations.merge": {
          const result = transition(params, "merged");
          return {
            matched: true,
            reply:
              "ok" in result
                ? { ...result, alreadyMerged: false, mergeCommit: "mock-merge-commit" }
                : result,
          };
        }
        default:
          return { matched: false };
      }
    },
  };
}
