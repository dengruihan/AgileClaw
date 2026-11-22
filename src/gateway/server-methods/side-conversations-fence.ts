/**
 * Side-conversation children inside a parent's existing lifecycle fence.
 *
 * The parent delete/archive already owns the session lifecycle mutex, so these
 * helpers use storage primitives directly and never nest another drain or
 * lifecycle mutation. Child work admission is closed as part of the same
 * ownership, and every durable child write rechecks authoritative liveness, so
 * work accepted after the preflight can never be deleted or archived.
 */
import {
  ErrorCodes,
  errorShape,
  WORKTREE_PRESERVATION_REASONS,
  type ErrorShape,
  type PreservedSessionWorktree,
  type SideConversationRemainder,
} from "../../../packages/gateway-protocol/src/index.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  listSideConversationRegistrations,
  markSideConversationDeleting,
  readSideConversationChildEntry,
  recordSideConversationState,
  removeSideConversationIntent,
  restoreSideConversationState,
} from "../../config/sessions/side-conversation-registry.js";
import type { SideConversationRegistryEntry } from "../../config/sessions/side-conversation-types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { closeSessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { handleSessionStateSessionDeleted } from "../../sessions/session-state-events.js";
import {
  removeSessionWorktree,
  SessionWorktreeLifecycleError,
  synchronizeSessionWorktreeArchive,
} from "../../sessions/session-worktree-lifecycle.js";
import { resolveSessionLifecycleActivity } from "./sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "./types.js";

const log = createSubsystemLogger("gateway/side-conversations");

function isPreservationReason(value: string): value is PreservedSessionWorktree["reason"] {
  return (WORKTREE_PRESERVATION_REASONS as readonly string[]).includes(value);
}

/** Public result values must be real preservation outcomes with discoverable locations. */
function isValidPreservedWorktree(
  value: PreservedSessionWorktree | undefined,
): value is PreservedSessionWorktree {
  return (
    value !== undefined &&
    isPreservationReason(value.reason) &&
    value.id.length > 0 &&
    value.branch.length > 0 &&
    value.path.length > 0
  );
}

type RegisteredChild = {
  intentId: string;
  registration: SideConversationRegistryEntry;
  entry: InternalSessionEntry;
};

/** A child became active after the parent action passed its preflight. */
class SideConversationChildActiveError extends Error {
  constructor(readonly sessionKey: string) {
    super(`Side conversation ${sessionKey} became active`);
  }
}

/** The captured child incarnation/revision moved before the durable write. */
class SideConversationChildChangedError extends Error {
  constructor(readonly sessionKey: string) {
    super(`Side conversation ${sessionKey} changed before the durable write`);
  }
}

function childKeys(params: { entry: InternalSessionEntry; sessionKey: string }): string[] {
  return [params.sessionKey, ...(params.entry.sessionId ? [params.entry.sessionId] : [])];
}

/** Read the registered children of one parent; no scan of unrelated rows. */
export function readRegisteredSideConversationChildren(params: {
  agentId: string;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): RegisteredChild[] {
  const children: RegisteredChild[] = [];
  for (const [intentId, registration] of listSideConversationRegistrations(params.parentEntry)) {
    if (registration.state === "abandoned") {
      continue;
    }
    const entry = readSideConversationChildEntry({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: registration.sessionKey,
    });
    if (
      !entry?.sideConversation ||
      entry.sideConversation.parentSessionKey !== params.parentSessionKey
    ) {
      continue;
    }
    children.push({ intentId, registration, entry });
  }
  return children;
}

/** Conservative liveness check usable inside a parent fence without a nested mutex. */
export function sideConversationActiveWork(params: {
  agentId: string;
  context: GatewayRequestContext;
  defaultAgentId?: string;
  entry: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
}): boolean {
  const sessionId = params.entry.sessionId;
  if (params.entry.status === "running") {
    return true;
  }
  return resolveSessionLifecycleActivity({
    context: params.context,
    storePath: params.storePath,
    sessionKeys: [params.sessionKey],
    ...(sessionId ? { sessionId } : {}),
    agentId: params.agentId,
    ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    sessionKey: params.sessionKey,
    lifecycleIdentities: [params.sessionKey, ...(sessionId ? [sessionId] : [])],
  });
}

/**
 * Close child ingress for the parent action's lifetime and expose the guard the
 * child's durable write must use. Closing admissions is in-memory ownership, not
 * the lifecycle mutex, so it does not nest the parent's store lock.
 */
export function closeSideConversationChildAdmissions(params: {
  children: readonly RegisteredChild[];
  storePath: string;
}): Array<() => void> {
  const releases: Array<() => void> = [];
  try {
    for (const child of params.children) {
      releases.push(
        closeSessionWorkAdmissions({
          scope: params.storePath,
          identities: childKeys({
            entry: child.entry,
            sessionKey: child.registration.sessionKey,
          }),
          reason: createAgentRunDirectAbortError(),
        }),
      );
    }
    return releases;
  } catch (error) {
    // A later closure failure must not leave earlier child ingress fenced.
    for (const release of releases) {
      release();
    }
    throw error;
  }
}

function childWriteGuard(params: {
  child: RegisteredChild;
  commitGuard: () => void;
  context: GatewayRequestContext;
  agentId: string;
  defaultAgentId?: string;
  storePath: string;
}): () => void {
  const sessionKey = params.child.registration.sessionKey;
  return () => {
    params.commitGuard();
    if (
      sideConversationActiveWork({
        agentId: params.agentId,
        context: params.context,
        ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
        entry: params.child.entry,
        sessionKey,
        storePath: params.storePath,
      })
    ) {
      throw new SideConversationChildActiveError(sessionKey);
    }
  };
}

export type SideConversationChildFenceResult = {
  /** False when setup failed before any child was processed. */
  ok: boolean;
  error?: ErrorShape;
  deletedKeys: string[];
  preserved: PreservedSessionWorktree[];
  remaining: SideConversationRemainder[];
  /** Post-delete cleanup whose row is already gone (retryable). */
  cleanupPending: SideConversationRemainder[];
};

function remainder(key: string, code: string, message: string): SideConversationRemainder {
  return { key, code, message };
}

function skippedRemainders(
  children: readonly RegisteredChild[],
  from: number,
): SideConversationRemainder[] {
  return children
    .slice(from)
    .map((child) =>
      remainder(
        child.registration.sessionKey,
        "SKIPPED",
        "not processed after an earlier child failure",
      ),
    );
}

/**
 * Delete registered children inside the parent's delete fence.
 *
 * Child admission is closed before the first durable write and every write
 * rechecks authoritative liveness. A child that fails is reported together with
 * every unprocessed successor; earlier deletions are listed explicitly so the
 * caller never has to infer them from a generic error. No nested drain/mutation.
 */
export async function deleteSideConversationChildrenInParentFence(params: {
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  defaultAgentId?: string;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
  deleteTranscript: boolean;
  commitGuard: () => void;
}): Promise<SideConversationChildFenceResult> {
  const children = readRegisteredSideConversationChildren(params);
  for (const [index, child] of children.entries()) {
    if (
      sideConversationActiveWork({
        agentId: params.agentId,
        context: params.context,
        ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
        entry: child.entry,
        sessionKey: child.registration.sessionKey,
        storePath: params.storePath,
      })
    ) {
      return {
        ok: true,
        deletedKeys: [],
        preserved: [],
        cleanupPending: [],
        remaining: [
          remainder(
            child.registration.sessionKey,
            "CHILD_ACTIVE",
            `side conversation ${child.registration.sessionKey} is still active`,
          ),
          ...skippedRemainders(children, index + 1),
        ],
      };
    }
  }
  let releases: Array<() => void>;
  try {
    releases = closeSideConversationChildAdmissions({ children, storePath: params.storePath });
  } catch (error) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Parent delete could not close side conversation admission: ${formatErrorMessage(error)}`,
      ),
      deletedKeys: [],
      preserved: [],
      cleanupPending: [],
      remaining: skippedRemainders(children, 0),
    };
  }
  const deletedKeys: string[] = [];
  const preserved: PreservedSessionWorktree[] = [];
  const cleanupPending: SideConversationRemainder[] = [];
  try {
    for (const [index, child] of children.entries()) {
      const sessionKey = child.registration.sessionKey;
      const guard = childWriteGuard({ ...params, child });
      let previousState: string | undefined;
      const restoreTombstone = async () => {
        if (previousState === undefined) {
          return;
        }
        await restoreSideConversationState({
          agentId: params.agentId,
          cfg: params.cfg,
          intentId: child.intentId,
          now: Date.now(),
          parentSessionKey: params.parentSessionKey,
          state:
            previousState === "deleting"
              ? "open"
              : (previousState as "open" | "closed" | "merged" | "abandoned"),
        }).catch((error: unknown) => {
          log.warn(
            `side conversation tombstone restore failed for ${sessionKey}: ${formatErrorMessage(error)}`,
          );
        });
      };
      try {
        // The admission was closed before this write; an already accepted run
        // still fails the authoritative guard below.
        guard();
        previousState = await markSideConversationDeleting({
          agentId: params.agentId,
          cfg: params.cfg,
          intentId: child.intentId,
          now: Date.now(),
          parentSessionKey: params.parentSessionKey,
        });
        if (previousState === undefined) {
          return {
            ok: true,
            deletedKeys,
            preserved,
            cleanupPending,
            remaining: [
              remainder(sessionKey, "CHILD_DELETE_FAILED", "membership reservation is missing"),
              ...skippedRemainders(children, index + 1),
            ],
          };
        }
        const result = await deleteSessionEntryLifecycle({
          agentId: params.agentId,
          archiveTranscript: params.deleteTranscript,
          commitGuard: guard,
          deleteDeliveryArtifacts: true,
          expectedEntry: child.entry,
          expectedSessionId: child.entry.sessionId,
          expectedUpdatedAt: child.entry.updatedAt,
          storePath: params.storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
        if (!result.deleted) {
          await restoreTombstone();
          return {
            ok: true,
            deletedKeys,
            preserved,
            cleanupPending,
            remaining: [
              remainder(sessionKey, "CHILD_CHANGED", "child changed before deletion"),
              ...skippedRemainders(children, index + 1),
            ],
          };
        }
        // Durable delete committed: record it before any cleanup that may throw.
        deletedKeys.push(sessionKey);
        try {
          handleSessionStateSessionDeleted(sessionKey, params.agentId);
        } catch (error) {
          cleanupPending.push(
            remainder(sessionKey, "POST_DELETE_CLEANUP_FAILED", formatErrorMessage(error)),
          );
        }
        try {
          const childPreserved = await removeSessionWorktree({
            id: child.entry.worktree?.id,
            sessionKey,
            reason: "session-delete",
            commitGuard: guard,
          });
          if (isValidPreservedWorktree(childPreserved)) {
            preserved.push(childPreserved);
          } else if (childPreserved) {
            log.warn(
              `side conversation worktree preserved without a valid location: ${sessionKey}`,
            );
          }
        } catch (error) {
          cleanupPending.push(
            remainder(sessionKey, "POST_DELETE_CLEANUP_FAILED", formatErrorMessage(error)),
          );
        }
        try {
          await removeSideConversationIntent({
            agentId: params.agentId,
            cfg: params.cfg,
            intentId: child.intentId,
            parentSessionKey: params.parentSessionKey,
          });
        } catch (error) {
          // The delete tombstone stays: count/list already exclude it, and the
          // partial result carries the retryable cleanup fact.
          cleanupPending.push(
            remainder(sessionKey, "REGISTRY_CLEANUP_PENDING", formatErrorMessage(error)),
          );
        }
      } catch (error) {
        await restoreTombstone();
        return {
          ok: true,
          deletedKeys,
          preserved,
          cleanupPending,
          remaining: [
            remainder(
              sessionKey,
              error instanceof SideConversationChildActiveError
                ? "CHILD_ACTIVE"
                : "CHILD_DELETE_FAILED",
              formatErrorMessage(error),
            ),
            ...skippedRemainders(children, index + 1),
          ],
        };
      } finally {
        releases[index]?.();
      }
    }
  } finally {
    for (const release of releases) {
      release();
    }
  }
  return { ok: true, deletedKeys, preserved, cleanupPending, remaining: [] };
}

export type SideConversationArchiveFenceResult = {
  archivedKeys: string[];
  preserved: PreservedSessionWorktree[];
  remaining: SideConversationRemainder[];
};

/** Reject a parent archive while any registered child still owns live work. */
export function resolveSideConversationArchiveBlocker(params: {
  agentId: string;
  context: GatewayRequestContext;
  defaultAgentId?: string;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): ErrorShape | undefined {
  for (const child of readRegisteredSideConversationChildren(params)) {
    if (
      sideConversationActiveWork({
        agentId: params.agentId,
        context: params.context,
        ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
        entry: child.entry,
        sessionKey: child.registration.sessionKey,
        storePath: params.storePath,
      })
    ) {
      return errorShape(
        ErrorCodes.UNAVAILABLE,
        `Side conversation ${child.registration.sessionKey} became active; close it before archiving the parent.`,
        { retryable: true },
      );
    }
  }
  return undefined;
}

/**
 * Read the preserved worktree record after archive cleanup refused to remove it.
 *
 * `session-changed` and `restore-failed` are lifecycle failures, not preservation
 * outcomes, and never become public worktreePreserved values.
 */
function readPreservedChildWorktree(
  entry: InternalSessionEntry,
  reason: SessionWorktreeLifecycleError["reason"],
): PreservedSessionWorktree | undefined {
  const id = entry.worktree?.id;
  if (!id || !isPreservationReason(reason)) {
    return undefined;
  }
  const record = getRegistryWorktree(process.env, id);
  const preserved: PreservedSessionWorktree = {
    id,
    branch: record?.branch ?? entry.worktree?.branch ?? "",
    path: record?.path ?? "",
    reason,
  };
  return isValidPreservedWorktree(preserved) ? preserved : undefined;
}

/**
 * Archive registered children after the parent archive commits, still inside the
 * parent's mutation lane. An unmerged child worktree is preserved and returned
 * to the caller instead of only being logged.
 */
export async function archiveSideConversationChildrenInParentFence(params: {
  cfg: OpenClawConfig;
  agentId: string;
  context: GatewayRequestContext;
  defaultAgentId?: string;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
  commitGuard: () => void;
}): Promise<SideConversationArchiveFenceResult> {
  const archivedKeys: string[] = [];
  const preserved: PreservedSessionWorktree[] = [];
  const remaining: SideConversationRemainder[] = [];
  const children = readRegisteredSideConversationChildren(params);
  const now = Date.now();
  for (const child of children) {
    const sessionKey = child.registration.sessionKey;
    const entry = readSideConversationChildEntry({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
    });
    if (!entry?.sessionId || entry.archivedAt !== undefined) {
      continue;
    }
    const current: RegisteredChild = {
      intentId: child.intentId,
      registration: child.registration,
      entry,
    };
    const guard = childWriteGuard({ ...params, child: current });
    try {
      guard();
    } catch (error) {
      remaining.push(
        remainder(
          sessionKey,
          error instanceof SideConversationChildActiveError
            ? "CHILD_ACTIVE"
            : error instanceof SideConversationChildChangedError
              ? "CHILD_CHANGED"
              : "CHILD_ARCHIVE_ERROR",
          formatErrorMessage(error),
        ),
      );
      continue;
    }
    // Worktree synchronization runs before the metadata commit, matching the
    // parent archive owner. A real preservation outcome keeps the branch and
    // still archives the row; any other lifecycle failure leaves the child row
    // unarchived and is reported distinctly.
    try {
      await synchronizeSessionWorktreeArchive({
        archived: true,
        entry,
        scope: { agentId: params.agentId, sessionKey, storePath: params.storePath },
        commitGuard: guard,
      });
    } catch (error) {
      if (!(error instanceof SessionWorktreeLifecycleError)) {
        remaining.push(remainder(sessionKey, "CHILD_ARCHIVE_ERROR", formatErrorMessage(error)));
        continue;
      }
      const record = readPreservedChildWorktree(entry, error.reason);
      if (record) {
        preserved.push(record);
        log.warn(`side conversation worktree preserved for ${sessionKey}: ${error.message}`);
      } else {
        remaining.push(
          remainder(
            sessionKey,
            "CHILD_ARCHIVE_FAILED",
            `worktree archive failed (${error.reason})`,
          ),
        );
        continue;
      }
    }
    // The final durable write executes the authoritative guard inside the commit
    // transaction and binds the captured child incarnation/revision.
    let committed: InternalSessionEntry | null;
    try {
      committed = await patchSessionEntryCore(
        { agentId: params.agentId, sessionKey, storePath: params.storePath },
        (currentEntry: InternalSessionEntry) => {
          if (
            currentEntry.sessionId !== entry.sessionId ||
            currentEntry.lifecycleRevision !== entry.lifecycleRevision ||
            currentEntry.sideConversation?.intentId !== entry.sideConversation?.intentId ||
            currentEntry.sideConversation?.parentSessionId !==
              entry.sideConversation?.parentSessionId
          ) {
            // patchSessionEntryCore returns the write base for a null updater, so
            // a null here would be reported as a successful archive.
            throw new SideConversationChildChangedError(sessionKey);
          }
          return {
            ...currentEntry,
            archivedAt: now,
            archiveReason: "manual" as const,
            sideConversation: {
              ...currentEntry.sideConversation!,
              state: "closed" as const,
              updatedAt: now,
              closedAt: currentEntry.sideConversation!.closedAt ?? now,
            },
          };
        },
        { replaceEntry: true, skipMaintenance: true, assertCommitAllowed: guard },
      );
    } catch (error) {
      remaining.push(
        remainder(
          sessionKey,
          error instanceof SideConversationChildActiveError
            ? "CHILD_ACTIVE"
            : error instanceof SideConversationChildChangedError
              ? "CHILD_CHANGED"
              : "CHILD_ARCHIVE_ERROR",
          formatErrorMessage(error),
        ),
      );
      continue;
    }
    if (!committed) {
      remaining.push(remainder(sessionKey, "CHILD_CHANGED", "child changed before archive"));
      continue;
    }
    try {
      await recordSideConversationState({
        agentId: params.agentId,
        cfg: params.cfg,
        intentId: child.intentId,
        now,
        parentSessionKey: params.parentSessionKey,
        state: "closed",
      });
    } catch (error) {
      log.warn(
        `side conversation registry mirror failed for ${sessionKey}: ${formatErrorMessage(error)}`,
      );
    }
    archivedKeys.push(sessionKey);
  }
  return { archivedKeys, preserved, remaining };
}
