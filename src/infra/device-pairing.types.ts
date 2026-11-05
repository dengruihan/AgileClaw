// Persisted device pairing and bootstrap-token record shapes.
// Leaf contract shared by the domain modules (device-pairing.ts,
// device-bootstrap.ts) and the SQLite row mapper (device-pairing-store.ts);
// keeping it import-free of both sides prevents module cycles.
import type { Static } from "typebox";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { DevicePairRequestedEventSchema } from "../../packages/gateway-protocol/src/schema/devices.js";
import type {
  DeviceBootstrapProfile,
  PairingSetupAccess,
} from "../shared/device-bootstrap-profile.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";

/** Pending device pairing request awaiting owner approval. */
export type DevicePairingPendingRequest = SchemaContract<
  Static<typeof DevicePairRequestedEventSchema>
>;

// Internal pending record. refreshedAtMs is a TTL keepalive stamped on refresh so an
// actively retrying device keeps one pending request (and requestId) alive instead of
// minting a new request every TTL window and flooding operator approval UIs. It never
// crosses the protocol boundary, and ordering/--latest still use ts.
export type DevicePairingPendingRecord = DevicePairingPendingRequest & {
  refreshedAtMs?: number;
};

export type DevicePairingStoreState = {
  pendingById: Record<string, DevicePairingPendingRecord>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

/** Bearer token issued to one paired device role. */
export type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  issuer?: {
    kind: "shared-gateway-auth";
    generation: string;
  };
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

/**
 * How the latest pairing approval was granted. "silent" is a same-host local
 * policy approval and the only prune-eligible kind: local clients re-pair
 * silently and cannot collide with another machine's records. "trusted-cidr"
 * and "ssh-verified" are also non-interactive but cross hosts, so they are
 * never pruned automatically (display metadata is not a machine identity).
 * "trusted-proxy" records were approved from an authenticated proxy identity.
 * "owner" and "bootstrap" approvals required a user action. None of these
 * cross-host or interactive approval kinds are pruned automatically.
 */
export type PairedDeviceApprovalKind =
  | "owner"
  | "silent"
  | "trusted-cidr"
  | "trusted-proxy"
  | "ssh-verified"
  | "bootstrap";

/**
 * Operator-managed per-device command policy. `deny` removes commands from
 * the device's pairing-approved surface; `allow` only selects within that
 * surface and never overrides global gateway policy (gateway.nodes.commands
 * deny entries or dangerous-command defaults). Both lists are optional;
 * an entirely absent policy admits the full approved surface.
 */
export type PairedDeviceCommandPolicy = {
  allow?: string[];
  deny?: string[];
};

/**
 * Normalize operator-supplied or stored policy. `allow`/`deny` keep their
 * meaning when present-but-empty (`allow: []` selects nothing); null means
 * no policy at all. Returns null for shapes that are not a policy object.
 */
export function normalizePairedDeviceCommandPolicy(
  value: unknown,
): PairedDeviceCommandPolicy | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const policy: PairedDeviceCommandPolicy = {};
  let keys = 0;
  for (const key of ["allow", "deny"] as const) {
    const raw = record[key];
    if (raw === undefined) {
      continue;
    }
    if (!Array.isArray(raw)) {
      return null;
    }
    keys += 1;
    policy[key] = [
      ...new Set(
        raw
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry !== ""),
      ),
    ];
  }
  return keys > 0 ? policy : null;
}

/** Apply one device's command policy to its pairing-approved command surface. */
export function filterPairedDeviceCommandSurface(
  policy: PairedDeviceCommandPolicy | undefined,
  commands: readonly string[],
): string[] {
  if (!policy) {
    return [...commands];
  }
  const allow = policy.allow ? new Set(policy.allow) : undefined;
  const deny = policy.deny ? new Set(policy.deny) : undefined;
  return commands.filter(
    (command) => (!allow || allow.has(command)) && !(deny?.has(command) ?? false),
  );
}

/**
 * Paired-device registry state. New pairings default to `enabled: false`
 * (devices are denied by default); legacy rows written before the field
 * existed load with the key absent and read as enabled until Doctor
 * backfills an explicit value. Enforcement gates node-role execution only.
 */
export function isPairedDeviceEnabled(device: Pick<PairedDevice, "enabled">): boolean {
  return device.enabled !== false;
}

/**
 * Approved node capability surface for a node-role device. Device pairing
 * grants connection auth; this grants command/capability exposure (node
 * command gating). displayName here is the operator-facing node name set at
 * approval or via node.rename; it must not be clobbered by reconnect
 * metadata refreshes, which is why it lives apart from the device fields.
 */
export type PairedDeviceNodeSurface = {
  displayName?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  bins?: string[];
  /** Last current-generation runner publication explicitly enabled session hosting. */
  sessionHost?: boolean;
  createdAtMs: number;
  approvedAtMs: number;
  lastConnectedAtMs?: number;
  lastDisconnectedAtMs?: number;
  lastHostStats?: NodeHostStats;
};

/**
 * Pending node-surface approval awaiting an operator decision (one per
 * device). Carries its own metadata snapshot so approval UIs can show what
 * the node declared at request time. `revision` guards the reconnect-vs-
 * approve race: reconnect cleanup only deletes the revision it observed, so
 * a refreshed request survives concurrent approval flows.
 */
export type PairedDevicePendingNodeSurface = {
  requestId: string;
  revision: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  clientId?: string;
  clientMode?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  silent?: boolean;
  ts: number;
};

/** Persisted approved device record, including durable approval and active role tokens. */
export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  operatorLabel?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  browserOrigin?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  approvedScopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  approvedVia?: PairedDeviceApprovalKind;
  nodeSurface?: PairedDeviceNodeSurface;
  pendingNodeSurface?: PairedDevicePendingNodeSurface;
  /** Registry flag: absent (legacy) reads as enabled; new pairings write false. */
  enabled?: boolean;
  commandPolicy?: PairedDeviceCommandPolicy;
  createdAtMs: number;
  approvedAtMs: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

/** Persisted bootstrap token state, including binding and role/scope redemption progress. */
export type DeviceBootstrapTokenRecord = {
  token: string;
  setupId?: string;
  ts: number;
  deviceId?: string;
  publicKey?: string;
  profile?: DeviceBootstrapProfile;
  redeemedProfile?: DeviceBootstrapProfile;
  pendingProfile?: DeviceBootstrapProfile;
  issuedAtMs: number;
  lastUsedAtMs?: number;
};

/**
 * Durable terminal outcome for one setup credential. Redemption deletes the
 * bootstrap row, so this record is what lets a presenting client answer
 * "did my setup code succeed?" without having received the broadcast.
 */
export type DevicePairSetupCompletionRecord = {
  setupId: string;
  deviceId: string;
  deviceName?: string;
  access: PairingSetupAccess;
  completedAtMs: number;
  deliveryState: "uncertain" | "confirmed";
  retainUntilMs: number;
};
