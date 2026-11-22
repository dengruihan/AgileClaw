/**
 * Shared side-conversation target resolution and marker commits.
 *
 * The parent row is the authorization boundary for its hidden children. Every
 * transition captures the child incarnation and marker state, then rechecks both
 * inside the durable write so a replaced or moved child is never overwritten.
 */
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SideConversationState,
  type SideConversationSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  readSideConversationChildEntry,
  recordSideConversationState,
} from "../../config/sessions/side-conversation-registry.js";
import type { SideConversationRegistryEntry } from "../../config/sessions/side-conversation-types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import { sideConversationActiveWork } from "./side-conversations-fence.js";
import {
  findRegistrationBySessionKey,
  projectSideConversationSummary,
  type SideConversationResult,
} from "./side-conversations-replay.js";
import type { GatewayRequestContext } from "./types.js";

const log = createSubsystemLogger("gateway/side-conversations");

/** Shared subsystem logger for the side-conversation owners. */
export { log as sideConversationLog };

/** The child or its parent acquired authoritative work while the state was committing. */
export class SideConversationBusyError extends Error {}

/** The captured child incarnation/marker moved before the state commit. */
export class SideConversationChangedError extends Error {}

export type ParentTarget = {
  canonicalKey: string;
  entry: InternalSessionEntry;
  storePath: string;
  agentId: string;
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

export type SideConversationChildTarget = {
  target: ParentTarget;
  registration?: SideConversationRegistryEntry;
  child: InternalSessionEntry;
  sessionId: string;
  marker: NonNullable<InternalSessionEntry["sideConversation"]>;
};

/** Resolve one registered hidden child of an explicit parent. */
export async function resolveSideConversationChildTarget(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  parentSessionKey: string;
  sessionKey: string;
  assertCurrent: () => void;
}): Promise<SideConversationResult<SideConversationChildTarget>> {
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
  return {
    ok: true,
    value: {
      target,
      ...(registration ? { registration } : {}),
      child,
      sessionId: child.sessionId,
      marker,
    },
  };
}

export function summarizeSideConversation(params: {
  cfg: OpenClawConfig;
  entry: InternalSessionEntry;
  intentId: string;
  registration?: SideConversationRegistryEntry;
  sessionKey: string;
  target: ParentTarget;
}): SideConversationSummary {
  const marker = params.entry.sideConversation;
  return projectSideConversationSummary({
    cfg: params.cfg,
    agentId: params.target.agentId,
    parentSessionKey: params.target.canonicalKey,
    sessionKey: params.sessionKey,
    intentId: params.intentId,
    entry: params.entry,
    parentEntry: params.target.entry,
    registration: params.registration ?? {
      sessionKey: params.sessionKey,
      ordinal: marker?.ordinal ?? 1,
      state: marker?.state ?? "open",
      createdAt: marker?.createdAt ?? 0,
      updatedAt: marker?.updatedAt ?? 0,
    },
  });
}

/**
 * Persist one marker transition with the exact captured incarnation/state.
 *
 * `closedAt` is owned by close/open only: merge and abandon keep the close
 * timestamp they inherited so the history stays readable.
 */
export async function commitSideConversationState(params: {
  assertCommitAllowed?: () => void;
  child: InternalSessionEntry;
  marker: NonNullable<InternalSessionEntry["sideConversation"]>;
  nextState: SideConversationState;
  now: number;
  sessionKey: string;
  storePath: string;
  agentId: string;
}): Promise<InternalSessionEntry | null> {
  try {
    return await patchSessionEntryCore(
      { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
      (current: InternalSessionEntry) => {
        const currentMarker = current.sideConversation;
        if (
          current.sessionId !== params.child.sessionId ||
          !currentMarker ||
          currentMarker.parentSessionKey !== params.marker.parentSessionKey ||
          currentMarker.intentId !== params.marker.intentId ||
          currentMarker.state !== params.marker.state
        ) {
          throw new SideConversationChangedError();
        }
        return {
          ...current,
          sideConversation: {
            ...currentMarker,
            state: params.nextState,
            updatedAt: params.now,
            ...(params.nextState === "closed" ? { closedAt: params.now } : {}),
            ...(params.nextState === "open" ? { closedAt: undefined } : {}),
          },
        };
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
        ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
      },
    );
  } catch (error) {
    if (error instanceof SideConversationChangedError) {
      return null;
    }
    throw error;
  }
}

/** A manual handoff requires both sides to be quiet; a running side cannot be merged. */
export function assertSideConversationIdle(params: {
  agentId: string;
  assertCurrent: () => void;
  child: InternalSessionEntry;
  context: GatewayRequestContext;
  sessionKey: string;
  storePath: string;
  target: ParentTarget;
}): void {
  params.assertCurrent();
  const active = (entry: InternalSessionEntry, sessionKey: string) =>
    sideConversationActiveWork({
      agentId: params.agentId,
      context: params.context,
      entry,
      sessionKey,
      storePath: params.storePath,
    });
  if (
    active(params.child, params.sessionKey) ||
    active(params.target.entry, params.target.canonicalKey)
  ) {
    throw new SideConversationBusyError();
  }
}

export function busyErrorShape(sessionKey: string, action: string): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Side conversation ${sessionKey} or its parent is still active; retry the ${action} after active work finishes.`,
    { retryable: true },
  );
}

export function changedErrorShape(sessionKey: string): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `Side conversation ${sessionKey} changed before the update. Retry.`,
  );
}

export async function mirrorSideConversationState(params: {
  cfg: OpenClawConfig;
  intentId: string;
  now: number;
  parentSessionKey: string;
  sessionKey: string;
  state: SideConversationState;
  agentId: string;
}): Promise<void> {
  try {
    await recordSideConversationState({
      agentId: params.agentId,
      cfg: params.cfg,
      intentId: params.intentId,
      now: params.now,
      parentSessionKey: params.parentSessionKey,
      state: params.state,
    });
  } catch (error) {
    log.warn(
      `side conversation registry mirror failed for ${params.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}
