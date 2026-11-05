import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
/** Live session device-scope facts for the tool-action audit projection. */
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";

const MAX_TRACKED_SESSION_SCOPES = 1_024;

type TrackedDeviceScope = { deviceId: string };

const sessionDeviceScopes = new Map<string, TrackedDeviceScope>();

/**
 * Hashed device reference for tool-action records. Mirrors the device-id
 * hashing convention used by device management security events, so the ledger
 * correlates a session's device without retaining the paired device id.
 */
export function hashAuditDeviceRef(deviceId: string | undefined): string | undefined {
  const normalized = deviceId?.trim();
  if (!normalized) {
    return undefined;
  }
  return `sha256:${sha256HexPrefixCore(normalized, 12)}`;
}

/**
 * Publish the device execution scope one session's placement tools run under.
 * Passing no device clears the entry, so gateway execution records no scope.
 */
export function publishToolActionDeviceScope(params: {
  sessionKey: string;
  deviceId: string | null;
}): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  if (sessionDeviceScopes.has(sessionKey)) {
    sessionDeviceScopes.delete(sessionKey);
  }
  const deviceId = params.deviceId?.trim();
  if (!deviceId) {
    return;
  }
  sessionDeviceScopes.set(sessionKey, { deviceId });
  if (sessionDeviceScopes.size > MAX_TRACKED_SESSION_SCOPES) {
    const oldest = sessionDeviceScopes.keys().next().value;
    if (oldest !== undefined) {
      sessionDeviceScopes.delete(oldest);
    }
  }
}

/** Hashed device ref for one session's active placement scope, if any. */
export function readToolActionDeviceRef(sessionKey: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return undefined;
  }
  return hashAuditDeviceRef(sessionDeviceScopes.get(normalized)?.deviceId);
}

export function clearToolActionDeviceScopesForTest(): void {
  sessionDeviceScopes.clear();
}
