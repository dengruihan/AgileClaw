/**
 * Manual handoff: merge, abandon, and explicit delete for side conversations.
 *
 * Merge preflight and execution belong to the worktree merge owner; this module
 * only resolves the pair, requires both sides to be idle, records the outcome,
 * and keeps abandon a state-only write. Explicit delete is the only operation
 * that retires the child's checkout, through the snapshot-protected removal
 * owner shared with the parent fence.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SideConversationRemainder,
  type SideConversationSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  buildSideConversationMergeMessage,
  mergeSideConversationBranch,
  resolveLandedSideConversationMerge,
  type SideConversationMergeFailure,
} from "../../agents/worktrees/side-conversation-merge.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  resolveSideConversationChildCheckout,
  resolveSideConversationParentCheckout,
} from "../../sessions/side-conversation-worktree.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";
import { deleteRegisteredSideConversationChild } from "./side-conversations-fence.js";
import {
  findRegistrationBySessionKey,
  type SideConversationResult,
} from "./side-conversations-replay.js";
import {
  SideConversationBusyError,
  SideConversationChangedError,
  assertSideConversationIdle,
  busyErrorShape,
  changedErrorShape,
  commitSideConversationState,
  mirrorSideConversationState,
  resolveSideConversationChildTarget,
  summarizeSideConversation,
} from "./side-conversations-target.js";
import type { GatewayRequestContext } from "./types.js";

function mergeFailureToError(error: SideConversationMergeFailure): ErrorShape {
  const details = error.paths?.length ? { details: { paths: error.paths } } : {};
  if (error.code === "source-changed") {
    return errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true, ...details });
  }
  if (error.code === "merge-failed") {
    return errorShape(ErrorCodes.UNAVAILABLE, error.message, details);
  }
  return errorShape(ErrorCodes.INVALID_REQUEST, error.message, details);
}

/**
 * Merge the child's committed branch into the parent checkout.
 *
 * Preflight (`merge-tree` plus the ancestor check), the clean-parent rule, and
 * the merge itself live in the worktree merge owner. Only a successful merge is
 * recorded as `merged`; the branch and checkout stay available for explicit
 * cleanup.
 */
type MergeSideConversationResult = SideConversationResult<{
  conversation: SideConversationSummary;
  mergeCommit?: string;
  alreadyMerged: boolean;
}>;

/**
 * Merge under the parent and child lifecycle lanes.
 *
 * The Git side effect and its metadata reconciliation are one authoritative
 * operation on both session owners: parent delete/archive and child delete must
 * wait for this lane or fail their own precondition, so no accepted merge can
 * land after its rows are gone, and no deletion can interleave with the write.
 */
export async function mergePersistentSideConversation(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  assertCurrent: () => void;
  /** Caller cancellation; a request queued behind another mutation settles at abort. */
  signal?: AbortSignal;
}): Promise<MergeSideConversationResult> {
  const preflight = await resolveSideConversationChildTarget(params);
  if (!preflight.ok) {
    return preflight;
  }
  const { target, child } = preflight.value;
  const identities = [
    target.canonicalKey,
    target.entry.sessionId,
    params.sessionKey.trim(),
    child.sessionId,
  ].filter((identity): identity is string => typeof identity === "string" && identity.length > 0);
  return await runExclusiveSessionLifecycleMutation("side-merge", {
    scope: target.storePath,
    identities,
    ...(params.signal ? { signal: params.signal } : {}),
    // No store mutex is nested: this is the same lifecycle lane that delete and
    // archive acquire, and every release happens in the owner's finally.
    run: async () => await mergeSideConversationInLane(params),
  });
}

async function mergeSideConversationInLane(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<MergeSideConversationResult> {
  const sessionKey = params.sessionKey.trim();
  // The preflight only selected the lane identities; revalidate the exact pair
  // after acquiring it so a completed delete/archive is never merged into.
  const resolved = await resolveSideConversationChildTarget(params);
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} or its parent changed before the merge; nothing was merged.`,
      ),
    };
  }
  const { target, registration, child, marker } = resolved.value;
  const summarize = (entry: InternalSessionEntry) =>
    summarizeSideConversation({
      cfg: params.cfg,
      entry,
      intentId: marker.intentId,
      ...(registration ? { registration } : {}),
      sessionKey,
      target,
    });
  if (marker.state === "merged") {
    // A completed replay names the same landing commit when the checkout still
    // resolves it; the branch is never merged a second time.
    const childCheckout = resolveSideConversationChildCheckout(child);
    const parentCheckout = resolveSideConversationParentCheckout({
      cfg: params.cfg,
      agentId: target.agentId,
      parentEntry: target.entry,
    });
    const landed =
      parentCheckout && childCheckout.branch
        ? await resolveLandedSideConversationMerge({
            parentCheckoutPath: parentCheckout.path,
            childBranch: childCheckout.branch,
          }).catch(() => undefined)
        : undefined;
    return {
      ok: true,
      value: {
        conversation: summarize(child),
        ...(landed ? { mergeCommit: landed } : {}),
        alreadyMerged: true,
      },
    };
  }
  if (target.entry.archivedAt !== undefined) {
    // Archive can commit the parent before it retires every child. A live,
    // unarchived child must never write into an archived parent, and no retry
    // could ever record that write, so refuse before any Git work.
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `The parent session is archived; restore it before merging side conversation ${sessionKey}.`,
      ),
    };
  }
  if (marker.state === "abandoned") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} was abandoned and cannot be merged.`,
      ),
    };
  }
  if (child.archivedAt !== undefined) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} is archived; restore it before merging.`,
      ),
    };
  }
  const childCheckout = resolveSideConversationChildCheckout(child);
  if (!child.worktree?.id || !childCheckout.branch) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} has no isolated branch to merge; it shares the parent checkout.`,
      ),
    };
  }
  try {
    assertSideConversationIdle({
      agentId: target.agentId,
      assertCurrent: params.assertCurrent,
      child,
      context: params.context,
      sessionKey,
      storePath: target.storePath,
      target,
    });
  } catch (error) {
    if (error instanceof SideConversationBusyError) {
      return { ok: false, error: busyErrorShape(sessionKey, "merge") };
    }
    throw error;
  }
  const parentCheckout = resolveSideConversationParentCheckout({
    cfg: params.cfg,
    agentId: target.agentId,
    parentEntry: target.entry,
  });
  if (!parentCheckout) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "The parent session has no local Git checkout to merge into.",
      ),
    };
  }
  params.assertCurrent();
  const merged = await mergeSideConversationBranch({
    parentCheckoutPath: parentCheckout.path,
    childBranch: childCheckout.branch,
    ...(childCheckout.checkoutPath ? { childCheckoutPath: childCheckout.checkoutPath } : {}),
    message: buildSideConversationMergeMessage({
      ...(child.label ? { label: child.label } : {}),
      sessionKey,
    }),
  });
  if (!merged.ok) {
    return { ok: false, error: mergeFailureToError(merged.error) };
  }
  const now = Date.now();
  let patched: InternalSessionEntry | null = null;
  let metadataFailure: unknown;
  try {
    patched = await commitSideConversationState({
      agentId: target.agentId,
      child,
      marker,
      nextState: "merged",
      now,
      sessionKey,
      storePath: target.storePath,
      // Final durable boundary: both parent and child incarnations, the intent
      // registration, and live work are rechecked inside the commit transaction.
      assertCommitAllowed: () => {
        params.assertCurrent();
        const currentParent = loadSessionEntry({
          agentId: target.agentId,
          sessionKey: target.canonicalKey,
          storePath: target.storePath,
        });
        const currentRegistration = currentParent
          ? findRegistrationBySessionKey(currentParent, sessionKey)?.[1]
          : undefined;
        if (
          !currentParent?.sessionId ||
          currentParent.sessionId !== target.entry.sessionId ||
          currentParent.archivedAt !== undefined ||
          !currentRegistration ||
          currentRegistration.sessionKey !== sessionKey
        ) {
          throw new SideConversationChangedError();
        }
        assertSideConversationIdle({
          agentId: target.agentId,
          assertCurrent: params.assertCurrent,
          child,
          context: params.context,
          sessionKey,
          storePath: target.storePath,
          target,
        });
      },
    });
  } catch (error) {
    if (isRequiredMergeAuthorityError(error)) {
      return {
        ok: false,
        error: withMergeOutcome(error.error, merged.value.commit),
      };
    }
    metadataFailure = error;
  }
  // Git already landed. Every metadata/guard/storage failure must report that
  // accepted write and its safe retry instead of an ambiguous generic error.
  if (metadataFailure !== undefined) {
    return {
      ok: false,
      error: mergeOutcomePendingError(
        sessionKey,
        merged.value.commit,
        formatErrorMessage(metadataFailure),
      ),
    };
  }
  if (!patched) {
    return {
      ok: false,
      error: mergeOutcomePendingError(sessionKey, merged.value.commit),
    };
  }
  await mirrorSideConversationState({
    agentId: target.agentId,
    cfg: params.cfg,
    intentId: marker.intentId,
    now,
    parentSessionKey: target.canonicalKey,
    sessionKey,
    state: "merged",
  });
  return {
    ok: true,
    value: {
      conversation: summarize(patched),
      mergeCommit: merged.value.commit,
      alreadyMerged: merged.value.alreadyMerged,
    },
  };
}

/** Authority loss keeps its canonical code/message but still reports the landed write. */
function isRequiredMergeAuthorityError(
  error: unknown,
): error is SessionMutationAuthorizationChangedError {
  return error instanceof SessionMutationAuthorizationChangedError;
}

function withMergeOutcome(error: ErrorShape, mergeCommit: string): ErrorShape {
  return {
    ...error,
    details: {
      ...(isRecord(error.details) ? error.details : {}),
      mergeCommit,
    },
    retryable: true,
  };
}

function mergeOutcomePendingError(
  sessionKey: string,
  mergeCommit: string,
  detail?: string,
): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Side conversation ${sessionKey} merged at ${mergeCommit}, but recording the merge state failed${detail ? ` (${detail})` : ""}. Retry the merge to record it; the parent branch is not moved again.`,
    { retryable: true, details: { mergeCommit } },
  );
}

/**
 * Abandon keeps the branch, checkout, and uncommitted files; it only records state.
 *
 * It shares the parent/child lifecycle lane with merge, delete, and archive, so a
 * paused merge cannot be abandoned underneath or leave an unreconcilable landed
 * write. The pair is re-resolved after the lane is acquired.
 */
export async function abandonPersistentSideConversation(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  assertCurrent: () => void;
}): Promise<SideConversationResult<SideConversationSummary>> {
  const preflight = await resolveSideConversationChildTarget(params);
  if (!preflight.ok) {
    return preflight;
  }
  const { target, child } = preflight.value;
  const identities = [
    target.canonicalKey,
    target.entry.sessionId,
    params.sessionKey.trim(),
    child.sessionId,
  ].filter((identity): identity is string => typeof identity === "string" && identity.length > 0);
  return await runExclusiveSessionLifecycleMutation("side-abandon", {
    scope: target.storePath,
    identities,
    run: async () => await abandonSideConversationInLane(params),
  });
}

async function abandonSideConversationInLane(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  assertCurrent: () => void;
}): Promise<SideConversationResult<SideConversationSummary>> {
  const sessionKey = params.sessionKey.trim();
  const resolved = await resolveSideConversationChildTarget(params);
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} or its parent changed before the abandon; nothing was changed.`,
      ),
    };
  }
  const { target, registration, child, marker } = resolved.value;
  if (marker.state === "merged") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} is merged and cannot be abandoned.`,
      ),
    };
  }
  const summarize = (entry: InternalSessionEntry) =>
    summarizeSideConversation({
      cfg: params.cfg,
      entry,
      intentId: marker.intentId,
      ...(registration ? { registration } : {}),
      sessionKey,
      target,
    });
  if (marker.state === "abandoned") {
    return { ok: true, value: summarize(child) };
  }
  const assertIdle = () =>
    assertSideConversationIdle({
      agentId: target.agentId,
      assertCurrent: params.assertCurrent,
      child,
      context: params.context,
      sessionKey,
      storePath: target.storePath,
      target,
    });
  try {
    assertIdle();
  } catch (error) {
    if (error instanceof SideConversationBusyError) {
      return { ok: false, error: busyErrorShape(sessionKey, "abandon") };
    }
    throw error;
  }
  const now = Date.now();
  let patched: InternalSessionEntry | null;
  try {
    patched = await commitSideConversationState({
      agentId: target.agentId,
      child,
      marker,
      nextState: "abandoned",
      now,
      sessionKey,
      storePath: target.storePath,
      assertCommitAllowed: assertIdle,
    });
  } catch (error) {
    if (error instanceof SideConversationBusyError) {
      return { ok: false, error: busyErrorShape(sessionKey, "abandon") };
    }
    throw error;
  }
  if (!patched) {
    return { ok: false, error: changedErrorShape(sessionKey) };
  }
  await mirrorSideConversationState({
    agentId: target.agentId,
    cfg: params.cfg,
    intentId: marker.intentId,
    now,
    parentSessionKey: target.canonicalKey,
    sessionKey,
    state: "abandoned",
  });
  return { ok: true, value: summarize(patched) };
}

/**
 * Explicit delete is the only operation that retires a side-conversation checkout.
 *
 * The child is drained through the canonical delete lifecycle and removed with
 * the same snapshot-protected worktree owner the parent fence uses, so dirty work
 * is preserved by the removal snapshot instead of being deleted.
 */
export async function deletePersistentSideConversation(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  deleteTranscript?: boolean;
  assertCurrent: () => void;
}): Promise<
  SideConversationResult<{
    sessionKey: string;
    deleted: true;
    cleanupPending?: SideConversationRemainder[];
    worktreePreserved?: PreservedWorktreeFact;
  }>
> {
  const resolved = await resolveSideConversationChildTarget(params);
  if (!resolved.ok) {
    return resolved;
  }
  const { target, registration, child, sessionId, marker } = resolved.value;
  const sessionKey = params.sessionKey.trim();
  if (marker.state === "open") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} is open; close it or abandon it before deleting.`,
      ),
    };
  }
  try {
    assertSideConversationIdle({
      agentId: target.agentId,
      assertCurrent: params.assertCurrent,
      child,
      context: params.context,
      sessionKey,
      storePath: target.storePath,
      target,
    });
  } catch (error) {
    if (error instanceof SideConversationBusyError) {
      return { ok: false, error: busyErrorShape(sessionKey, "delete") };
    }
    throw error;
  }
  let drain: Awaited<ReturnType<typeof prepareSessionLifecycleDrain>>;
  try {
    drain = await prepareSessionLifecycleDrain({
      action: "delete",
      authorize: params.assertCurrent,
      context: params.context,
      storePath: target.storePath,
      sessionKeys: [sessionKey],
      sessionId,
      sessionKey,
      agentId: target.agentId,
      lifecycleIdentities: [sessionKey, sessionId],
    });
  } catch (error) {
    params.assertCurrent();
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Side conversation ${sessionKey} could not be stopped before deletion: ${formatErrorMessage(error)} Retry after active work finishes.`,
        { retryable: true },
      ),
    };
  }
  const identities = [sessionKey, sessionId];
  try {
    return await runExclusiveSessionLifecycleMutation("delete", {
      scope: target.storePath,
      identities,
      prepare: async () => drain.handoffToMutation(),
      finalize: async () => drain.release(),
      run: async () => {
        const guard = () => {
          params.assertCurrent();
          if (drain.hasAuthoritativeWork()) {
            throw new SideConversationBusyError();
          }
        };
        const outcome = await deleteRegisteredSideConversationChild({
          agentId: target.agentId,
          cfg: params.cfg,
          child: {
            intentId: marker.intentId,
            registration: registration ?? {
              sessionKey,
              ordinal: marker.ordinal,
              state: marker.state,
              createdAt: marker.createdAt,
              updatedAt: marker.updatedAt,
            },
            entry: child,
          },
          commitGuard: guard,
          deleteTranscript: params.deleteTranscript ?? true,
          isActiveError: (error) => error instanceof SideConversationBusyError,
          parentSessionKey: target.canonicalKey,
          storePath: target.storePath,
        });
        if (outcome.status === "deleted") {
          return {
            ok: true as const,
            value: {
              sessionKey,
              deleted: true as const,
              ...(outcome.cleanupPending.length > 0
                ? { cleanupPending: outcome.cleanupPending }
                : {}),
              ...(outcome.preserved
                ? {
                    worktreePreserved: {
                      id: outcome.preserved.id,
                      branch: outcome.preserved.branch,
                      path: outcome.preserved.path,
                      reason: outcome.preserved.reason,
                    },
                  }
                : {}),
            },
          };
        }
        if (outcome.status === "missing-membership") {
          return {
            ok: false as const,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              `Side conversation ${sessionKey} has no membership reservation to release.`,
              { retryable: true },
            ),
          };
        }
        if (outcome.status === "changed") {
          return { ok: false as const, error: changedErrorShape(sessionKey) };
        }
        return {
          ok: false as const,
          error: outcome.active
            ? busyErrorShape(sessionKey, "delete")
            : errorShape(
                ErrorCodes.UNAVAILABLE,
                `Side conversation ${sessionKey} could not be deleted: ${outcome.message}`,
                { retryable: true },
              ),
        };
      },
    });
  } finally {
    drain.release();
  }
}

/** Pass-through of the worktree removal owner's preservation fact. */
type PreservedWorktreeFact = {
  id: string;
  branch: string;
  path: string;
  reason: string;
};
