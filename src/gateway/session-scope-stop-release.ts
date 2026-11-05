import type { SessionEntry } from "../config/sessions.js";
import { releaseSessionScopeLease } from "./session-scope-lease.js";
import { sweepSessionScopeBackgroundProcesses } from "./session-scope-process-sweep.js";

/**
 * Stop is the only manual release path for a device-scoped session's lease, and
 * it must work while the session is idle: detached background processes can keep
 * the node lease after the last run ends. The device node owns occupancy, so this
 * drops only the Gateway's mirror and asks the session's process scope to cancel;
 * gateway-scoped sessions keep the legacy stop behavior. Returns whether a
 * mirrored lease was released so the caller can publish the changed row.
 */
export function releaseScopeLeaseOnStop(
  entry: SessionEntry | undefined,
  canonicalKey: string,
  requestedKey: string,
  agentId: string,
): boolean {
  if (!entry?.scopeDeviceId) {
    return false;
  }
  sweepSessionScopeBackgroundProcesses({
    scopeKeys: [canonicalKey, requestedKey, ...(entry.sessionId ? [entry.sessionId] : [])],
    agentId,
  });
  return Boolean(releaseSessionScopeLease(canonicalKey) ?? releaseSessionScopeLease(requestedKey));
}
