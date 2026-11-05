import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * Gateway-side (A) cache of the device lease a scoped session tree holds.
 *
 * The device node is the authority for occupancy; this map only mirrors the
 * holder facts the node last reported so the Gateway can project a
 * "lease held while idle" stop affordance and release on Stop/delete/archive.
 * It is deliberately not backed by `state_leases` or any durable store: after a
 * Gateway restart the cache is empty until the node reports again, and an absent
 * entry never proves the node released the lease.
 *
 * Records are keyed by the root session of the tree: forks receive a fresh
 * lease of their own (their root is themselves) while subagents share the
 * parent tree's lease, so only the root key ever holds a record.
 */
export type SessionScopeLeaseRecord = {
  /** Paired device the lease was granted for; matches the session's scopeDeviceId. */
  deviceId: string;
  /** Connection or client identity the node reported as the current holder. */
  holder: string;
  /** Opaque lease token minted by the node; guards against releasing a newer lease. */
  leaseToken: string;
  /** Epoch ms when the node says the lease expires without renewal. */
  expiresAt: number;
  /** Owning agent, retained for diagnostics only; the root key already scopes identity. */
  agentId?: string;
};

const leasesByRootSessionKey = new Map<string, SessionScopeLeaseRecord>();

type DisconnectWatch = {
  handler: () => void;
  rootKeys: Set<string>;
};
const disconnectWatches = new Map<AbortSignal, DisconnectWatch>();

function stopWatchingDisconnect(signal: AbortSignal, watch: DisconnectWatch): void {
  if (watch.rootKeys.size > 0) {
    return;
  }
  signal.removeEventListener("abort", watch.handler);
  disconnectWatches.delete(signal);
}

function watchDisconnect(signal: AbortSignal, rootSessionKey: string): void {
  let watch = disconnectWatches.get(signal);
  if (!watch) {
    const handler = () => {
      const registered = disconnectWatches.get(signal);
      disconnectWatches.delete(signal);
      for (const key of registered?.rootKeys ?? []) {
        leasesByRootSessionKey.delete(key);
      }
    };
    watch = { handler, rootKeys: new Set() };
    disconnectWatches.set(signal, watch);
    signal.addEventListener("abort", watch.handler, { once: true });
  }
  watch.rootKeys.add(rootSessionKey);
}

function isExpired(record: SessionScopeLeaseRecord, now: number): boolean {
  // Local hygiene only: a stale mirror is dropped so rows stop advertising a
  // held lease, never to conclude that the node released occupancy.
  return !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

/** Mirror the node-reported lease for one session tree root, replacing any prior record. */
export function recordSessionScopeLease(params: {
  rootSessionKey: string;
  deviceId: string;
  holder: string;
  leaseToken: string;
  expiresAt: number;
  agentId?: string;
  /** Holder transport signal; the cached record dies with its connection. */
  connectionSignal?: AbortSignal;
}): void {
  const rootSessionKey = normalizeOptionalString(params.rootSessionKey);
  const deviceId = normalizeOptionalString(params.deviceId);
  const holder = normalizeOptionalString(params.holder);
  const leaseToken = normalizeOptionalString(params.leaseToken);
  const expiresAt = params.expiresAt;
  if (!rootSessionKey || !deviceId || !holder || !leaseToken) {
    throw new Error("session scope lease records require a root key, device, holder, and token");
  }
  leasesByRootSessionKey.set(rootSessionKey, {
    deviceId,
    holder,
    leaseToken,
    expiresAt,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  if (params.connectionSignal && !params.connectionSignal.aborted) {
    watchDisconnect(params.connectionSignal, rootSessionKey);
  }
}

/** Cache-only read: undefined means "no mirrored lease", never "node is free". */
export function readSessionScopeLease(
  rootSessionKey: string,
  now: number = Date.now(),
): SessionScopeLeaseRecord | undefined {
  const key = normalizeOptionalString(rootSessionKey) ?? "";
  const record = leasesByRootSessionKey.get(key);
  if (record && isExpired(record, now)) {
    leasesByRootSessionKey.delete(key);
    return undefined;
  }
  return record;
}

/** Row-projection fact for the stop affordance: a lease is mirrored for this root. */
export function sessionScopeLeaseHeld(rootSessionKey: string, now: number = Date.now()): boolean {
  return readSessionScopeLease(rootSessionKey, now) !== undefined;
}

/**
 * Drop the mirrored lease for one root. Returns the released record so callers
 * can publish the change; an optional lease token refuses to release a lease
 * that was replaced by a newer grant.
 */
export function releaseSessionScopeLease(
  rootSessionKey: string,
  options: { leaseToken?: string } = {},
): SessionScopeLeaseRecord | undefined {
  const key = normalizeOptionalString(rootSessionKey) ?? "";
  const record = leasesByRootSessionKey.get(key);
  if (!record) {
    return undefined;
  }
  if (options.leaseToken !== undefined && options.leaseToken !== record.leaseToken) {
    return undefined;
  }
  leasesByRootSessionKey.delete(key);
  for (const [signal, watch] of disconnectWatches) {
    if (watch.rootKeys.delete(key)) {
      stopWatchingDisconnect(signal, watch);
    }
  }
  return record;
}

/** Drop every mirrored lease for one device (node release or device disconnect). */
export function clearSessionScopeLeasesForDevice(deviceId: string): string[] {
  const device = normalizeOptionalString(deviceId);
  if (!device) {
    return [];
  }
  const released: string[] = [];
  for (const [key, record] of leasesByRootSessionKey) {
    if (record.deviceId === device) {
      leasesByRootSessionKey.delete(key);
      released.push(key);
    }
  }
  return released;
}

export function clearAllSessionScopeLeasesForTest(): void {
  leasesByRootSessionKey.clear();
  for (const [signal, watch] of disconnectWatches) {
    signal.removeEventListener("abort", watch.handler);
  }
  disconnectWatches.clear();
}
