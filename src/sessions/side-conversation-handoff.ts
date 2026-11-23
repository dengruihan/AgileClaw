/**
 * Side-conversation next-message handoff owner.
 *
 * Closing a side conversation only records a durable, bounded reminder on the
 * parent row; it never reviews, merges, or runs anything. The next real external
 * user turn on that parent drains the queue into a model-only prepend — the user
 * text, transcript bytes, and chat history are never rewritten. Delivery is
 * committed only after the provider request is actually dispatched, so a
 * pre-send failure leaves the notice pending for the next user message.
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
  cancelSideConversationHandoffNotices,
  formatSideConversationHandoffPrompt,
  readSideConversationHandoffQueue,
  removeSideConversationHandoffNotices,
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

type HandoffScope = { agentId: string; sessionKey: string; storePath: string };

type CachedHandoffClaim = {
  prependContext: string;
  sequences: number[];
  delivered: boolean;
};

const claimsByRun = new Map<string, CachedHandoffClaim>();

/** One drained reminder batch plus its delivery receipt. */
export type SideConversationHandoffPromptClaim = {
  /** Model-only prepend text; never part of the user turn or transcript. */
  prependContext: string;
  /** Commits delivery once the provider request was actually dispatched. */
  dispatch: () => Promise<void>;
};

/** Drop every claim; only a test fixture resets the process-wide cache. */
export function clearSideConversationHandoffClaimsForTest(): void {
  claimsByRun.clear();
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

/**
 * Claim the pending reminders for one real external user turn.
 *
 * The run-scoped cache keeps retries of the same run byte-identical and stops a
 * second assembly after delivery from injecting the block again. Nothing is
 * marked delivered here; the returned `dispatch` owns that boundary.
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
    return cached.delivered ? undefined : buildClaim({ cached, scope });
  }
  let entry: InternalSessionEntry | undefined;
  try {
    entry = loadSessionEntryReadOnly({
      ...scope,
      readConsistency: "latest",
    });
  } catch (error) {
    log.warn(
      `side conversation handoff read failed for ${scope.sessionKey}: ${formatError(error)}`,
    );
    return undefined;
  }
  if (!entry || entry.incognito === true) {
    return undefined;
  }
  const queue = readSideConversationHandoffQueue(entry);
  const prependContext = formatSideConversationHandoffPrompt(queue);
  if (!prependContext) {
    return undefined;
  }
  const cachedClaim: CachedHandoffClaim = {
    prependContext,
    sequences: queue.pending.map((notice) => notice.sequence),
    delivered: false,
  };
  rememberClaim(runId, cachedClaim);
  return buildClaim({ cached: cachedClaim, scope });
}

function buildClaim(params: {
  cached: CachedHandoffClaim;
  scope: HandoffScope;
}): SideConversationHandoffPromptClaim {
  let dispatched = false;
  return {
    prependContext: params.cached.prependContext,
    dispatch: async () => {
      if (dispatched || params.cached.delivered) {
        return;
      }
      dispatched = true;
      await removeDeliveredNotices({ sequences: params.cached.sequences, scope: params.scope });
      params.cached.delivered = true;
    },
  };
}

/** Remove exactly the delivered notices; bookkeeping failure never fails the send. */
async function removeDeliveredNotices(params: {
  sequences: readonly number[];
  scope: HandoffScope;
}): Promise<void> {
  if (params.sequences.length === 0) {
    return;
  }
  try {
    await patchSessionEntryCore(
      params.scope,
      (entry: InternalSessionEntry) => {
        const queue = readSideConversationHandoffQueue(entry);
        const nextQueue = removeSideConversationHandoffNotices(queue, params.sequences);
        if (nextQueue === queue) {
          return null;
        }
        const next: InternalSessionEntry = { ...entry, sideConversationHandoffs: nextQueue };
        return next;
      },
      { replaceEntry: true, skipMaintenance: true },
    );
  } catch (error) {
    // The model request already went out; the notice stays pending for the next
    // user message instead of turning an accepted send into an ambiguous error.
    log.warn(
      `side conversation handoff delivery bookkeeping failed for ${params.scope.sessionKey}: ${formatError(error)}`,
    );
  }
}

/**
 * Enqueue one closed conversation's bounded Git facts on the parent row.
 *
 * A close that produced no edits records nothing, so an untouched side
 * conversation never nags the user. The write is a parent-row transaction; the
 * queue survives Gateway restarts with the parent entry.
 */
export async function enqueueSideConversationHandoff(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  childSessionKey: string;
  now: number;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): Promise<{ enqueued: boolean; reason?: "no-checkout" | "no-edits" | "missing-parent" }> {
  const marker = params.child.sideConversation;
  if (!marker) {
    return { enqueued: false, reason: "no-checkout" };
  }
  const facts = await collectSideConversationHandoffFacts({
    cfg: params.cfg,
    agentId: params.agentId,
    child: params.child,
    parentEntry: params.parentEntry,
  });
  if (!facts) {
    return { enqueued: false, reason: "no-checkout" };
  }
  if (facts.changedFiles === 0 && facts.commitsAhead === 0) {
    return { enqueued: false, reason: "no-edits" };
  }
  let enqueuedSequence: number | undefined;
  const updated = await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey: params.parentSessionKey, storePath: params.storePath },
    (entry: InternalSessionEntry) => {
      const queue = readSideConversationHandoffQueue(entry);
      enqueuedSequence = queue.nextSequence;
      const title = resolveHandoffTitle(params.child);
      const notice: SideConversationHandoffNotice = {
        sequence: queue.nextSequence,
        sessionKey: params.childSessionKey,
        intentId: marker.intentId,
        ordinal: marker.ordinal,
        ...(title ? { title } : {}),
        closedAt: marker.closedAt ?? params.now,
        worktree: facts,
      };
      const next: InternalSessionEntry = {
        ...entry,
        sideConversationHandoffs: appendSideConversationHandoffNotice(queue, notice),
      };
      return next;
    },
    { replaceEntry: true, skipMaintenance: true },
  );
  if (!updated) {
    return { enqueued: false, reason: "missing-parent" };
  }
  log.debug(
    `side conversation handoff queued for ${params.parentSessionKey} (sequence ${enqueuedSequence})`,
  );
  return { enqueued: true };
}

/**
 * Best-effort close-time reminder.
 *
 * The close state is already committed, so an unreadable checkout or failed
 * parent write must log and leave close successful instead of reporting an
 * ambiguous state change.
 */
export async function recordClosedSideConversationHandoff(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  childSessionKey: string;
  now: number;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): Promise<void> {
  try {
    await enqueueSideConversationHandoff(params);
  } catch (error) {
    log.warn(
      `side conversation ${params.childSessionKey} closed but its handoff reminder could not be recorded: ${formatError(error)}`,
    );
  }
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
