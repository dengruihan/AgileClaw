/**
 * Pure stored-queue helpers for side-conversation handoffs.
 *
 * The parent session entry owns one bounded, monotonically sequenced queue of
 * closed side conversations plus at most one in-flight dispatch receipt. This
 * module only reads, bounds, transitions, and renders that shape so hot row
 * projection never imports the Git/DB owner.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  InternalSessionEntry,
  SideConversationHandoffDelivery,
  SideConversationHandoffDispatchReceipt,
  SideConversationHandoffFacts,
  SideConversationHandoffNotice,
  SideConversationHandoffQueue,
} from "../config/sessions/types.js";
import { truncateUtf16Safe } from "../utils.js";

/** Reminders in one model-only block stay bounded; the newest are kept. */
export const SIDE_CONVERSATION_HANDOFF_MAX_PENDING = 8;

/** Evicted-sequence history stays bounded; they are only ever counted. */
const SIDE_CONVERSATION_HANDOFF_MAX_DROPPED = 32;

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

function readDropped(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (sequence): sequence is number =>
      typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 1,
  );
}

function readDelivered(value: unknown): Record<string, SideConversationHandoffDelivery> {
  const delivered: Record<string, SideConversationHandoffDelivery> = {};
  if (!isRecord(value)) {
    return delivered;
  }
  for (const [intentId, record] of Object.entries(value)) {
    if (
      isRecord(record) &&
      typeof record.sequence === "number" &&
      Number.isInteger(record.sequence) &&
      record.sequence >= 1 &&
      typeof record.closedAt === "number" &&
      Number.isFinite(record.closedAt)
    ) {
      delivered[intentId] = { sequence: record.sequence, closedAt: record.closedAt };
    }
  }
  return delivered;
}

function readDispatching(value: unknown): SideConversationHandoffDispatchReceipt | undefined {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    !value.runId ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at)
  ) {
    return undefined;
  }
  const sequences = readDropped(value.sequences);
  const droppedSequences = readDropped(value.droppedSequences);
  if (sequences.length === 0 && droppedSequences.length === 0) {
    return undefined;
  }
  return { runId: value.runId, sequences, droppedSequences, at: value.at };
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
  const dropped = readDropped(stored.dropped);
  const delivered = readDelivered(stored.delivered);
  const dispatching = readDispatching(stored.dispatching);
  return {
    version: 1,
    nextSequence: stored.nextSequence,
    pending,
    ...(dropped.length > 0 ? { dropped } : {}),
    ...(Object.keys(delivered).length > 0 ? { delivered } : {}),
    ...(dispatching ? { dispatching } : {}),
  };
}

/** Pending reminders only; delivered and evicted notices never count. */
export function resolveSideConversationHandoffCount(entry: QueueOwnerEntry | undefined): number {
  return readSideConversationHandoffQueue(entry).pending.length;
}

/**
 * Whether this close generation already has a live or delivered reminder.
 *
 * Reopen clears the delivered record, and a re-close gets a new `closedAt`, so
 * only a repeated close of the same generation reports as recorded.
 */
export function isSideConversationHandoffRecorded(
  queue: SideConversationHandoffQueue,
  params: { closedAt: number; intentId: string },
): boolean {
  if (
    queue.pending.some(
      (notice) => notice.intentId === params.intentId && notice.closedAt === params.closedAt,
    )
  ) {
    return true;
  }
  return queue.delivered?.[params.intentId]?.closedAt === params.closedAt;
}

/**
 * Append one notice, replacing any pending notice for the same intent and
 * evicting the oldest entries beyond the cap into the dropped history.
 */
export function appendSideConversationHandoffNotice(
  queue: SideConversationHandoffQueue,
  notice: SideConversationHandoffNotice,
): SideConversationHandoffQueue {
  const others = queue.pending.filter((pending) => pending.intentId !== notice.intentId);
  const merged = [...others, notice];
  const overflow = Math.max(0, merged.length - SIDE_CONVERSATION_HANDOFF_MAX_PENDING);
  const evicted = merged.slice(0, overflow).map((pending) => pending.sequence);
  const dropped = [...(queue.dropped ?? []), ...evicted];
  const delivered = queue.delivered ? { ...queue.delivered } : undefined;
  // A new close generation supersedes the intent's previous delivery record.
  if (delivered) {
    delete delivered[notice.intentId];
  }
  return {
    ...queue,
    nextSequence: Math.max(queue.nextSequence, notice.sequence + 1),
    pending: merged.slice(overflow),
    ...(dropped.length > 0
      ? { dropped: dropped.slice(-SIDE_CONVERSATION_HANDOFF_MAX_DROPPED) }
      : { dropped: undefined }),
    ...(delivered && Object.keys(delivered).length > 0 ? { delivered } : { delivered: undefined }),
  };
}

/** Reopen removes the intent's pending notice and forgets its delivery record. */
export function cancelSideConversationHandoffNotices(
  queue: SideConversationHandoffQueue,
  intentId: string,
): SideConversationHandoffQueue {
  const pending = queue.pending.filter((notice) => notice.intentId !== intentId);
  const delivered = queue.delivered ? { ...queue.delivered } : undefined;
  const hadDelivered = delivered ? Object.hasOwn(delivered, intentId) : false;
  if (delivered && hadDelivered) {
    delete delivered[intentId];
  }
  if (pending.length === queue.pending.length && !hadDelivered) {
    return queue;
  }
  return {
    ...queue,
    pending,
    ...(delivered && Object.keys(delivered).length > 0 ? { delivered } : { delivered: undefined }),
  };
}

function recordDelivery(
  queue: SideConversationHandoffQueue,
  deliveredNotices: readonly SideConversationHandoffNotice[],
): SideConversationHandoffQueue {
  if (deliveredNotices.length === 0) {
    return queue;
  }
  const delivered = { ...queue.delivered };
  for (const notice of deliveredNotices) {
    const previous = delivered[notice.intentId];
    if (!previous || previous.closedAt <= notice.closedAt) {
      delivered[notice.intentId] = { sequence: notice.sequence, closedAt: notice.closedAt };
    }
  }
  return { ...queue, delivered };
}

/**
 * Claim the queue for one run: at most one receipt may exist.
 *
 * Returns `undefined` when another run already holds the receipt, so the caller
 * never injects a batch it could not durably promise to deliver.
 */
export function beginSideConversationHandoffDispatch(
  queue: SideConversationHandoffQueue,
  receipt: SideConversationHandoffDispatchReceipt,
): SideConversationHandoffQueue | undefined {
  if (queue.dispatching && queue.dispatching.runId !== receipt.runId) {
    return undefined;
  }
  return { ...queue, dispatching: receipt };
}

/**
 * Resolve another run's receipt.
 *
 * A receipt is only delivery evidence when this process observed its dispatch.
 * Without that proof (restart, or a claim that never dispatched) it is an orphan:
 * the pending notices are restored and nothing is ever recorded as delivered, so
 * the next user message can still deliver them.
 */
export function reconcileSideConversationHandoffDispatch(
  queue: SideConversationHandoffQueue,
  currentRunId: string,
  isDispatched: (runId: string) => boolean,
): SideConversationHandoffQueue {
  const receipt = queue.dispatching;
  if (!receipt || receipt.runId === currentRunId) {
    return queue;
  }
  if (!isDispatched(receipt.runId)) {
    return { ...queue, dispatching: undefined };
  }
  const sequences = new Set(receipt.sequences);
  const droppedSequences = new Set(receipt.droppedSequences);
  const removed = queue.pending.filter((notice) => sequences.has(notice.sequence));
  const pending = queue.pending.filter((notice) => !sequences.has(notice.sequence));
  const dropped = (queue.dropped ?? []).filter((sequence) => !droppedSequences.has(sequence));
  return recordDelivery(
    {
      ...queue,
      pending,
      ...(dropped.length > 0 ? { dropped } : { dropped: undefined }),
      dispatching: undefined,
    },
    removed,
  );
}

/** Drop only the claimed sequences; evictions after the claim stay visible. */
export function dropSideConversationHandoffNotices(
  queue: SideConversationHandoffQueue,
  sequences: readonly number[],
): SideConversationHandoffQueue {
  const claimed = new Set(sequences);
  const pending = queue.pending.filter((notice) => !claimed.has(notice.sequence));
  if (pending.length === queue.pending.length) {
    return queue;
  }
  return { ...queue, pending };
}

/** Delivery removes exactly the claimed notices, dropped lines, and receipt. */
export function commitSideConversationHandoffDispatch(
  queue: SideConversationHandoffQueue,
  receipt: Pick<SideConversationHandoffDispatchReceipt, "runId" | "sequences" | "droppedSequences">,
): SideConversationHandoffQueue {
  const sequences = new Set(receipt.sequences);
  const droppedSequences = new Set(receipt.droppedSequences);
  const removed = queue.pending.filter((notice) => sequences.has(notice.sequence));
  const pending = queue.pending.filter((notice) => !sequences.has(notice.sequence));
  const dropped = (queue.dropped ?? []).filter((sequence) => !droppedSequences.has(sequence));
  const released = queue.dispatching?.runId === receipt.runId;
  const next = recordDelivery(
    {
      ...queue,
      pending,
      ...(dropped.length > 0 ? { dropped } : { dropped: undefined }),
      ...(released ? { dispatching: undefined } : {}),
    },
    removed,
  );
  return next;
}

/** Pre-dispatch release clears only this run's receipt; pending stays queued. */
export function releaseSideConversationHandoffDispatch(
  queue: SideConversationHandoffQueue,
  runId: string,
): SideConversationHandoffQueue {
  if (queue.dispatching?.runId !== runId) {
    return queue;
  }
  return { ...queue, dispatching: undefined };
}

/** Remove dropped history that can never render because no notices are pending. */
export function clearSideConversationHandoffDropped(
  queue: SideConversationHandoffQueue,
): SideConversationHandoffQueue {
  if (!queue.dropped?.length) {
    return queue;
  }
  return { ...queue, dropped: undefined };
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
 * Fixed-format model-only reminder for one claimed batch.
 *
 * It restates the close-time facts only; it never claims the branch still needs
 * merging and never asks the model to act without the user's request.
 */
export function formatSideConversationHandoffPrompt(batch: {
  notices: readonly SideConversationHandoffNotice[];
  droppedCount: number;
}): string | undefined {
  const notices = batch.notices;
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
  if (batch.droppedCount > 0) {
    lines.push(
      `${batch.droppedCount} earlier closed side conversation${batch.droppedCount === 1 ? "" : "s"} had pending handoffs that this reminder omits; list them with sideConversations.list only if the user asks.`,
    );
  }
  return lines.join("\n");
}
