/**
 * Side-conversation children inside a parent's existing lifecycle fence.
 *
 * The parent delete/archive already owns the session lifecycle mutex, so these
 * helpers use storage primitives directly and never nest another drain or
 * lifecycle mutation. An active hidden child blocks the parent action instead of
 * being killed silently; an unmerged child worktree is preserved, never removed.
 */
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type PreservedSessionWorktree,
} from "../../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunInProgress } from "../../agents/embedded-agent-runner/runs.js";
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
import { isCompetingSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
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

export type SideConversationChildFenceResult =
  | { ok: true; deletedKeys: string[]; preserved?: PreservedSessionWorktree }
  | { ok: false; error: ErrorShape };

/**
 * Delete registered children inside the parent's delete fence.
 *
 * Uses the storage lifecycle primitive directly; the parent already owns the
 * session lifecycle mutex, so a nested drain/mutation is deliberately avoided.
 * Any child with authoritative work fails the parent delete with a retryable
 * error instead of being killed silently.
 */
export async function deleteSideConversationChildrenInParentFence(params: {
  agentId: string;
  context: GatewayRequestContext;
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
        entry: child.entry,
        sessionKey: child.registration.sessionKey,
        storePath: params.storePath,
      })
    ) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Side conversation ${child.registration.sessionKey} is still active; close it before deleting the parent.`,
          { retryable: true },
        ),
      };
    }
  }
  const deletedKeys: string[] = [];
  let preserved: PreservedSessionWorktree | undefined;
  for (const child of children) {
    const sessionKey = child.registration.sessionKey;
    params.commitGuard();
    const result = await deleteSessionEntryLifecycle({
      agentId: params.agentId,
      archiveTranscript: params.deleteTranscript,
      commitGuard: params.commitGuard,
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
      commitGuard: params.commitGuard,
    });
    if (childPreserved) {
      if (preserved) {
        log.warn(
          `another preserved side conversation worktree was kept: ${childPreserved.branch} (${childPreserved.path})`,
        );
      } else {
        preserved = childPreserved;
      }
    }
    deletedKeys.push(sessionKey);
  }
  return { ok: true, deletedKeys, ...(preserved ? { preserved } : {}) };
}

export type SideConversationArchiveFenceResult =
  | { ok: true; archivedKeys: string[]; preserved: PreservedSessionWorktree[] }
  | { ok: false; error: ErrorShape };

/** Reject a parent archive while any registered child still owns live work. */
export function resolveSideConversationArchiveBlocker(params: {
  agentId: string;
  context: GatewayRequestContext;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  storePath: string;
}): ErrorShape | undefined {
  for (const child of readRegisteredSideConversationChildren(params)) {
    if (
      sideConversationActiveWork({
        agentId: params.agentId,
        context: params.context,
        entry: child.entry,
        sessionKey: child.registration.sessionKey,
        storePath: params.storePath,
      })
    ) {
      return errorShape(
        ErrorCodes.UNAVAILABLE,
        `Side conversation ${child.registration.sessionKey} is still active; close it before archiving the parent.`,
        { retryable: true },
      );
    }
  }
  return undefined;
}

/**
 * Archive registered children after the parent archive commits, still inside the
 * parent's mutation lane. An unmerged child worktree is preserved and reported
 * instead of silently discarded.
 */
export async function archiveSideConversationChildrenInParentFence(params: {
  cfg: OpenClawConfig;
  agentId: string;
  context: GatewayRequestContext;
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
    params.commitGuard();
    const entry = readSideConversationChildEntry({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey,
    });
    if (!entry?.sessionId || entry.archivedAt !== undefined) {
      continue;
    }
    if (
      sideConversationActiveWork({
        agentId: params.agentId,
        context: params.context,
        entry,
        sessionKey,
        storePath: params.storePath,
      })
    ) {
      // The pre-commit guard checked this too, but work can arrive before the
      // after-commit callback. Never archive over live work.
      log.warn(`side conversation ${sessionKey} stayed active; archive skipped`);
      continue;
    }
    const committed = await patchSessionEntryCore(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      (current: InternalSessionEntry) => ({
        ...current,
        archivedAt: now,
        archiveReason: "manual" as const,
        ...(current.sideConversation
          ? {
              sideConversation: {
                ...current.sideConversation,
                state: "closed" as const,
                updatedAt: now,
                closedAt: current.sideConversation.closedAt ?? now,
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
        commitGuard: params.commitGuard,
      });
    } catch (error) {
      if (error instanceof SessionWorktreeLifecycleError) {
        // Keep the archived row and the preserved branch; nothing is deleted.
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
