/**
 * Side-conversation next-message handoff owner.
 *
 * Closing a side conversation only records a durable, bounded reminder on the
 * parent row; it never reviews, merges, or runs anything. The next real external
 * user turn on that parent drains the queue into a model-only prepend — the user
 * text, transcript bytes, and chat history are never rewritten.
 *
 * Delivery is a small two-phase contract on the same parent row:
 * 1. A claim persists one `dispatching` receipt before the batch is injected, so
 *    an injected reminder is always durably promised to one run.
 * 2. After the provider request is actually dispatched, the receipt is committed
 *    (notices removed, delivery recorded). If that write fails, the receipt stays
 *    behind: the next run reconciles it as delivered and only cleans up, so the
 *    user never sees the same reminder twice. A run that never dispatched rolls
 *    its receipt back, so a pre-send failure keeps the notice pending.
 *
 * Queue shape and rendering live in `side-conversation-handoff-queue.ts`; this
 * module owns the parent-row transactions, Git facts, and delivery bookkeeping.
 */
import { existsSync } from "node:fs";
import type { EmbeddedRunTrigger } from "../agents/run-trigger.js";
import { runGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type {
  InternalSessionEntry,
  SideConversationHandoffFacts,
  SideConversationHandoffNotice,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isCronSessionKey,
  isIncognitoSessionKey,
  isSubagentSessionKey,
} from "../routing/session-key.js";
import type { InputProvenance } from "./input-provenance.js";
import {
  appendSideConversationHandoffNotice,
  beginSideConversationHandoffDispatch,
  cancelSideConversationHandoffNotices,
  clearSideConversationHandoffDropped,
  commitSideConversationHandoffDispatch,
  formatSideConversationHandoffPrompt,
  isSideConversationHandoffRecorded,
  readSideConversationHandoffQueue,
  reconcileSideConversationHandoffDispatch,
  releaseSideConversationHandoffDispatch,
} from "./side-conversation-handoff-queue.js";
import {
  resolveSideConversationChildCheckout,
  resolveSideConversationParentCheckout,
} from "./side-conversation-worktree.js";

export { resolveSideConversationHandoffCount } from "./side-conversation-handoff-queue.js";

const log = createSubsystemLogger("sessions/side-conversation-handoff");

/** Git inspection is best effort; a close never waits on it. */
const HANDOFF_GIT_TIMEOUT_MS = 5_000;

/** Stored counts stay bounded even when the checkout has many changes. */
const HANDOFF_COUNT_CAP = 100;

/** Same-run retries reuse one claim; terminal cleanup happens by eviction. */
const HANDOFF_CLAIM_CACHE_MAX = 256;

/** Dispatch proofs for cleanup receipts; only this process can vouch for them. */
const HANDOFF_DISPATCHED_RUNS_MAX = 1_024;

type HandoffScope = { agentId: string; sessionKey: string; storePath: string };

type ClaimPhase = "claimed" | "dispatched" | "released";

type CachedHandoffClaim = {
  status: "empty" | "pending" | "delivered";
  claim?: SideConversationHandoffPromptClaim;
};

const claimsByRun = new Map<string, CachedHandoffClaim>();
const dispatchedRuns = new Set<string>();

function markHandoffDispatchedRun(runId: string): void {
  if (dispatchedRuns.size >= HANDOFF_DISPATCHED_RUNS_MAX) {
    const oldest = dispatchedRuns.values().next().value;
    if (oldest !== undefined) {
      dispatchedRuns.delete(oldest);
    }
  }
  dispatchedRuns.add(runId);
}

/** One drained reminder batch plus its delivery and pre-send rollback receipts. */
export type SideConversationHandoffPromptClaim = {
  /** Model-only prepend text; never part of the user turn or transcript. */
  prependContext: string;
  /** Commits delivery once the provider request was actually dispatched. */
  commit: () => Promise<void>;
  /** Rolls the claim receipt back when the provider request was never sent. */
  release: () => Promise<void>;
  /**
   * Rechecks at the dispatch boundary that this run still owns a live claim.
   *
   * Returns false after reopen/another run removed the receipts; throws when the
   * queue cannot be read so the caller aborts before dispatch instead of sending
   * a stale block.
   */
  revalidate: () => Promise<boolean>;
};

/** What a close recorded on the parent row. */
export type SideConversationHandoffEnsureResult =
  | { status: "recorded" }
  | { status: "already-recorded" }
  | { status: "no-edits" }
  | { status: "no-checkout" }
  | { status: "missing-parent" };

/** Drop every claim and dispatch proof; only a test fixture resets them (restart). */
export function clearSideConversationHandoffClaimsForTest(): void {
  claimsByRun.clear();
  dispatchedRuns.clear();
}

function rememberClaim(runId: string, claim: CachedHandoffClaim): void {
  if (claimsByRun.has(runId)) {
    claimsByRun.delete(runId);
  } else if (claimsByRun.size >= HANDOFF_CLAIM_CACHE_MAX) {
    pruneMapToMaxSize(claimsByRun, HANDOFF_CLAIM_CACHE_MAX - 1);
  }
  claimsByRun.set(runId, claim);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this attempt is the parent's own next external user message.
 *
 * Cron, heartbeat, subagent, internal-event, and incognito turns never drain the
 * queue: their model context belongs to another producer.
 */
function resolveHandoffScope(params: {
  hasInternalEvents?: boolean;
  inputProvenance?: InputProvenance;
  operation?: string;
  sessionKey?: string;
  sessionTarget?: { agentId?: string; sessionKey?: string; storePath?: string };
  skipPreparedUserTurnMessage?: boolean;
  trigger?: EmbeddedRunTrigger;
}): HandoffScope | undefined {
  if (params.operation === "settled-tool-finalization") {
    return undefined;
  }
  if (params.trigger !== "user") {
    return undefined;
  }
  if (params.skipPreparedUserTurnMessage === true) {
    return undefined;
  }
  // Internal events (task completions and similar) ride the user role but are
  // produced by the system; their context belongs to that producer.
  if (params.hasInternalEvents) {
    return undefined;
  }
  if (params.inputProvenance && params.inputProvenance.kind !== "external_user") {
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  if (isCronSessionKey(sessionKey) || isSubagentSessionKey(sessionKey)) {
    return undefined;
  }
  if (isIncognitoSessionKey(sessionKey)) {
    return undefined;
  }
  const target = params.sessionTarget;
  if (!target?.agentId || !target.storePath) {
    return undefined;
  }
  if (target.sessionKey && target.sessionKey.trim() !== sessionKey) {
    return undefined;
  }
  return { agentId: target.agentId, sessionKey, storePath: target.storePath };
}

type ClaimPlan = {
  notices: SideConversationHandoffNotice[];
  droppedCount: number;
  droppedSequences: number[];
};

/**
 * Persist the claim receipt before the batch can reach the model.
 *
 * The same transaction reconciles a receipt left by another run: such a batch is
 * treated as delivered (never injected again) and only cleaned up here.
 */
async function persistClaim(params: {
  runId: string;
  scope: HandoffScope;
}): Promise<ClaimPlan | undefined> {
  let plan: ClaimPlan | undefined;
  try {
    await patchSessionEntryCore(
      params.scope,
      (entry: InternalSessionEntry) => {
        const queue = readSideConversationHandoffQueue(entry);
        let reconciled = reconcileSideConversationHandoffDispatch(queue, params.runId, (runId) =>
          dispatchedRuns.has(runId),
        );
        if (reconciled.pending.length === 0) {
          reconciled = clearSideConversationHandoffDropped(reconciled);
          plan = { notices: [], droppedCount: 0, droppedSequences: [] };
          return reconciled === queue ? null : { ...entry, sideConversationHandoffs: reconciled };
        }
        const notices = reconciled.pending;
        const droppedSequences = reconciled.dropped ?? [];
        const next = beginSideConversationHandoffDispatch(reconciled, {
          runId: params.runId,
          sequences: notices.map((notice) => notice.sequence),
          droppedSequences,
          at: Date.now(),
        });
        if (!next) {
          // Another run claimed between the read and this transaction; never
          // inject a batch this run cannot durably promise to deliver.
          plan = undefined;
          return reconciled === queue ? null : { ...entry, sideConversationHandoffs: reconciled };
        }
        plan = { notices, droppedCount: droppedSequences.length, droppedSequences };
        return { ...entry, sideConversationHandoffs: next };
      },
      { replaceEntry: true, skipMaintenance: true },
    );
  } catch (error) {
    log.warn(
      `side conversation handoff claim failed for ${params.scope.sessionKey}: ${formatError(error)}`,
    );
    return undefined;
  }
  return plan;
}

/**
 * Claim the pending reminders for one real external user turn.
 *
 * Eligible turns are cached for the whole run: a retry keeps the identical
 * batch, a run that saw an empty queue never absorbs a close that lands during
 * its own retries, and a run that already dispatched (or treated another run's
 * receipt as delivered) never injects again.
 */
export async function claimSideConversationHandoffPrompt(params: {
  hasInternalEvents?: boolean;
  runId?: string;
  sessionKey?: string;
  sessionTarget?: { agentId?: string; sessionKey?: string; storePath?: string };
  trigger?: EmbeddedRunTrigger;
  operation?: string;
  inputProvenance?: InputProvenance;
  skipPreparedUserTurnMessage?: boolean;
}): Promise<SideConversationHandoffPromptClaim | undefined> {
  const runId = params.runId;
  if (!runId) {
    return undefined;
  }
  const scope = resolveHandoffScope(params);
  if (!scope) {
    return undefined;
  }
  const cached = claimsByRun.get(runId);
  if (cached) {
    return cached.status === "pending" ? cached.claim : undefined;
  }
  let entry: InternalSessionEntry | undefined;
  try {
    entry = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
  } catch (error) {
    log.warn(
      `side conversation handoff read failed for ${scope.sessionKey}: ${formatError(error)}`,
    );
    return undefined;
  }
  if (!entry || entry.incognito === true) {
    rememberClaim(runId, { status: "empty" });
    return undefined;
  }
  const queue = readSideConversationHandoffQueue(entry);
  if (queue.pending.length === 0) {
    // Nothing can render without pending notices; clear stale dropped history
    // best effort and keep the run silent from here on.
    if (queue.dropped?.length || queue.dispatching) {
      await clearEmptyQueue({ runId, scope });
    }
    rememberClaim(runId, { status: "empty" });
    return undefined;
  }
  const plan = await persistClaim({ runId, scope });
  if (!plan) {
    // No receipt means no injection: the queue stays intact for a later attempt.
    return undefined;
  }
  if (plan.notices.length === 0) {
    rememberClaim(runId, { status: "empty" });
    return undefined;
  }
  const prependContext = formatSideConversationHandoffPrompt({
    notices: plan.notices,
    droppedCount: plan.droppedCount,
  });
  if (!prependContext) {
    rememberClaim(runId, { status: "empty" });
    return undefined;
  }
  const cachedClaim: CachedHandoffClaim = { status: "pending" };
  const claim = buildClaim({
    droppedSequences: plan.droppedSequences,
    onDelivered: () => {
      cachedClaim.status = "delivered";
      cachedClaim.claim = undefined;
    },
    onReleased: () => {
      // A retry of the same run may claim again; only a dispatched batch stays
      // suppressed for the rest of the run.
      if (claimsByRun.get(runId) === cachedClaim) {
        claimsByRun.delete(runId);
      }
    },
    prependContext,
    runId,
    scope,
    sequences: plan.notices.map((notice) => notice.sequence),
  });
  cachedClaim.claim = claim;
  rememberClaim(runId, cachedClaim);
  return claim;
}

/** Clear an empty queue's stale bookkeeping without touching pending notices. */
async function clearEmptyQueue(params: { runId: string; scope: HandoffScope }): Promise<void> {
  try {
    await patchSessionEntryCore(
      params.scope,
      (entry: InternalSessionEntry) => {
        const queue = reconcileSideConversationHandoffDispatch(
          readSideConversationHandoffQueue(entry),
          params.runId,
          (runId) => dispatchedRuns.has(runId),
        );
        const next =
          queue.pending.length === 0 ? clearSideConversationHandoffDropped(queue) : queue;
        if (next === queue) {
          return null;
        }
        return { ...entry, sideConversationHandoffs: next };
      },
      { replaceEntry: true, skipMaintenance: true },
    );
  } catch (error) {
    log.warn(
      `side conversation handoff cleanup failed for ${params.scope.sessionKey}: ${formatError(error)}`,
    );
  }
}

type ClaimInputs = {
  droppedSequences: number[];
  onDelivered: () => void;
  onReleased: () => void;
  prependContext: string;
  runId: string;
  scope: HandoffScope;
  sequences: number[];
};

function buildClaim(inputs: ClaimInputs): SideConversationHandoffPromptClaim {
  let phase: ClaimPhase = "claimed";
  return {
    prependContext: inputs.prependContext,
    async commit() {
      if (phase !== "claimed") {
        return;
      }
      phase = "dispatched";
      markHandoffDispatchedRun(inputs.runId);
      inputs.onDelivered();
      try {
        await patchSessionEntryCore(
          inputs.scope,
          (entry: InternalSessionEntry) => {
            const queue = readSideConversationHandoffQueue(entry);
            const next = commitSideConversationHandoffDispatch(queue, {
              runId: inputs.runId,
              sequences: inputs.sequences,
              droppedSequences: inputs.droppedSequences,
            });
            if (next === queue) {
              return null;
            }
            return { ...entry, sideConversationHandoffs: next };
          },
          { replaceEntry: true, skipMaintenance: true },
        );
      } catch (error) {
        // The reminder was already handed to the provider; the persisted receipt
        // keeps the next run from repeating it and retries the cleanup instead.
        log.warn(
          `side conversation handoff delivery bookkeeping failed for ${inputs.scope.sessionKey}: ${formatError(error)}`,
        );
      }
    },
    async release() {
      if (phase !== "claimed") {
        return;
      }
      phase = "released";
      inputs.onReleased();
      await releaseReceipt({ runId: inputs.runId, scope: inputs.scope });
    },
    async revalidate() {
      if (phase !== "claimed") {
        return false;
      }
      const active = await isClaimStillActive({
        runId: inputs.runId,
        scope: inputs.scope,
        sequences: inputs.sequences,
      });
      if (active) {
        return true;
      }
      phase = "released";
      inputs.onReleased();
      await releaseReceipt({ runId: inputs.runId, scope: inputs.scope });
      return false;
    },
  };
}

/** Clear this run's receipt; a leftover receipt is restored as pending by the next run. */
async function releaseReceipt(params: { runId: string; scope: HandoffScope }): Promise<void> {
  try {
    await patchSessionEntryCore(
      params.scope,
      (entry: InternalSessionEntry) => {
        const queue = readSideConversationHandoffQueue(entry);
        const next = releaseSideConversationHandoffDispatch(queue, params.runId);
        if (next === queue) {
          return null;
        }
        return { ...entry, sideConversationHandoffs: next };
      },
      { replaceEntry: true, skipMaintenance: true },
    );
  } catch (error) {
    // The receipt becomes an orphan: the next run restores it as pending instead
    // of treating it as delivered.
    log.warn(
      `side conversation handoff release failed for ${params.scope.sessionKey}: ${formatError(error)}`,
    );
  }
}

/** True only while this run's receipt exists and every claimed notice is pending. */
async function isClaimStillActive(params: {
  runId: string;
  scope: HandoffScope;
  sequences: readonly number[];
}): Promise<boolean> {
  // Read errors propagate: the caller aborts before dispatch and keeps pending.
  const entry = loadSessionEntryReadOnly({ ...params.scope, readConsistency: "latest" });
  if (!entry) {
    return false;
  }
  const queue = readSideConversationHandoffQueue(entry);
  const receipt = queue.dispatching;
  if (!receipt || receipt.runId !== params.runId) {
    return false;
  }
  const pendingSequences = new Set(queue.pending.map((notice) => notice.sequence));
  return params.sequences.every((sequence) => pendingSequences.has(sequence));
}

/**
 * Record the close-time reminder, or repair a repeated close of the same
 * generation whose enqueue failed earlier.
 *
 * The owner decides from the durable queue: a pending notice or a delivered
 * record for this exact `closedAt` is final, otherwise it inspects the checkout
 * again and enqueues. Failures propagate so close can report the explicit
 * "closed committed, reminder missing" retryable result.
 */
export async function ensureClosedSideConversationHandoff(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  childSessionKey: string;
  now: number;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): Promise<SideConversationHandoffEnsureResult> {
  const marker = params.child.sideConversation;
  if (!marker) {
    return { status: "no-checkout" };
  }
  const closedAt = marker.closedAt ?? params.now;
  const existing = loadSessionEntryReadOnly({
    agentId: params.agentId,
    sessionKey: params.parentSessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  if (!existing) {
    return { status: "missing-parent" };
  }
  if (
    isSideConversationHandoffRecorded(readSideConversationHandoffQueue(existing), {
      closedAt,
      intentId: marker.intentId,
    })
  ) {
    return { status: "already-recorded" };
  }
  const facts = await collectSideConversationHandoffFacts({
    cfg: params.cfg,
    agentId: params.agentId,
    child: params.child,
    parentEntry: params.parentEntry,
  });
  if (!facts) {
    return { status: "no-checkout" };
  }
  if (facts.changedFiles === 0 && facts.commitsAhead === 0) {
    return { status: "no-edits" };
  }
  let outcome: SideConversationHandoffEnsureResult | undefined;
  const updated = await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey: params.parentSessionKey, storePath: params.storePath },
    (entry: InternalSessionEntry) => {
      const queue = readSideConversationHandoffQueue(entry);
      if (isSideConversationHandoffRecorded(queue, { closedAt, intentId: marker.intentId })) {
        outcome = { status: "already-recorded" };
        return null;
      }
      const title = resolveHandoffTitle(params.child);
      const notice: SideConversationHandoffNotice = {
        sequence: queue.nextSequence,
        sessionKey: params.childSessionKey,
        intentId: marker.intentId,
        ordinal: marker.ordinal,
        ...(title ? { title } : {}),
        closedAt,
        worktree: facts,
      };
      outcome = { status: "recorded" };
      const next: InternalSessionEntry = {
        ...entry,
        sideConversationHandoffs: appendSideConversationHandoffNotice(queue, notice),
      };
      return next;
    },
    { replaceEntry: true, skipMaintenance: true },
  );
  if (!updated) {
    return outcome ?? { status: "missing-parent" };
  }
  if (outcome?.status !== "recorded") {
    return outcome ?? { status: "missing-parent" };
  }
  log.debug(`side conversation handoff queued for ${params.parentSessionKey}`);
  return outcome;
}

function resolveHandoffTitle(entry: InternalSessionEntry): string | undefined {
  const title = entry.label ?? entry.displayName;
  return typeof title === "string" && title.trim() ? title : undefined;
}

/** Reopen cancels only the still-undelivered notices of this exact child. */
export async function cancelPendingSideConversationHandoffs(params: {
  agentId: string;
  intentId: string;
  parentSessionKey: string;
  storePath: string;
}): Promise<number> {
  let cancelled = 0;
  await patchSessionEntryCore(
    {
      agentId: params.agentId,
      sessionKey: params.parentSessionKey,
      storePath: params.storePath,
    },
    (entry: InternalSessionEntry) => {
      const queue = readSideConversationHandoffQueue(entry);
      const nextQueue = cancelSideConversationHandoffNotices(queue, params.intentId);
      if (nextQueue === queue) {
        return null;
      }
      cancelled = queue.pending.length - nextQueue.pending.length;
      const next: InternalSessionEntry = { ...entry, sideConversationHandoffs: nextQueue };
      return next;
    },
    { replaceEntry: true, skipMaintenance: true },
  );
  return cancelled;
}

/** Resolve the child's checkout/base and inspect its bounded Git facts. */
async function collectSideConversationHandoffFacts(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  parentEntry: InternalSessionEntry;
}): Promise<SideConversationHandoffFacts | undefined> {
  const checkout = resolveSideConversationChildCheckout(params.child);
  const record = params.child.worktree?.id
    ? getRegistryWorktree(process.env, params.child.worktree.id)
    : undefined;
  const parentCheckout = resolveSideConversationParentCheckout({
    cfg: params.cfg,
    agentId: params.agentId,
    parentEntry: params.parentEntry,
  });
  if (!checkout.checkoutPath && !checkout.branch) {
    return undefined;
  }
  return await inspectSideConversationHandoffEdits({
    ...(checkout.checkoutPath && existsSync(checkout.checkoutPath)
      ? { childCheckoutPath: checkout.checkoutPath }
      : {}),
    ...(checkout.branch ? { childBranch: checkout.branch } : {}),
    ...(record?.baseRef ? { baseRef: record.baseRef } : {}),
    ...(parentCheckout ? { parentCheckoutPath: parentCheckout.path } : {}),
  });
}

/**
 * Bounded Git facts for one closed child.
 *
 * Every probe is independent and best effort: an unreadable checkout yields
 * `undefined` fields instead of failing the close.
 */
export async function inspectSideConversationHandoffEdits(params: {
  childCheckoutPath?: string;
  childBranch?: string;
  parentCheckoutPath?: string;
  baseRef?: string;
  signal?: AbortSignal;
}): Promise<SideConversationHandoffFacts> {
  const signal = params.signal ?? AbortSignal.timeout(HANDOFF_GIT_TIMEOUT_MS);
  const options = { signal };
  const read = async (cwd: string | undefined, args: string[]): Promise<string | undefined> => {
    if (!cwd) {
      return undefined;
    }
    try {
      const result = await runGit(cwd, args, options);
      return result.termination === "exit" && result.code === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  // Presence alone is not a checkout: a retired or missing path must fall back
  // to the shared repository facts instead of claiming unreadable edits.
  const childPath =
    params.childCheckoutPath && existsSync(params.childCheckoutPath)
      ? params.childCheckoutPath
      : undefined;
  const parentPath = params.parentCheckoutPath;
  const facts: SideConversationHandoffFacts = {
    ...(params.childBranch?.trim() ? { branch: params.childBranch.trim() } : {}),
    ...(childPath ? { path: childPath } : {}),
    ...(params.baseRef?.trim() ? { baseRef: params.baseRef.trim() } : {}),
  };

  let headCommit = await read(childPath, ["rev-parse", "--short=12", "HEAD"]);
  if (!headCommit && parentPath && facts.branch) {
    headCommit = await read(parentPath, [
      "rev-parse",
      "--short=12",
      "--verify",
      "--end-of-options",
      `${facts.branch}^{commit}`,
    ]);
  }
  if (headCommit) {
    facts.headCommit = headCommit.split("\n")[0];
  }

  if (childPath) {
    const status = await read(childPath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    if (status !== undefined) {
      const lines = status.split("\n").filter((line) => line.trim().length > 0);
      facts.changedFiles = Math.min(lines.length, HANDOFF_COUNT_CAP);
    }
  }

  let baseCommit: string | undefined;
  if (facts.baseRef) {
    baseCommit = await read(childPath ?? parentPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${facts.baseRef}^{commit}`,
    ]);
  }
  if (!baseCommit && parentPath) {
    baseCommit = await read(parentPath, ["rev-parse", "HEAD"]);
  }
  if (baseCommit) {
    const revision = childPath ? "HEAD" : facts.branch;
    const commitsAhead = await read(childPath ?? parentPath, [
      "rev-list",
      "--count",
      `${baseCommit}..${revision}`,
    ]);
    if (commitsAhead !== undefined) {
      facts.commitsAhead = Math.min(Number.parseInt(commitsAhead, 10) || 0, HANDOFF_COUNT_CAP);
    }
  }
  return facts;
}
