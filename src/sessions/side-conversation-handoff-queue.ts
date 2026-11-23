/**
 * Pure stored-queue helpers for side-conversation handoffs.
 *
 * The parent session entry owns one bounded, monotonically sequenced queue of
 * closed side conversations. This module only reads, bounds, and renders that
 * shape so hot row projection never imports the Git/DB owner.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  InternalSessionEntry,
  SideConversationHandoffFacts,
  SideConversationHandoffNotice,
  SideConversationHandoffQueue,
} from "../config/sessions/types.js";
import { truncateUtf16Safe } from "../utils.js";

/** Reminders in one model-only block stay bounded; the newest are kept. */
export const SIDE_CONVERSATION_HANDOFF_MAX_PENDING = 8;

/** Stored counts stay small; the rendered reminder shows `N+` at the cap. */
const HANDOFF_COUNT_CAP = 100;

const MAX_TITLE_CHARS = 80;
const MAX_BRANCH_CHARS = 120;
const MAX_PATH_CHARS = 300;
const MAX_BASE_REF_CHARS = 120;

type QueueOwnerEntry = Pick<InternalSessionEntry, "sideConversationHandoffs">;

export function emptySideConversationHandoffQueue(): SideConversationHandoffQueue {
  return { version: 1, nextSequence: 1, pending: [] };
}

function isHandoffFacts(value: unknown): value is SideConversationHandoffFacts {
  if (!isRecord(value)) {
    return false;
  }
  const optionalString = (field: unknown) => field === undefined || typeof field === "string";
  const optionalCount = (field: unknown) =>
    field === undefined || (typeof field === "number" && Number.isFinite(field) && field >= 0);
  return (
    optionalString(value.branch) &&
    optionalString(value.path) &&
    optionalString(value.baseRef) &&
    optionalString(value.headCommit) &&
    optionalCount(value.changedFiles) &&
    optionalCount(value.commitsAhead)
  );
}

function isHandoffNotice(value: unknown): value is SideConversationHandoffNotice {
  return (
    isRecord(value) &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    typeof value.intentId === "string" &&
    value.intentId.length > 0 &&
    typeof value.ordinal === "number" &&
    Number.isInteger(value.ordinal) &&
    value.ordinal >= 1 &&
    typeof value.closedAt === "number" &&
    Number.isFinite(value.closedAt) &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.worktree === undefined || isHandoffFacts(value.worktree))
  );
}

/** Read defensively: legacy or partially written shapes fall back to empty. */
export function readSideConversationHandoffQueue(
  entry: QueueOwnerEntry | undefined,
): SideConversationHandoffQueue {
  const stored = entry?.sideConversationHandoffs;
  if (
    !stored ||
    stored.version !== 1 ||
    !Number.isInteger(stored.nextSequence) ||
    stored.nextSequence < 1 ||
    !Array.isArray(stored.pending)
  ) {
    return emptySideConversationHandoffQueue();
  }
  const pending = stored.pending.filter(isHandoffNotice);
  return {
    version: 1,
    nextSequence: stored.nextSequence,
    pending,
    ...(typeof stored.droppedCount === "number" &&
    Number.isInteger(stored.droppedCount) &&
    stored.droppedCount > 0
      ? { droppedCount: stored.droppedCount }
      : {}),
  };
}

/** Pending reminders only; delivered and evicted notices never count. */
export function resolveSideConversationHandoffCount(entry: QueueOwnerEntry | undefined): number {
  return readSideConversationHandoffQueue(entry).pending.length;
}

/**
 * Append one notice, replacing any pending notice for the same intent and
 * evicting the oldest entries beyond the cap.
 */
export function appendSideConversationHandoffNotice(
  queue: SideConversationHandoffQueue,
  notice: SideConversationHandoffNotice,
): SideConversationHandoffQueue {
  const others = queue.pending.filter((pending) => pending.intentId !== notice.intentId);
  const merged = [...others, notice];
  const overflow = Math.max(0, merged.length - SIDE_CONVERSATION_HANDOFF_MAX_PENDING);
  const dropped = queue.droppedCount ?? 0;
  return {
    version: 1,
    nextSequence: Math.max(queue.nextSequence, notice.sequence + 1),
    pending: merged.slice(overflow),
    ...(dropped + overflow > 0 ? { droppedCount: dropped + overflow } : {}),
  };
}

function removePending(
  queue: SideConversationHandoffQueue,
  shouldRemove: (notice: SideConversationHandoffNotice) => boolean,
): SideConversationHandoffQueue {
  const pending = queue.pending.filter((notice) => !shouldRemove(notice));
  if (pending.length === queue.pending.length) {
    return queue;
  }
  return { ...queue, pending };
}

/** Delivery removes exactly the notices that the dispatched prompt carried. */
export function removeSideConversationHandoffNotices(
  queue: SideConversationHandoffQueue,
  sequences: readonly number[],
): SideConversationHandoffQueue {
  const claimed = new Set(sequences);
  return removePending(queue, (notice) => claimed.has(notice.sequence));
}

/** Reopen cancels only the still-pending notices of that exact child. */
export function cancelSideConversationHandoffNotices(
  queue: SideConversationHandoffQueue,
  intentId: string,
): SideConversationHandoffQueue {
  return removePending(queue, (notice) => notice.intentId === intentId);
}

function boundedValue(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateUtf16Safe(trimmed, maxChars);
}

function renderCount(value: number): string {
  return value >= HANDOFF_COUNT_CAP ? `${HANDOFF_COUNT_CAP}+` : String(value);
}

function renderFacts(facts: SideConversationHandoffFacts | undefined): string {
  const parts: string[] = [];
  if (facts?.commitsAhead !== undefined) {
    const commits = facts.commitsAhead === 0 ? "no new commits" : renderCount(facts.commitsAhead);
    parts.push(
      facts.commitsAhead > 0
        ? `${commits} ahead${facts.baseRef ? ` of ${boundedValue(facts.baseRef, MAX_BASE_REF_CHARS)}` : ""}`
        : commits,
    );
  }
  if (facts?.changedFiles !== undefined) {
    parts.push(
      facts.changedFiles === 0
        ? "no uncommitted files"
        : `${renderCount(facts.changedFiles)} uncommitted ${
            facts.changedFiles === 1 ? "file" : "files"
          }`,
    );
  }
  if (facts?.headCommit) {
    parts.push(`head ${boundedValue(facts.headCommit, 40)}`);
  }
  return parts.length > 0 ? `facts: ${parts.join(", ")}` : "facts: edits not inspected";
}

/**
 * Fixed-format model-only reminder for the batch.
 *
 * It restates the close-time facts only; it never claims the branch still needs
 * merging and never asks the model to act without the user's request.
 */
export function formatSideConversationHandoffPrompt(
  queue: SideConversationHandoffQueue,
): string | undefined {
  const notices = queue.pending;
  if (notices.length === 0) {
    return undefined;
  }
  const lines = [
    `[Side conversation handoff] ${notices.length === 1 ? "1 side conversation was" : `${notices.length} side conversations were`} closed with changes in their own checkouts. This is context for the user's message only: do not merge, abandon, reopen, or start a run on your own. If the user's request depends on that work, mention what is pending and ask how to proceed.`,
  ];
  for (const [index, notice] of notices.entries()) {
    const title = boundedValue(notice.title, MAX_TITLE_CHARS);
    lines.push(
      `${index + 1}. ${title ? `"${title}"` : notice.sessionKey} (closed ${new Date(notice.closedAt).toISOString()})`,
    );
    const branch = boundedValue(notice.worktree?.branch, MAX_BRANCH_CHARS);
    if (branch) {
      lines.push(`   branch: ${branch}`);
    }
    const checkoutPath = boundedValue(notice.worktree?.path, MAX_PATH_CHARS);
    if (checkoutPath) {
      lines.push(`   path: ${checkoutPath}`);
    }
    lines.push(`   ${renderFacts(notice.worktree)}`);
  }
  if (queue.droppedCount) {
    lines.push(
      `${queue.droppedCount} earlier closed side conversation${queue.droppedCount === 1 ? "" : "s"} had pending handoffs that this reminder omits; list them with sideConversations.list only if the user asks.`,
    );
  }
  return lines.join("\n");
}
