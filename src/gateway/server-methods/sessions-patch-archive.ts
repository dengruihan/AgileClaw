import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type PreservedSessionWorktree,
  type SessionCreatedActor,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionAccessScope } from "../../config/sessions/session-accessor.js";
import { loadSessionEntry as loadInternalSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import {
  SessionWorktreeLifecycleError,
  synchronizeSessionWorktreeArchive,
} from "../../sessions/session-worktree-lifecycle.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { WorkerInferenceSessionDrainBusyError } from "../worker-environments/inference-control-internal.js";
import {
  prepareSessionWorkerPlacementArchiveCheck,
  prepareSessionWorkerPlacementMutationCheck,
  SessionWorkerPlacementStopError,
} from "../worker-environments/session-placement-lifecycle.js";
import {
  prepareSessionLifecycleDrain,
  SessionLifecycleWorkspaceRecoveryError,
  type SessionLifecycleDrain,
} from "./sessions-lifecycle-drain.js";
import {
  sessionChangedError as archiveChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import {
  resolveProtectedSessionVisibilityError,
  resolveSessionWorkerPlacementPatchError,
  sessionLog,
} from "./sessions-shared.js";
import {
  archiveSideConversationChildrenInParentFence,
  closeSideConversationChildAdmissions,
  readRegisteredSideConversationChildren,
  resolveSideConversationArchiveBlocker,
} from "./side-conversations-fence.js";
import type { GatewayRequestContext } from "./types.js";

const preservedWorktreesByCommittedEntry = new WeakMap<object, PreservedSessionWorktree[]>();

/** Worktrees preserved by the archive afterCommit for this exact committed entry. */
export function readArchivePreservedWorktrees(
  entry: object,
): PreservedSessionWorktree[] | undefined {
  return preservedWorktreesByCommittedEntry.get(entry);
}

export type SessionPatchArchivePreparation = {
  canonicalKey: string;
  drain: SessionLifecycleDrain;
  entry?: SessionEntry;
  /** Child ingress closed for the parent action; released by the engine's cleanup. */
  childAdmissionReleases?: Array<() => void>;
};

export function releaseSessionPatchArchive(preparation?: SessionPatchArchivePreparation): void {
  try {
    for (const release of preparation?.childAdmissionReleases ?? []) {
      release();
    }
  } catch (error) {
    sessionLog.warn(
      `sessions.patch: child admission release failed for ${preparation?.canonicalKey}: ${formatErrorMessage(error)}`,
    );
  }
  try {
    preparation?.drain.release();
  } catch (error) {
    sessionLog.warn(
      `sessions.patch: archive drain release failed for ${preparation?.canonicalKey}: ${formatErrorMessage(error)}`,
    );
  }
}

export type SessionPatchArchiveTarget = {
  archiveActor: SessionCreatedActor | undefined;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  initialEntry?: SessionEntry;
  initialStoreKeys: string[];
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  requestedAgentId?: string;
  storePath: string;
};

function archiveUnavailableError(key: string, message: "active" | "stopping"): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    message === "active"
      ? `Session ${key} is still active; retry the archive.`
      : `Session ${key} did not finish stopping; retry the archive.`,
    { retryable: true },
  );
}

function archiveTargetChanged(params: {
  baselineEntry: SessionEntry | undefined;
  currentEntry: SessionEntry | undefined;
  patch: SessionsPatchParams;
}): boolean {
  const { baselineEntry, currentEntry, patch } = params;
  return (
    (patch.expectedSessionId !== undefined &&
      currentEntry?.sessionId !== patch.expectedSessionId) ||
    (patch.expectedLifecycleRevision !== undefined &&
      currentEntry?.lifecycleRevision !== patch.expectedLifecycleRevision) ||
    (baselineEntry === undefined) !== (currentEntry === undefined) ||
    currentEntry?.sessionId !== baselineEntry?.sessionId ||
    currentEntry?.lifecycleRevision !== baselineEntry?.lifecycleRevision
  );
}

export async function prepareSessionPatchArchive(params: {
  commitGuard: () => ErrorShape | undefined;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  loadGatewayModelCatalogSnapshot: () => Promise<ModelCatalogSnapshot>;
  personalModelSelection?: UserModelAccountSelection;
  pluginOwnerId?: string;
  target: SessionPatchArchiveTarget;
}): Promise<Result<SessionPatchArchivePreparation, ErrorShape>> {
  const { cfg, target } = params;
  const resolveCurrent = (): Result<
    {
      freshResolved: ReturnType<typeof resolveGatewaySessionStoreTargetWithStore>;
      fresh: ReturnType<typeof resolveCanonicalGatewaySessionStoreKey>;
      freshCanonicalKey: string;
    },
    ErrorShape
  > => {
    const freshResolved = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: target.key,
      ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
      exactRead: true,
    });
    if (freshResolved.storePath !== target.storePath) {
      return err(archiveChangedError(target.key));
    }
    const fresh = resolveCanonicalGatewaySessionStoreKey({
      cfg,
      key: target.key,
      store: freshResolved.store,
      agentId: target.requestedAgentId,
    });
    const freshCanonicalKey = fresh.target.canonicalKey ?? target.key;
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: fresh.entry,
      key: freshCanonicalKey,
      pluginOwnerId: params.pluginOwnerId,
    });
    if (ownershipError) {
      return err(ownershipError);
    }
    if (
      freshCanonicalKey !== target.canonicalKey ||
      archiveTargetChanged({
        currentEntry: fresh.entry,
        baselineEntry: target.initialEntry,
        patch: target.fullPatch,
      })
    ) {
      return err(archiveChangedError(target.key));
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      freshCanonicalKey,
      fresh.entry,
    );
    if (missingHarnessSessionError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
    }
    const protectedError = resolveProtectedSessionVisibilityError(
      cfg,
      freshCanonicalKey,
      "archive",
    );
    if (protectedError) {
      return err(protectedError);
    }
    const placementError = resolveSessionWorkerPlacementPatchError({
      agentId: freshResolved.agentId,
      cfg,
      context: params.context,
      entry: fresh.entry,
      key: target.key,
      patch: target.fullPatch,
      sessionKey: freshCanonicalKey,
      validateModelRuntime: false,
    });
    if (placementError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, placementError));
    }
    return ok({ freshResolved, fresh, freshCanonicalKey });
  };
  const resolved = resolveCurrent();
  if (!resolved.ok) {
    return resolved;
  }
  const { freshResolved, fresh, freshCanonicalKey } = resolved.value;
  const assertCurrent = () => {
    params.personalModelSelection?.assertCurrent();
    const authorizationError = params.commitGuard();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    const current = resolveCurrent();
    if (!current.ok) {
      throw new SessionMutationAuthorizationChangedError(current.error);
    }
  };
  const freshCandidateKeys = new Set(fresh.target.storeKeys);
  const preview = await projectSessionsPatchEntry({
    cfg,
    existingEntry: fresh.entry,
    isLabelInUse: (label) =>
      Object.entries(freshResolved.store).some(
        ([sessionKey, entry]) => !freshCandidateKeys.has(sessionKey) && entry.label === label,
      ),
    storeKey: fresh.primaryKey,
    agentId: target.requestedAgentId,
    patch: target.fullPatch,
    archivedBy: target.archiveActor,
    loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
    personalModelSelection: params.personalModelSelection,
  });
  if (!preview.ok) {
    return err(preview.error);
  }
  const previewPlacementError = resolveSessionWorkerPlacementPatchError({
    agentId: freshResolved.agentId,
    cfg,
    context: params.context,
    entry: preview.entry,
    key: target.key,
    patch: target.fullPatch,
    sessionKey: freshCanonicalKey,
    validateModelRuntime: true,
  });
  if (previewPlacementError) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, previewPlacementError));
  }
  try {
    const drain = await prepareSessionLifecycleDrain({
      action: "archive",
      authorize: assertCurrent,
      context: params.context,
      storePath: target.storePath,
      sessionKeys: Array.from(
        new Set([
          target.key,
          target.canonicalKey,
          ...target.initialStoreKeys,
          freshCanonicalKey,
          ...fresh.target.storeKeys,
        ]),
      ),
      sessionId: fresh.entry?.sessionId,
      sessionKey: freshCanonicalKey,
      agentId: freshResolved.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, freshCanonicalKey),
      lifecycleIdentities: target.lifecycleIdentities.filter((identity): identity is string =>
        Boolean(identity),
      ),
    });
    const parentForChildren = loadInternalSessionEntry({
      agentId: freshResolved.agentId,
      sessionKey: freshCanonicalKey,
      storePath: target.storePath,
    });
    const children = parentForChildren
      ? readRegisteredSideConversationChildren({
          agentId: freshResolved.agentId,
          parentEntry: parentForChildren,
          parentSessionKey: freshCanonicalKey,
          storePath: target.storePath,
        })
      : [];
    const childAdmissionReleases = closeSideConversationChildAdmissions({
      children,
      storePath: target.storePath,
    });
    return ok({
      canonicalKey: freshCanonicalKey,
      drain,
      ...(fresh.entry ? { entry: fresh.entry } : {}),
      ...(childAdmissionReleases.length > 0 ? { childAdmissionReleases } : {}),
    });
  } catch (error) {
    if (error instanceof SessionLifecycleWorkspaceRecoveryError) {
      return err(error.error);
    }
    if (error instanceof WorkerInferenceSessionDrainBusyError) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${target.key} is already being stopped by another archive or delete request. Wait for that request to finish.`,
          { retryable: true },
        ),
      );
    }
    if (error instanceof SessionWorkerPlacementStopError) {
      return err(errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }));
    }
    if (
      error instanceof SessionMutationAuthorizationChangedError ||
      error instanceof ModelAccountConnectAuthorityError
    ) {
      return err(unexpectedPatchError(target.key, error));
    }
    sessionLog.warn(
      `sessions.patch: archive drain failed for ${target.canonicalKey}: ${formatErrorMessage(error)}`,
    );
    return err(archiveUnavailableError(target.key, "stopping"));
  }
}

export function validateSessionPatchArchiveProjection(params: {
  cfg: OpenClawConfig;
  existingEntry: SessionEntry | undefined;
  fullPatch: SessionsPatchParams;
  key: string;
  pluginOwnerId?: string;
  preparation: SessionPatchArchivePreparation;
  primaryKey: string;
}): ErrorShape | undefined {
  if (params.preparation.drain.hasAuthoritativeWork()) {
    return archiveUnavailableError(params.key, "active");
  }
  if (
    params.primaryKey !== params.preparation.canonicalKey ||
    archiveTargetChanged({
      currentEntry: params.existingEntry,
      baselineEntry: params.preparation.entry,
      patch: params.fullPatch,
    })
  ) {
    return archiveChangedError(params.key);
  }
  return (
    resolveProtectedSessionVisibilityError(params.cfg, params.primaryKey, "archive") ??
    resolvePluginSessionOwnershipError({
      action: "patch",
      entry: params.existingEntry,
      key: params.primaryKey,
      pluginOwnerId: params.pluginOwnerId,
    })
  );
}

/** Restore before opening admission; remove only after archive metadata is durable. */
export async function prepareSessionPatchArchiveTransition(params: {
  archived: boolean;
  entry: SessionEntry;
  context: GatewayRequestContext;
  scope: SessionAccessScope;
  authorize: () => ErrorShape | undefined;
  preparation?: SessionPatchArchivePreparation;
}): Promise<{
  assertCommitAllowed: () => void;
  afterCommit?: (entry: SessionEntry) => Promise<void>;
  preservedWorktrees: PreservedSessionWorktree[];
}> {
  const placementTarget = {
    context: params.context,
    sessionId: params.entry.sessionId,
  };
  const placement = prepareSessionWorkerPlacementArchiveCheck(placementTarget);
  let assertWorktreeMutationAllowed: (() => void) | undefined;
  const commitGuard = () => {
    const authorizationError = params.authorize();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    placement.assertCurrent();
    assertWorktreeMutationAllowed?.();
    if (params.preparation?.drain.hasAuthoritativeWork()) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree is still active; retry the archive after work settles.",
        "busy",
      );
    }
  };
  const synchronize = (entry: SessionEntry) =>
    synchronizeSessionWorktreeArchive({
      archived: params.archived,
      entry,
      scope: params.scope,
      commitGuard,
      assertRestoreAllowed: () => {
        assertWorktreeMutationAllowed = prepareSessionWorkerPlacementMutationCheck(placementTarget);
      },
    });
  // Carry the exact restored binding through the later metadata commit.
  const sideParentScope = {
    agentId:
      params.scope.agentId ?? resolveAgentIdFromSessionKey(params.scope.sessionKey) ?? "main",
    sessionKey: params.scope.sessionKey,
    storePath: params.scope.storePath,
  };
  const sideStorePath = params.scope.storePath;
  const sidePreservedWorktrees: PreservedSessionWorktree[] = [];
  const sideParentEntry =
    params.archived && sideStorePath
      ? loadInternalSessionEntry({ ...sideParentScope, storePath: sideStorePath })
      : undefined;
  const sideChildren = sideParentEntry
    ? readRegisteredSideConversationChildren({
        agentId: sideParentScope.agentId,
        parentEntry: sideParentEntry,
        parentSessionKey: params.scope.sessionKey,
        storePath: sideStorePath!,
      })
    : [];
  const assertNoActiveSideChildren = () => {
    const blocker = resolveSideConversationArchiveBlocker({
      agentId: sideParentScope.agentId,
      context: params.context,
      parentEntry: sideParentEntry!,
      parentSessionKey: params.scope.sessionKey,
      storePath: sideStorePath!,
    });
    if (blocker) {
      // Archive refuses while a hidden child still owns work; closing it first
      // is the only path that keeps the child's transcript untouched.
      throw new SessionWorktreeLifecycleError(blocker.message, "busy");
    }
  };
  const assertCommitAllowed = params.archived
    ? () => {
        assertNoActiveSideChildren();
        commitGuard();
      }
    : await synchronize(params.entry);
  const worktreeAfterCommit =
    params.archived && params.entry.worktree && !placement.cleanupPending
      ? async (entry: SessionEntry) => {
          try {
            // The durable archive row hands failed cleanup to GC. Keep the lifecycle
            // fence and compare the exact committed projection, never a fresh successor.
            assertWorktreeMutationAllowed =
              prepareSessionWorkerPlacementMutationCheck(placementTarget);
            await synchronize(entry);
          } catch (error) {
            sessionLog.warn(
              `sessions.patch: archived worktree cleanup deferred for ${params.scope.sessionKey}: ${formatErrorMessage(error)}`,
            );
          }
        }
      : undefined;
  const afterCommit =
    params.archived && (worktreeAfterCommit || sideChildren.length > 0)
      ? async (entry: SessionEntry) => {
          await worktreeAfterCommit?.(entry);
          if (sideChildren.length === 0) {
            return;
          }
          const parent = sideStorePath
            ? loadInternalSessionEntry({ ...sideParentScope, storePath: sideStorePath })
            : undefined;
          if (!parent || !sideStorePath) {
            return;
          }
          const archived = await archiveSideConversationChildrenInParentFence({
            cfg: params.context.getRuntimeConfig(),
            agentId: sideParentScope.agentId,
            context: params.context,
            parentEntry: parent,
            parentSessionKey: params.scope.sessionKey,
            storePath: sideStorePath,
            commitGuard,
          });
          if (archived.ok && archived.preserved.length > 0) {
            sidePreservedWorktrees.push(...archived.preserved);
            preservedWorktreesByCommittedEntry.set(entry, [...sidePreservedWorktrees]);
          } else if (!archived.ok) {
            sessionLog.warn(
              `sessions.patch: side conversation archive deferred for ${params.scope.sessionKey}: ${archived.error.message}`,
            );
          }
        }
      : undefined;
  return { assertCommitAllowed, afterCommit, preservedWorktrees: sidePreservedWorktrees };
}
