import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  releaseDeviceScopeLease,
  resolveSessionScopeRoot,
  type DeviceScopeRegistry,
} from "./server-methods/session-device-scope.js";
import { readSessionScopeLease } from "./session-scope-lease.js";
import { sweepSessionScopeBackgroundProcesses } from "./session-scope-process-sweep.js";

/**
 * Stop is the only manual release path for a device-scoped session's lease, and
 * it must work while the session is idle: detached background processes can keep
 * the node lease after the last run ends. The node owns occupancy, so stop both
 * notifies it and drops the Gateway mirror; a node that already disconnected
 * simply clears its own occupancy, and a failed invoke is recorded without
 * keeping a mirror the session no longer owns. Gateway-scoped sessions keep the
 * legacy stop behavior. Returns whether a mirrored lease was released so the
 * caller can publish the changed row.
 */
/** Stop-path owner context: the Gateway config and node registry. */
export type StopReleaseContext = {
  getRuntimeConfig: () => OpenClawConfig;
  nodeRegistry: DeviceScopeRegistry;
};

export async function releaseScopeLeaseOnStop(
  context: StopReleaseContext,
  entry: SessionEntry | undefined,
  canonicalKey: string,
  requestedKey: string,
  agentId: string,
): Promise<boolean> {
  if (!entry?.scopeDeviceId) {
    return false;
  }
  sweepSessionScopeBackgroundProcesses({
    scopeKeys: [canonicalKey, requestedKey, ...(entry.sessionId ? [entry.sessionId] : [])],
    agentId,
  });
  const mirrored =
    readSessionScopeLease(canonicalKey) !== undefined ||
    readSessionScopeLease(requestedKey) !== undefined;
  const rootSessionKey =
    (mirrored && readSessionScopeLease(requestedKey) !== undefined
      ? requestedKey
      : resolveSessionScopeRoot({
          cfg: context.getRuntimeConfig(),
          sessionKey: canonicalKey,
          agentId,
        })?.rootSessionKey) ?? canonicalKey;
  return await releaseDeviceScopeLease({
    registry: context.nodeRegistry,
    rootSessionKey,
    deviceId: entry.scopeDeviceId,
    releaseReason: "stop",
  });
}
