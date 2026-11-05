import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
/** Live session device-scope facts for the tool-action audit projection. */
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";

const MAX_TRACKED_SESSION_SCOPES = 1_024;

/** `null` records a known gateway scope so it is not re-read on every event. */
type TrackedDeviceScope = { deviceId: string | null };

/**
 * Resolve one session's current placement scope from its owner. `undefined`
 * means the owner could not answer yet and the next event may retry; `null`
 * means the session resolved to gateway scope.
 */
export type ToolActionDeviceScopeResolver = (sessionKey: string) => string | null | undefined;

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

function rememberSessionDeviceScope(sessionKey: string, deviceId: string | null): void {
  sessionDeviceScopes.delete(sessionKey);
  sessionDeviceScopes.set(sessionKey, { deviceId });
  if (sessionDeviceScopes.size > MAX_TRACKED_SESSION_SCOPES) {
    const oldest = sessionDeviceScopes.keys().next().value;
    if (oldest !== undefined) {
      sessionDeviceScopes.delete(oldest);
    }
  }
}

/**
 * Publish the device execution scope one session's placement tools run under.
 * `null` records an explicit gateway scope, so gateway execution reports no
 * device without asking the session owner again.
 */
export function publishToolActionDeviceScope(params: {
  sessionKey: string;
  deviceId: string | null;
}): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  rememberSessionDeviceScope(sessionKey, normalizeOptionalString(params.deviceId) ?? null);
}

/**
 * Drop every cached placement scope so the next event re-reads the committed
 * session entry. Scope changes are rare; this keeps child-session entries
 * consistent with a root scope write without tracking the lineage here.
 */
export function invalidateToolActionDeviceScopes(): void {
  sessionDeviceScopes.clear();
}

/**
 * Hashed device ref for one session. A cached scope wins; otherwise the owner
 * resolver seeds it once per session (restart, session create, or the first
 * event after a scope change), so started/finished and later events agree.
 */
export function resolveToolActionDeviceRef(
  sessionKey: string | undefined,
  resolveSessionDeviceScope?: ToolActionDeviceScopeResolver,
): string | undefined {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return undefined;
  }
  const cached = sessionDeviceScopes.get(normalized);
  if (cached) {
    return hashAuditDeviceRef(cached.deviceId ?? undefined);
  }
  if (!resolveSessionDeviceScope) {
    return undefined;
  }
  let resolved: string | null | undefined;
  try {
    resolved = resolveSessionDeviceScope(normalized);
  } catch {
    resolved = undefined;
  }
  if (resolved === undefined) {
    return undefined;
  }
  const deviceId = normalizeOptionalString(resolved) ?? null;
  rememberSessionDeviceScope(normalized, deviceId);
  return hashAuditDeviceRef(deviceId ?? undefined);
}

/** Cache-only read; callers without a resolver see only explicitly published scopes. */
export function readToolActionDeviceRef(sessionKey: string | undefined): string | undefined {
  return resolveToolActionDeviceRef(sessionKey);
}

export function clearToolActionDeviceScopesForTest(): void {
  invalidateToolActionDeviceScopes();
}
