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
  type ErrorShape,
  type PreservedSessionWorktree,
} from "../../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunInProgress } from "../../agents/embedded-agent-runner/runs.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  listSideConversationRegistrations,
  readSideConversationChildEntry,
  recordSideConversationState,
} from "../../config/sessions/side-conversation-registry.js";
import type { SideConversationRegistryEntry } from "../../config/sessions/side-conversation-types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  closeSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { handleSessionStateSessionDeleted } from "../../sessions/session-state-events.js";
import {
  removeSessionWorktree,
  SessionWorktreeLifecycleError,
  synchronizeSessionWorktreeArchive,
} from "../../sessions/session-worktree-lifecycle.js";
import { hasGatewaySessionAbortOwner } from "./chat-abort-authorization.js";
import type { GatewayRequestContext } from "./types.js";

const log = createSubsystemLogger("gateway/side-conversations");

type RegisteredChild = {
  registration: SideConversationRegistryEntry;
  entry: InternalSessionEntry;
};

/** A child became active after the parent action passed its preflight. */
class SideConversationChildActiveError extends Error {
  constructor(readonly sessionKey: string) {
    super(`Side conversation ${sessionKey} became active`);
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
  for (const [, registration] of listSideConversationRegistrations(params.parentEntry)) {
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
    children.push({ registration, entry });
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
  return (
    params.entry.status === "running" ||
    (Boolean(sessionId) && isEmbeddedAgentRunInProgress(sessionId)) ||
    isCompetingSessionWorkAdmissionActive(params.storePath, [
      params.sessionKey,
      ...(sessionId ? [sessionId] : []),
    ]) ||
    hasGatewaySessionAbortOwner({
      context: params.context,
      sessionKeys: [params.sessionKey],
      ...(sessionId ? { sessionId } : {}),
      agentId: params.agentId,
      ...(params.defaultAgentId ? { defaultAgentId: params.defaultAgentId } : {}),
    })
  );
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
  return params.children.map((child) =>
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

function childActiveError(sessionKey: string, action: "deleting" | "archiving"): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Side conversation ${sessionKey} became active; close it before ${action} the parent.`,
    { retryable: true },
  );
}

export type SideConversationChildFenceResult =
  | { ok: true; deletedKeys: string[]; preserved: PreservedSessionWorktree[] }
  | { ok: false; error: ErrorShape };

/**
 * Delete registered children inside the parent's delete fence.
 *
 * Child admission is closed before the first durable write and every write
 * rechecks authoritative liveness, so work accepted after the preflight aborts
 * the parent delete with the child intact. No nested drain/mutation is used.
 */
export async function deleteSideConversationChildrenInParentFence(params: {
  agentId: string;
  context: GatewayRequestContext;
  defaultAgentId?: string;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
  deleteTranscript: boolean;
  commitGuard: () => void;
}): Promise<SideConversationChildFenceResult> {
  const children = readRegisteredSideConversationChildren(params);
  for (const child of children) {
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
        ok: false,
        error: childActiveError(child.registration.sessionKey, "deleting"),
      };
    }
  }
  const releases = closeSideConversationChildAdmissions({ children, storePath: params.storePath });
  const deletedKeys: string[] = [];
  const preserved: PreservedSessionWorktree[] = [];
  try {
    for (const [index, child] of children.entries()) {
      const sessionKey = child.registration.sessionKey;
      const guard = childWriteGuard({ ...params, child });
      try {
        // The admission was closed before this write; an already accepted run
        // still fails the authoritative guard below.
        guard();
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
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Side conversation ${sessionKey} changed before deletion. Retry.`,
            ),
          };
        }
        handleSessionStateSessionDeleted(sessionKey, params.agentId);
        const childPreserved = await removeSessionWorktree({
          id: child.entry.worktree?.id,
          sessionKey,
          reason: "session-delete",
          commitGuard: guard,
        });
        if (childPreserved) {
          preserved.push(childPreserved);
        }
        deletedKeys.push(sessionKey);
      } catch (error) {
        if (error instanceof SideConversationChildActiveError) {
          return { ok: false, error: childActiveError(error.sessionKey, "deleting") };
        }
        throw error;
      } finally {
        releases[index]?.();
      }
    }
  } finally {
    for (const release of releases) {
      release();
    }
  }
  return { ok: true, deletedKeys, preserved };
}

export type SideConversationArchiveFenceResult =
  | { ok: true; archivedKeys: string[]; preserved: PreservedSessionWorktree[] }
  | { ok: false; error: ErrorShape };

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
      return childActiveError(child.registration.sessionKey, "archiving");
    }
  }
  return undefined;
}

/** Read the preserved worktree record after archive cleanup refused to remove it. */
function readPreservedChildWorktree(
  entry: InternalSessionEntry,
  reason: SessionWorktreeLifecycleError["reason"],
): PreservedSessionWorktree | undefined {
  const id = entry.worktree?.id;
  if (!id) {
    return undefined;
  }
  const record = getRegistryWorktree(process.env, id);
  return {
    id,
    branch: record?.branch ?? entry.worktree?.branch ?? "",
    path: record?.path ?? "",
    reason: reason as PreservedSessionWorktree["reason"],
  };
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
  const now = Date.now();
  for (const child of readRegisteredSideConversationChildren(params)) {
    const sessionKey = child.registration.sessionKey;
    const entry = readSideConversationChildEntry({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
    });
    if (!entry?.sessionId || entry.archivedAt !== undefined) {
      continue;
    }
    const current: RegisteredChild = { registration: child.registration, entry };
    const guard = childWriteGuard({ ...params, child: current });
    try {
      guard();
    } catch (error) {
      if (error instanceof SideConversationChildActiveError) {
        // Child admission was closed before the parent commit; an already
        // accepted run must still leave the child untouched.
        return { ok: false, error: childActiveError(error.sessionKey, "archiving") };
      }
      throw error;
    }
    const committed = await patchSessionEntryCore(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      (currentEntry: InternalSessionEntry) => ({
        ...currentEntry,
        archivedAt: now,
        archiveReason: "manual" as const,
        ...(currentEntry.sideConversation
          ? {
              sideConversation: {
                ...currentEntry.sideConversation,
                state: "closed" as const,
                updatedAt: now,
                closedAt: currentEntry.sideConversation.closedAt ?? now,
              },
            }
          : {}),
      }),
      { replaceEntry: true, skipMaintenance: true },
    );
    if (!committed) {
      continue;
    }
    try {
      await synchronizeSessionWorktreeArchive({
        archived: true,
        entry: committed,
        scope: { agentId: params.agentId, sessionKey, storePath: params.storePath },
        commitGuard: guard,
      });
    } catch (error) {
      if (error instanceof SessionWorktreeLifecycleError) {
        // Keep the archived row and the preserved branch; report the location.
        const record = readPreservedChildWorktree(committed, error.reason);
        if (record) {
          preserved.push(record);
        }
        log.warn(`side conversation worktree preserved for ${sessionKey}: ${error.message}`);
      } else {
        throw error;
      }
    }
    try {
      await recordSideConversationState({
        agentId: params.agentId,
        cfg: params.cfg,
        intentId: committed.sideConversation?.intentId ?? child.entry.sideConversation!.intentId,
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
  return { ok: true, archivedKeys, preserved };
}
