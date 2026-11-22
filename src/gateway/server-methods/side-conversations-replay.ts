/**
 * Side-conversation replay and projection helpers.
 *
 * Stateless owners shared by creation, listing, and crash recovery: the wire
 * summary projection never exposes the private registry, and reconciliation
 * heals a committed child whose registry write was lost.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SideConversationState,
  type SideConversationSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  finalizeSideConversationIntent,
  listSideConversationRegistrations,
  removeSideConversationIntent,
  reserveSideConversationIntent,
} from "../../config/sessions/side-conversation-registry.js";
import {
  SIDE_CONVERSATION_SNAPSHOT_CUSTOM_TYPE,
  type SideConversationSnapshotFacts,
} from "../../config/sessions/side-conversation-snapshot.js";
import type {
  SideConversationMarker,
  SideConversationRegistryEntry,
} from "../../config/sessions/side-conversation-types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export type SideConversationResult<T> = { ok: true; value: T } | { ok: false; error: ErrorShape };

const log = createSubsystemLogger("gateway/side-conversations");

export function resolveSideConversationState(
  marker: SideConversationMarker | undefined,
  registration: SideConversationRegistryEntry,
): SideConversationState {
  return marker?.state ?? registration.state;
}

/** Project one row into the bounded wire summary; never exposes private registry facts. */
export function projectSideConversationSummary(params: {
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

export function findRegistrationBySessionKey(
  parentEntry: InternalSessionEntry,
  sessionKey: string,
): [string, SideConversationRegistryEntry] | undefined {
  return listSideConversationRegistrations(parentEntry).find(
    ([, registration]) => registration.sessionKey === sessionKey,
  );
}

export function matchesSideConversationChild(params: {
  entry: InternalSessionEntry | undefined;
  intentId: string;
  parentSessionId?: string;
  parentSessionKey: string;
}): boolean {
  const marker = params.entry?.sideConversation;
  if (!marker || marker.intentId !== params.intentId) {
    return false;
  }
  if (marker.parentSessionKey !== params.parentSessionKey) {
    return false;
  }
  // A same-key parent reset is a different incarnation; never reuse a child that
  // belongs to the previous parent generation.
  return (
    !params.parentSessionId ||
    !marker.parentSessionId ||
    marker.parentSessionId === params.parentSessionId
  );
}

/** Recover frozen snapshot facts from the child's own M200 boundary row. */
export function readSideConversationSnapshotFactsFromChild(params: {
  agentId: string;
  entry: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
}): SideConversationSnapshotFacts | undefined {
  if (!params.entry.sessionId) {
    return undefined;
  }
  let events: ReturnType<typeof loadTranscriptEventsSync>;
  try {
    events = loadTranscriptEventsSync({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.entry.sessionId,
      storePath: params.storePath,
    });
  } catch {
    return undefined;
  }
  for (const event of events.toReversed()) {
    if (!isRecord(event) || event.type !== "custom_message") {
      continue;
    }
    if (event.customType !== SIDE_CONVERSATION_SNAPSHOT_CUSTOM_TYPE) {
      continue;
    }
    const details = isRecord(event.details) ? event.details : undefined;
    const snapshot = isRecord(details?.snapshot) ? details.snapshot : undefined;
    if (
      !snapshot ||
      typeof snapshot.sourceSessionKey !== "string" ||
      typeof snapshot.sourceSessionId !== "string" ||
      typeof snapshot.projectionVersion !== "number" ||
      typeof snapshot.retainedMessages !== "number"
    ) {
      return undefined;
    }
    return {
      sourceSessionKey: snapshot.sourceSessionKey,
      sourceSessionId: snapshot.sourceSessionId,
      sourceLeafEntryId:
        typeof snapshot.sourceLeafEntryId === "string" ? snapshot.sourceLeafEntryId : null,
      projectionVersion: snapshot.projectionVersion,
      retainedMessages: snapshot.retainedMessages,
      droppedIncompleteToolRounds:
        typeof snapshot.droppedIncompleteToolRounds === "number"
          ? snapshot.droppedIncompleteToolRounds
          : 0,
      droppedIncompleteAssistantMessages:
        typeof snapshot.droppedIncompleteAssistantMessages === "number"
          ? snapshot.droppedIncompleteAssistantMessages
          : 0,
      droppedOrphanToolResults:
        typeof snapshot.droppedOrphanToolResults === "number"
          ? snapshot.droppedOrphanToolResults
          : 0,
      droppedContextExcludedMessages:
        typeof snapshot.droppedContextExcludedMessages === "number"
          ? snapshot.droppedContextExcludedMessages
          : 0,
      droppedNonMessageEntries:
        typeof snapshot.droppedNonMessageEntries === "number"
          ? snapshot.droppedNonMessageEntries
          : 0,
      droppedCustomMessages:
        typeof snapshot.droppedCustomMessages === "number" ? snapshot.droppedCustomMessages : 0,
    };
  }
  return undefined;
}

/** Remove only the reservation for this intent; never touch another intent. */
export async function clearIntentReservation(params: {
  agentId: string;
  cfg: OpenClawConfig;
  intentId: string;
  parentSessionKey: string;
}): Promise<void> {
  await removeSideConversationIntent({
    agentId: params.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    parentSessionKey: params.parentSessionKey,
  }).catch((error: unknown) => {
    log.warn(`side conversation reservation cleanup failed: ${formatErrorMessage(error)}`);
  });
}

/**
 * Return an already committed matching child for this intent.
 *
 * The deterministic key is the durable commit point, so a replay heals a missing
 * or partial registration instead of creating a second child. Snapshot facts
 * come from the child transcript when the registry write never landed.
 */
export async function reconcileCommittedSideConversation(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  intentId: string;
  parentSessionId?: string;
  parentSessionKey: string;
  sessionKey: string;
  storePath: string;
  snapshot?: SideConversationSnapshotFacts;
}): Promise<SideConversationResult<{ created: boolean; conversation: SideConversationSummary }>> {
  const snapshot =
    params.snapshot ??
    readSideConversationSnapshotFactsFromChild({
      agentId: params.agentId,
      entry: params.child,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  const registration = await reserveSideConversationIntent({
    agentId: params.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    now: Date.now(),
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
  });
  if (registration.status !== "reserved") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "side conversation registration could not be recovered",
      ),
    };
  }
  await finalizeSideConversationIntent({
    agentId: params.agentId,
    cfg: params.cfg,
    intentId: params.intentId,
    now: Date.now(),
    parentSessionKey: params.parentSessionKey,
    ...(params.child.sessionId ? { sessionId: params.child.sessionId } : {}),
    ...(snapshot ? { snapshot } : {}),
  });
  const parentEntry = loadSessionEntry({
    agentId: params.agentId,
    sessionKey: params.parentSessionKey,
    storePath: params.storePath,
  });
  const healed = parentEntry
    ? findRegistrationBySessionKey(parentEntry, params.sessionKey)?.[1]
    : undefined;
  const marker = params.child.sideConversation!;
  const resolvedRegistration = healed ??
    registration.existing ?? {
      sessionKey: params.sessionKey,
      ordinal: marker.ordinal,
      state: marker.state,
      createdAt: marker.createdAt,
      updatedAt: marker.updatedAt,
      ...(snapshot ? { snapshot } : {}),
    };
  return {
    ok: true,
    value: {
      created: false,
      conversation: projectSideConversationSummary({
        cfg: params.cfg,
        agentId: params.agentId,
        parentSessionKey: params.parentSessionKey,
        sessionKey: params.sessionKey,
        intentId: params.intentId,
        entry: params.child,
        registration: resolvedRegistration,
      }),
    },
  };
}
