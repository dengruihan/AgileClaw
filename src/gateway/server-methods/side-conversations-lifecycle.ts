/**
 * Persistent hidden side-conversation service.
 *
 * Creation reuses the ordinary `sessions.create` fork owner with the frozen M200
 * snapshot, so the child is a real session row with its own transcript, model
 * selection, and worktree lifecycle. The parent only registers the intent; it
 * never inherits the child into `childSessions`.
 *
 * Close and reopen only own the hidden child's lifecycle state: close quiesces
 * in-flight work and keeps transcript, branch, and worktree intact; reopen
 * restores the open state and never starts a run. Parent delete/archive process
 * registered children inside the parent's existing lifecycle fence using the
 * storage primitives directly, so no second lifecycle mutex is nested.
 */
import {
  ErrorCodes,
  errorShape,
  type SideConversationState,
  type SideConversationSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  buildSideConversationSessionKey,
  finalizeSideConversationIntent,
  listSideConversationRegistrations,
  listSideConversationCleanupPending,
  readSideConversationChildEntry,
  recordSideConversationState,
  reserveSideConversationIntent,
} from "../../config/sessions/side-conversation-registry.js";
import type { SideConversationSnapshotFacts } from "../../config/sessions/side-conversation-snapshot.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveFrozenParentSessionSelection } from "../session-create-model-selection.js";
import { createGatewaySession } from "../session-create-service.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isSessionVisibilityAllowed } from "../session-sharing-policy.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";
import {
  clearIntentReservation,
  findRegistrationBySessionKey,
  matchesSideConversationChild,
  projectSideConversationSummary,
  readSideConversationSnapshotFactsFromChild,
  reconcileCommittedSideConversation,
  resolveSideConversationState,
  type SideConversationResult,
} from "./side-conversations-replay.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const log = createSubsystemLogger("gateway/side-conversations");

/** The child acquired authoritative work while the close was committing. */
class SideConversationCloseBusyError extends Error {}

/** The captured child incarnation/marker moved before the close commit. */
class SideConversationCloseChangedError extends Error {}

type ParentTarget = {
  canonicalKey: string;
  entry: InternalSessionEntry;
  storePath: string;
  agentId: string;
  defaultAgentId?: string;
};

/** Resolve one durable parent row and its private registry owner. */
export async function resolveSideConversationParent(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  agentId?: string;
  assertCurrent?: () => void;
}): Promise<SideConversationResult<ParentTarget>> {
  const requested = resolveRequestedSessionAgentId(
    params.cfg,
    params.parentSessionKey,
    params.agentId,
  );
  if (!requested.ok) {
    return requested;
  }
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.cfg,
    key: params.parentSessionKey,
    agentId: requested.agentId,
    ...(params.assertCurrent ? { assertActive: params.assertCurrent } : {}),
  });
  const entry = loadSessionEntry({
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  });
  if (!entry?.sessionId) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `unknown parent session: ${params.parentSessionKey}`,
      ),
    };
  }
  if (entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "side conversations require a durable parent session",
      ),
    };
  }
  return {
    ok: true,
    value: {
      canonicalKey: target.canonicalKey,
      entry,
      storePath: target.storePath,
      agentId: target.agentId,
    },
  };
}

export async function createPersistentSideConversation(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  agentId?: string;
  intentId: string;
  label?: string;
  parentSessionKey: string;
  assertCurrent: () => void;
}): Promise<SideConversationResult<{ created: boolean; conversation: SideConversationSummary }>> {
  const parent = await resolveSideConversationParent({
    cfg: params.cfg,
    parentSessionKey: params.parentSessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    assertCurrent: params.assertCurrent,
  });
  if (!parent.ok) {
    return parent;
  }
  const target = parent.value;
  const deterministicKey = buildSideConversationSessionKey({
    agentId: target.agentId,
    parentSessionKey: target.canonicalKey,
    intentId: params.intentId,
  });
  const conflictError = (sessionKey: string) =>
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Session key ${sessionKey} is already used by another session; choose a new side-conversation intent.`,
    );

  const reconcile = async (
    child: InternalSessionEntry,
    sessionKey: string,
    snapshot?: SideConversationSnapshotFacts,
  ) =>
    await reconcileCommittedSideConversation({
      cfg: params.cfg,
      agentId: target.agentId,
      child,
      intentId: params.intentId,
      ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
      parentSessionKey: target.canonicalKey,
      sessionKey,
      storePath: target.storePath,
      ...(snapshot ? { snapshot } : {}),
    });

  const existingRegistration = findRegistrationBySessionKey(target.entry, deterministicKey)?.[1];
  const existingChild = readSideConversationChildEntry({
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: existingRegistration?.sessionKey ?? deterministicKey,
  });
  if (existingRegistration?.state === "deleting") {
    if (existingChild) {
      // A failed delete left the tombstone and the row: retry the parent action
      // instead of resurrecting a membership that is being deleted.
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Side conversation ${existingRegistration.sessionKey} is pending cleanup; retry the parent delete.`,
          { retryable: true },
        ),
      };
    }
    // The row is gone; finish the retryable membership cleanup before creating.
    await clearIntentReservation({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      parentSessionKey: target.canonicalKey,
    });
  }
  const matchesExisting = matchesSideConversationChild({
    entry: existingChild,
    intentId: params.intentId,
    ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
    parentSessionKey: target.canonicalKey,
  });
  if (matchesExisting && existingChild) {
    return await reconcile(existingChild, existingRegistration?.sessionKey ?? deterministicKey);
  }
  if (existingChild) {
    // A non-matching row (ordinary session or another intent's child) preclaimed
    // the deterministic key. Never register or list it as a side conversation.
    await clearIntentReservation({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      parentSessionKey: target.canonicalKey,
    });
    return {
      ok: false,
      error: conflictError(existingRegistration?.sessionKey ?? deterministicKey),
    };
  }

  const now = Date.now();
  const reservation = await reserveSideConversationIntent({
    agentId: target.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    now,
    ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
    parentSessionKey: target.canonicalKey,
    sessionKey: deterministicKey,
  });
  if (reservation.status === "limit-reached") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "This session already has the maximum number of side conversations.",
      ),
    };
  }
  if (reservation.status === "missing-parent") {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Parent session changed; retry the request."),
    };
  }
  const childKey = reservation.existing?.sessionKey ?? deterministicKey;
  if (reservation.existing) {
    const child = readSideConversationChildEntry({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: childKey,
    });
    if (
      matchesSideConversationChild({
        entry: child,
        intentId: params.intentId,
        ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
        parentSessionKey: target.canonicalKey,
      }) &&
      child
    ) {
      return await reconcile(child, childKey);
    }
    if (child) {
      await clearIntentReservation({
        agentId: target.agentId,
        cfg: params.cfg,
        intentId: params.intentId,
        parentSessionKey: target.canonicalKey,
      });
      return { ok: false, error: conflictError(childKey) };
    }
    // A reservation without a child row is a crash window; creating under the
    // same key and ordinal is the recovery path.
  }

  // Freeze the parent's effective selection before creating the child so a later
  // config default change cannot move it. The thinking default is resolved through
  // the same runtime catalog/route owner as the parent's Gateway row.
  const modelCatalogSnapshot = await params.context
    .loadGatewayModelCatalogSnapshot({ agentId: target.agentId })
    .catch(() => undefined);
  const frozenParentSelection = resolveFrozenParentSessionSelection({
    cfg: params.cfg,
    agentId: target.agentId,
    parentEntry: target.entry,
    parentSessionKey: target.canonicalKey,
    ...(modelCatalogSnapshot
      ? {
          modelCatalog: modelCatalogSnapshot.entries,
          modelCatalogRouteVariants: modelCatalogSnapshot.routeVariants,
        }
      : {}),
  });
  // Copy sharing only when the current config still allows it; otherwise the
  // child takes the ordinary creation default instead of failing creation.
  const parentVisibility = target.entry.visibility;
  const defaultVisibility =
    parentVisibility && isSessionVisibilityAllowed(params.cfg, parentVisibility)
      ? parentVisibility
      : undefined;
  const creation = resolveOperatorSessionCreation(params.client);
  const created = await createGatewaySession({
    cfg: params.cfg,
    getCurrentConfig: params.context.getRuntimeConfig,
    key: childKey,
    agentId: target.agentId,
    ...(params.label ? { label: params.label } : {}),
    ...(defaultVisibility ? { defaultVisibility } : {}),
    parentSessionKey: target.canonicalKey,
    fork: true,
    activeParentFork: {
      requesterSessionKey: target.canonicalKey,
      assertCurrent: params.assertCurrent,
    },
    frozenParentSelection,
    ...(creation ? { creation } : {}),
    commandSource: "side-conversation",
    ...(params.client?.connect
      ? { requestingOperatorScopes: [...(params.client.connect.scopes ?? [])] }
      : {}),
    ...(params.client?.authenticatedUserProfile?.profileId
      ? { requestingOperatorProfileId: params.client.authenticatedUserProfile.profileId }
      : {}),
    ...(params.client?.internal?.operatorRoleActor
      ? { operatorRoleActor: { ...params.client.internal.operatorRoleActor } }
      : {}),
    commitGuard: params.assertCurrent,
    sideConversation: {
      parentSessionKey: target.canonicalKey,
      ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
      intentId: params.intentId,
      ordinal: reservation.ordinal,
    },
  });
  if (!created.ok) {
    // A concurrent creator may have committed the matching child after our
    // reservation. Reconcile it; otherwise clear the reservation so a preclaimed
    // or failed key never poisons the intent.
    const committed = readSideConversationChildEntry({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: childKey,
    });
    if (
      matchesSideConversationChild({
        entry: committed,
        intentId: params.intentId,
        ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
        parentSessionKey: target.canonicalKey,
      }) &&
      committed
    ) {
      return await reconcile(committed, childKey);
    }
    await clearIntentReservation({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      parentSessionKey: target.canonicalKey,
    });
    return committed
      ? { ok: false, error: conflictError(childKey) }
      : { ok: false, error: created.error };
  }
  const snapshot =
    created.sideConversationSnapshot ??
    (target.entry.sessionId
      ? readSideConversationSnapshotFactsFromChild({
          agentId: target.agentId,
          entry:
            readSideConversationChildEntry({
              agentId: target.agentId,
              storePath: target.storePath,
              sessionKey: childKey,
            }) ?? (created.entry as InternalSessionEntry),
          parentSessionId: target.entry.sessionId,
          parentSessionKey: target.canonicalKey,
          sessionKey: childKey,
          storePath: target.storePath,
        })
      : undefined);
  const finalized = await finalizeSideConversationIntent({
    agentId: target.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    now: Date.now(),
    parentSessionKey: target.canonicalKey,
    ...(created.entry.sessionId ? { sessionId: created.entry.sessionId } : {}),
    ...(snapshot ? { snapshot } : {}),
  });
  if (!finalized) {
    log.warn(`side conversation registration finalized after the parent row moved: ${childKey}`);
  }
  const committed = readSideConversationChildEntry({
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: childKey,
  });
  const registration =
    findRegistrationBySessionKey(
      loadSessionEntry({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      }) ?? target.entry,
      childKey,
    )?.[1] ??
    (committed?.sideConversation
      ? {
          sessionKey: childKey,
          ordinal: committed.sideConversation.ordinal,
          state: committed.sideConversation.state,
          createdAt: committed.sideConversation.createdAt,
          updatedAt: committed.sideConversation.updatedAt,
          ...(snapshot ? { snapshot } : {}),
        }
      : undefined);
  if (!registration) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "side conversation registration is unavailable"),
    };
  }
  return {
    ok: true,
    value: {
      created: true,
      conversation: projectSideConversationSummary({
        cfg: params.cfg,
        agentId: target.agentId,
        parentSessionKey: target.canonicalKey,
        sessionKey: childKey,
        intentId: params.intentId,
        entry: committed ?? (created.entry as InternalSessionEntry),
        registration,
      }),
    },
  };
}

export async function listPersistentSideConversations(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  parentSessionKey: string;
  state?: SideConversationState;
  assertCurrent?: () => void;
}): Promise<
  SideConversationResult<{
    parentSessionKey: string;
    sideConversations: SideConversationSummary[];
    cleanupPending?: Array<{ intentId: string; sessionKey: string }>;
  }>
> {
  const parent = await resolveSideConversationParent({
    cfg: params.cfg,
    parentSessionKey: params.parentSessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
  });
  if (!parent.ok) {
    return parent;
  }
  const target = parent.value;
  const sideConversations: SideConversationSummary[] = [];
  for (const [intentId, registration] of listSideConversationRegistrations(target.entry)) {
    if (registration.state === "deleting") {
      // The row was deleted; only the retryable membership cleanup remains.
      continue;
    }
    const child = readSideConversationChildEntry({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: registration.sessionKey,
    });
    if (
      !matchesSideConversationChild({
        entry: child,
        intentId,
        ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
        parentSessionKey: target.canonicalKey,
      }) ||
      !child
    ) {
      // A reservation whose row was replaced by an ordinary session (or another
      // generation's child) is never presented as a side conversation.
      continue;
    }
    const state = resolveSideConversationState(child.sideConversation, registration);
    if (params.state && state !== params.state) {
      continue;
    }
    sideConversations.push(
      projectSideConversationSummary({
        cfg: params.cfg,
        agentId: target.agentId,
        parentSessionKey: target.canonicalKey,
        sessionKey: registration.sessionKey,
        intentId,
        entry: child,
        registration,
      }),
    );
  }
  const cleanupPending = listSideConversationCleanupPending(target.entry);
  return {
    ok: true,
    value: {
      parentSessionKey: target.canonicalKey,
      sideConversations,
      ...(cleanupPending.length > 0 ? { cleanupPending } : {}),
    },
  };
}

/** Close only quiesces the hidden child; transcript, branch, and worktree stay intact. */
async function transitionSideConversation(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  nextState: "open" | "closed";
  assertCurrent: () => void;
}): Promise<SideConversationResult<SideConversationSummary>> {
  const parent = await resolveSideConversationParent({
    cfg: params.cfg,
    parentSessionKey: params.parentSessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    assertCurrent: params.assertCurrent,
  });
  if (!parent.ok) {
    return parent;
  }
  const target = parent.value;
  const sessionKey = params.sessionKey.trim();
  const registration = findRegistrationBySessionKey(target.entry, sessionKey)?.[1];
  const child = readSideConversationChildEntry({
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey,
  });
  const marker = child?.sideConversation;
  if (
    !child?.sessionId ||
    !marker ||
    marker.parentSessionKey !== target.canonicalKey ||
    (registration && registration.sessionKey !== sessionKey)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `unknown side conversation under ${target.canonicalKey}: ${sessionKey}`,
      ),
    };
  }
  const state = marker.state;
  if (state === params.nextState) {
    return {
      ok: true,
      value: projectSideConversationSummary({
        cfg: params.cfg,
        agentId: target.agentId,
        parentSessionKey: target.canonicalKey,
        sessionKey,
        intentId: marker.intentId,
        entry: child,
        registration: registration ?? {
          sessionKey,
          ordinal: marker.ordinal,
          state,
          createdAt: marker.createdAt,
          updatedAt: marker.updatedAt,
        },
      }),
    };
  }
  if (params.nextState === "open" && state !== "closed") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `side conversation ${sessionKey} is ${state}; only a closed side conversation can reopen`,
      ),
    };
  }
  if (state === "merged" || state === "abandoned") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `side conversation ${sessionKey} is ${state} and cannot change state`,
      ),
    };
  }

  // The drain's admission hold stays open through the marker commit so a new
  // run cannot start between quiescing the child and persisting `closed`.
  let drain: Awaited<ReturnType<typeof prepareSessionLifecycleDrain>> | undefined;
  if (params.nextState === "closed") {
    try {
      drain = await prepareSessionLifecycleDrain({
        action: "archive",
        authorize: params.assertCurrent,
        context: params.context,
        storePath: target.storePath,
        sessionKeys: [sessionKey],
        sessionId: child.sessionId,
        sessionKey,
        agentId: target.agentId,
        lifecycleIdentities: [sessionKey, child.sessionId],
      });
    } catch (error) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Side conversation ${sessionKey} could not be stopped: ${formatErrorMessage(error)} Retry after active work finishes.`,
          { retryable: true },
        ),
      };
    }
  }

  const now = Date.now();
  let patched: InternalSessionEntry | null;
  try {
    patched = await patchSessionEntryCore(
      { agentId: target.agentId, sessionKey, storePath: target.storePath },
      (current: InternalSessionEntry) => {
        const currentMarker = current.sideConversation;
        if (
          current.sessionId !== child.sessionId ||
          !currentMarker ||
          currentMarker.parentSessionKey !== target.canonicalKey ||
          currentMarker.intentId !== marker.intentId ||
          currentMarker.state !== state
        ) {
          throw new SideConversationCloseChangedError();
        }
        return {
          ...current,
          sideConversation: {
            ...currentMarker,
            state: params.nextState,
            updatedAt: now,
            ...(params.nextState === "closed" ? { closedAt: now } : { closedAt: undefined }),
          },
        };
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
        ...(drain
          ? {
              // Caller authority and the drain's canonical work facts are
              // checked synchronously inside the commit transaction, not after.
              assertCommitAllowed: () => {
                params.assertCurrent();
                if (drain!.hasAuthoritativeWork()) {
                  throw new SideConversationCloseBusyError();
                }
              },
            }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof SideConversationCloseBusyError) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Side conversation ${sessionKey} is still active; retry the close.`,
          { retryable: true },
        ),
      };
    }
    if (error instanceof SideConversationCloseChangedError) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Side conversation ${sessionKey} changed before the update. Retry.`,
        ),
      };
    }
    throw error;
  } finally {
    drain?.release();
  }
  if (!patched) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Side conversation ${sessionKey} changed before the update. Retry.`,
      ),
    };
  }
  try {
    await recordSideConversationState({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: marker.intentId,
      now,
      parentSessionKey: target.canonicalKey,
      state: params.nextState,
    });
  } catch (error) {
    log.warn(
      `side conversation registry mirror failed for ${sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
  return {
    ok: true,
    value: projectSideConversationSummary({
      cfg: params.cfg,
      agentId: target.agentId,
      parentSessionKey: target.canonicalKey,
      sessionKey,
      intentId: marker.intentId,
      entry: patched,
      registration: registration ?? {
        sessionKey,
        ordinal: marker.ordinal,
        state: params.nextState,
        createdAt: marker.createdAt,
        updatedAt: now,
      },
    }),
  };
}

export function closePersistentSideConversation(
  params: Omit<Parameters<typeof transitionSideConversation>[0], "nextState">,
): Promise<SideConversationResult<SideConversationSummary>> {
  return transitionSideConversation({ ...params, nextState: "closed" });
}

export function reopenPersistentSideConversation(
  params: Omit<Parameters<typeof transitionSideConversation>[0], "nextState">,
): Promise<SideConversationResult<SideConversationSummary>> {
  return transitionSideConversation({ ...params, nextState: "open" });
}
