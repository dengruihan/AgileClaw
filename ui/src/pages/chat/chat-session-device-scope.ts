import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsListResult } from "../../api/types.ts";
import { normalizeDefaultMainSessionAliasForUi } from "../../lib/sessions/session-key.ts";

export type ChatSessionDeviceScope = {
  deviceId: string;
  /** Display name from the session row; absent falls back to the device id. */
  deviceName?: string;
  leaseHeld: boolean;
};

/**
 * Reads the selected session's device scope from its roster row. Scope is
 * creation metadata; the lease fact is the Gateway's mirror of the node's
 * occupancy report and drives the Stop affordance.
 */
export function resolveChatSessionDeviceScope(host: {
  sessionKey: string;
  sessionsResult?: SessionsListResult | null;
}): ChatSessionDeviceScope | null {
  const key = normalizeDefaultMainSessionAliasForUi(host.sessionKey);
  if (!key) {
    return null;
  }
  const row = host.sessionsResult?.sessions.find(
    (session) => normalizeDefaultMainSessionAliasForUi(session.key) === key,
  );
  const deviceId = normalizeOptionalString(row?.scopeDeviceId);
  if (!deviceId) {
    return null;
  }
  const deviceName = normalizeOptionalString(row?.scopeDeviceName);
  return {
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    leaseHeld: row?.scopeLeaseHeld === true,
  };
}
