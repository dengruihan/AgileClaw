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
  type ErrorShape,
  type SideConversationState,
  type SideConversationSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  buildSideConversationSessionKey,
  finalizeSideConversationIntent,
  listSideConversationRegistrations,
  readSideConversationChildEntry,
  recordSideConversationState,
  removeSideConversationIntent,
  reserveSideConversationIntent,
} from "../../config/sessions/side-conversation-registry.js";
import type {
  SideConversationMarker,
  SideConversationRegistryEntry,
} from "../../config/sessions/side-conversation-types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { createGatewaySession } from "../session-create-service.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { isSessionVisibilityAllowed } from "../session-sharing-policy.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const log = createSubsystemLogger("gateway/side-conversations");

export type SideConversationResult<T> = { ok: true; value: T } | { ok: false; error: ErrorShape };

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

function resolveSideConversationState(
  marker: SideConversationMarker | undefined,
  registration: SideConversationRegistryEntry,
): SideConversationState {
  return marker?.state ?? registration.state;
}

/** Project one row into the bounded wire summary; never exposes private registry facts. */
function projectSideConversationSummary(params: {
  cfg: OpenClawConfig;
  agentId: string;
  parentSessionKey: string;
  sessionKey: string;
  intentId: string;
  entry: InternalSessionEntry | undefined;
  registration: SideConversationRegistryEntry;
}): SideConversationSummary {
  const marker = params.entry?.sideConversation;
  const selected = params.entry
    ? resolveSessionModelRef(params.cfg, params.entry, params.agentId)
    : undefined;
  const snapshot = params.registration.snapshot;
  const closedAt = marker?.closedAt ?? params.registration.closedAt;
  const title = params.entry?.label ?? params.entry?.displayName;
  return {
    sessionKey: params.sessionKey,
    ...(params.entry?.sessionId ? { sessionId: params.entry.sessionId } : {}),
    parentSessionKey: params.parentSessionKey,
    ...(marker?.parentSessionId ? { parentSessionId: marker.parentSessionId } : {}),
    intentId: marker?.intentId ?? params.intentId,
    ordinal: marker?.ordinal ?? params.registration.ordinal,
    state: resolveSideConversationState(marker, params.registration),
    createdAt: marker?.createdAt ?? params.registration.createdAt,
    updatedAt: marker?.updatedAt ?? params.registration.updatedAt,
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(title ? { title } : {}),
    ...(selected?.model ? { modelProvider: selected.provider, model: selected.model } : {}),
    ...(snapshot
      ? {
          snapshot: {
            sourceSessionKey: snapshot.sourceSessionKey,
            sourceSessionId: snapshot.sourceSessionId,
            ...(snapshot.sourceLeafEntryId !== undefined
              ? { sourceLeafEntryId: snapshot.sourceLeafEntryId }
              : {}),
            projectionVersion: snapshot.projectionVersion,
            retainedMessages: snapshot.retainedMessages,
            droppedIncompleteToolRounds: snapshot.droppedIncompleteToolRounds,
            droppedIncompleteAssistantMessages: snapshot.droppedIncompleteAssistantMessages,
            droppedOrphanToolResults: snapshot.droppedOrphanToolResults,
            droppedContextExcludedMessages: snapshot.droppedContextExcludedMessages,
            droppedNonMessageEntries: snapshot.droppedNonMessageEntries,
            droppedCustomMessages: snapshot.droppedCustomMessages,
          },
        }
      : {}),
  };
}

function findRegistrationBySessionKey(
  parentEntry: InternalSessionEntry,
  sessionKey: string,
): [string, SideConversationRegistryEntry] | undefined {
  return listSideConversationRegistrations(parentEntry).find(
    ([, registration]) => registration.sessionKey === sessionKey,
  );
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
  const existingRegistration = findRegistrationBySessionKey(target.entry, deterministicKey)?.[1];
  const existingChild = readSideConversationChildEntry({
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: existingRegistration?.sessionKey ?? deterministicKey,
  });
  const existingMarker = existingChild?.sideConversation;
  const rawIntentMatches =
    existingMarker?.intentId === params.intentId &&
    existingMarker.parentSessionKey === target.canonicalKey;
  if (rawIntentMatches && existingChild && existingMarker) {
    // Retry after a restart (or a lost registry write): the deterministic child
    // key is the durable commit point, so reuse it and heal the registration.
    await reserveSideConversationIntent({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      now: Date.now(),
      ...(target.entry.sessionId ? { parentSessionId: target.entry.sessionId } : {}),
      parentSessionKey: target.canonicalKey,
      sessionKey: deterministicKey,
    });
    await finalizeSideConversationIntent({
      agentId: target.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      now: Date.now(),
      parentSessionKey: target.canonicalKey,
      ...(existingChild.sessionId ? { sessionId: existingChild.sessionId } : {}),
    });
    const registration = findRegistrationBySessionKey(
      loadSessionEntry({
        agentId: target.agentId,
        sessionKey: target.canonicalKey,
        storePath: target.storePath,
      }) ?? target.entry,
      deterministicKey,
    )?.[1] ?? {
      sessionKey: deterministicKey,
      ordinal: existingMarker.ordinal,
      state: existingMarker.state,
      createdAt: existingMarker.createdAt,
      updatedAt: existingMarker.updatedAt,
    };
    return {
      ok: true,
      value: {
        created: false,
        conversation: projectSideConversationSummary({
          cfg: params.cfg,
          agentId: target.agentId,
          parentSessionKey: target.canonicalKey,
          sessionKey: deterministicKey,
          intentId: params.intentId,
          entry: existingChild,
          registration,
        }),
      },
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
    if (child?.sideConversation?.intentId === params.intentId) {
      return {
        ok: true,
        value: {
          created: false,
          conversation: projectSideConversationSummary({
            cfg: params.cfg,
            agentId: target.agentId,
            parentSessionKey: target.canonicalKey,
            sessionKey: childKey,
            intentId: params.intentId,
            entry: child,
            registration: reservation.existing,
          }),
        },
      };
    }
  }

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
    // A failed create must not leave a phantom reservation; the next retry
    // reserves the same ordinal and key again.
    if (
      !readSideConversationChildEntry({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: childKey,
      })
    ) {
      await removeSideConversationIntent({
        agentId: target.agentId,
        cfg: params.cfg,
        intentId: params.intentId,
        parentSessionKey: target.canonicalKey,
      }).catch((error: unknown) => {
        log.warn(`side conversation reservation cleanup failed: ${formatErrorMessage(error)}`);
      });
    }
    return { ok: false, error: created.error };
  }
  const finalized = await finalizeSideConversationIntent({
    agentId: target.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    now: Date.now(),
    parentSessionKey: target.canonicalKey,
    ...(created.entry.sessionId ? { sessionId: created.entry.sessionId } : {}),
    ...(created.sideConversationSnapshot ? { snapshot: created.sideConversationSnapshot } : {}),
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
          ...(created.sideConversationSnapshot
            ? { snapshot: created.sideConversationSnapshot }
            : {}),
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
    const child = readSideConversationChildEntry({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: registration.sessionKey,
    });
    if (
      child?.sideConversation &&
      child.sideConversation.parentSessionKey !== target.canonicalKey
    ) {
      continue;
    }
    const state = resolveSideConversationState(child?.sideConversation, registration);
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
  return { ok: true, value: { parentSessionKey: target.canonicalKey, sideConversations } };
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
          return null;
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
      { replaceEntry: true, skipMaintenance: true },
    );
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
