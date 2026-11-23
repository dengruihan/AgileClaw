import type {
  SideConversationSummary,
  SideConversationsAbandonParams,
  SideConversationsCloseParams,
  SideConversationsCreateParams,
  SideConversationsCreateResult,
  SideConversationsListParams,
  SideConversationsListResult,
  SideConversationsMergeParams,
  SideConversationsMergeResult,
  SideConversationsReopenParams,
  SideConversationsTransitionResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { generateUUID } from "../uuid.ts";

/**
 * Side conversations are persistent hidden children of one parent session.
 * Their keys are Gateway-owned: `agent:<agent>:dashboard:side-<sha256[0..32]>`.
 * A child never appears in a roster, so the exact key is the only identity a
 * Control UI pane can hold.
 */
const SIDE_CONVERSATION_CHILD_KEY_RE = /^agent:[^:]+:dashboard:side-[0-9a-f]{32}$/;

/** Side conversations own a worktree lifecycle, so creation and merge may take a while. */
const SIDE_CONVERSATION_LONG_REQUEST_TIMEOUT_MS = 60_000;

export type {
  SideConversationIsolation,
  SideConversationSnapshotFacts,
  SideConversationState,
  SideConversationSummary,
  SideConversationWorktreeFact,
  SideConversationWorktreeSkipReason,
  SideConversationsListResult,
  SideConversationsMergeResult,
  SideConversationsTransitionResult,
} from "../../../../packages/gateway-protocol/src/index.js";

export function isSideConversationSessionKey(sessionKey: string | null | undefined): boolean {
  return Boolean(sessionKey && SIDE_CONVERSATION_CHILD_KEY_RE.test(sessionKey.trim()));
}

/**
 * Caller-owned idempotency key for one user action. Control UI creates a fresh
 * key per submit; its in-flight guard, not a key retry, prevents a second child.
 */
export function sideConversationIntentId(): string {
  return `ui-${generateUUID()}`;
}

export function requestSideConversationCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsCreateParams,
): Promise<SideConversationsCreateResult> {
  return client.request<SideConversationsCreateResult>("sideConversations.create", params, {
    timeoutMs: SIDE_CONVERSATION_LONG_REQUEST_TIMEOUT_MS,
  });
}

export function requestSideConversationList(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsListParams,
): Promise<SideConversationsListResult> {
  return client.request<SideConversationsListResult>("sideConversations.list", params);
}

export function requestSideConversationClose(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsCloseParams,
): Promise<SideConversationsTransitionResult> {
  return client.request<SideConversationsTransitionResult>("sideConversations.close", params);
}

export function requestSideConversationReopen(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsReopenParams,
): Promise<SideConversationsTransitionResult> {
  return client.request<SideConversationsTransitionResult>("sideConversations.reopen", params);
}

export function requestSideConversationMerge(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsMergeParams,
): Promise<SideConversationsMergeResult> {
  return client.request<SideConversationsMergeResult>("sideConversations.merge", params, {
    timeoutMs: SIDE_CONVERSATION_LONG_REQUEST_TIMEOUT_MS,
  });
}

export function requestSideConversationAbandon(
  client: Pick<GatewayBrowserClient, "request">,
  params: SideConversationsAbandonParams,
): Promise<SideConversationsTransitionResult> {
  return client.request<SideConversationsTransitionResult>("sideConversations.abandon", params);
}

/** Open conversations stay ahead of transitioned ones; identity breaks ties for determinism. */
export function sortSideConversations(
  conversations: readonly SideConversationSummary[],
): SideConversationSummary[] {
  const rank = (state: SideConversationSummary["state"]) =>
    state === "open" ? 0 : state === "closed" ? 1 : 2;
  return conversations.toSorted(
    (left, right) =>
      rank(left.state) - rank(right.state) ||
      right.updatedAt - left.updatedAt ||
      left.ordinal - right.ordinal,
  );
}

/** The most recently closed child; chip cancellation reopens one conversation at a time. */
export function latestClosedSideConversation(
  conversations: readonly SideConversationSummary[],
): SideConversationSummary | undefined {
  return conversations
    .filter((conversation) => conversation.state === "closed")
    .toSorted((left, right) => (right.closedAt ?? 0) - (left.closedAt ?? 0))[0];
}
