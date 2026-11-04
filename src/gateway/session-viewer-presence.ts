// Per-connection viewer presence declarations. Message subscriptions are transport state,
// while this replace-set records only the sessions a client is actually rendering.
import { upsertPresence } from "../infra/system-presence.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { recordClientPresenceActivity } from "./server/client-presence.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type SessionViewerPresenceDeclarationsDeps = {
  clients: GatewayClientRegistry;
  publishPresence: () => void;
};

type FocusedViewerIdentity = {
  /** Authenticated recipient profile; null falls back to the paired device identity. */
  userProfileId: string | null;
  deviceId: string;
};

type SessionViewerPresenceDeclarations = {
  replace: (connId: string, sessionKeys: readonly string[], focused?: boolean) => readonly string[];
  /** True when a live focused connection for this identity renders one of the sessions. */
  isFocusedForIdentity: (
    identity: FocusedViewerIdentity,
    sessionKeys: ReadonlySet<string>,
  ) => boolean;
  unsubscribe: (connId: string) => void;
  stop: () => void;
};

function normalizedSessionKeys(sessionKeys: readonly string[]): string[] {
  return [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted();
}

function sameSessionKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function isLiveClient(client: GatewayWsClient): boolean {
  return !client.invalidated && client.socket.readyState === WEBSOCKET_OPEN_READY_STATE;
}

/**
 * Owns one replace-set per websocket connection until empty declaration or disconnect.
 * Focus is private delivery context: it is retained per connection but never published
 * to other clients' presence or used for authorization.
 */
export function createSessionViewerPresenceDeclarations(
  deps: SessionViewerPresenceDeclarationsDeps,
): SessionViewerPresenceDeclarations {
  const declarations = new Map<string, readonly string[]>();
  const focusedDeclarations = new Map<string, readonly string[]>();
  let stopped = false;

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    focused = false,
  ): readonly string[] => {
    if (stopped) {
      return [];
    }
    const normalizedConnId = connId.trim();
    const client = deps.clients.getByConnectionId(normalizedConnId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return [];
    }
    const next = normalizedSessionKeys(sessionKeys);
    const previous = declarations.get(normalizedConnId) ?? [];
    const keepFocused = focused && next.length > 0;
    const focusedPrevious = focusedDeclarations.get(normalizedConnId);
    const focusedChanged = keepFocused
      ? !focusedPrevious || !sameSessionKeys(focusedPrevious, next)
      : focusedPrevious !== undefined;
    if (sameSessionKeys(previous, next)) {
      if (focusedChanged) {
        if (keepFocused) {
          focusedDeclarations.set(normalizedConnId, next);
        } else {
          focusedDeclarations.delete(normalizedConnId);
        }
      }
      return next;
    }
    if (next.length === 0) {
      declarations.delete(normalizedConnId);
    } else {
      declarations.set(normalizedConnId, next);
    }
    if (keepFocused) {
      focusedDeclarations.set(normalizedConnId, next);
    } else {
      focusedDeclarations.delete(normalizedConnId);
    }
    if (client.presenceKey) {
      upsertPresence(client.presenceKey, {
        watchedSessions: next.length > 0 ? [...next] : undefined,
      });
      if (next.length > 0) {
        recordClientPresenceActivity(deps.clients, client);
      }
      deps.publishPresence();
    }
    return next;
  };

  const isFocusedForIdentity = (
    identity: FocusedViewerIdentity,
    sessionKeys: ReadonlySet<string>,
  ): boolean => {
    if (stopped || sessionKeys.size === 0) {
      return false;
    }
    for (const [connId, focusedKeys] of focusedDeclarations) {
      const client = deps.clients.getByConnectionId(connId);
      if (!client || !isLiveClient(client)) {
        continue;
      }
      const matchesIdentity = identity.userProfileId
        ? client.authenticatedUserProfile?.profileId === identity.userProfileId
        : client.connect.device?.id === identity.deviceId;
      if (matchesIdentity && focusedKeys.some((key) => sessionKeys.has(key))) {
        return true;
      }
    }
    return false;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (normalizedConnId) {
      // The websocket close boundary publishes reason=disconnect and clears watchedSessions.
      // Delete here first so a recycled connection id can never inherit an old declaration.
      declarations.delete(normalizedConnId);
      focusedDeclarations.delete(normalizedConnId);
    }
  };

  const stop = () => {
    stopped = true;
    declarations.clear();
    focusedDeclarations.clear();
  };

  return { replace, isFocusedForIdentity, unsubscribe, stop };
}
