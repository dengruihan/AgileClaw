/**
 * Gateway owner of the session -> device execution scope.
 *
 * A session's `scopeDeviceId` decides where its *placement* tools run. The
 * device node owns occupancy, so every scope switch is a lease decision here:
 * the Gateway validates the device, asks the node for the occupancy lease over
 * the internal node registry path (never the model-facing `node.invoke` RPC,
 * whose lease mutations are admin-only), mirrors the grant, and only then
 * writes the scope through the session patch owner. A busy or unusable device
 * fails the switch; nothing queues and nothing falls back to the Gateway.
 */
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeOccupancyHolder } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import {
  publishPromptDeviceScopeSnapshot,
  type PromptDeviceScopeSnapshot,
} from "../../agents/prompt-device-scope.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  recordDeviceLeaseDecision,
  type DeviceLeaseReleaseReason,
  type DeviceLeaseRejectReason,
} from "../../audit/device-lease-decision.js";
import {
  invalidateToolActionDeviceScopes,
  publishToolActionDeviceScope,
} from "../../audit/tool-action-device-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  type PairedDevice,
} from "../../infra/device-pairing.js";
import { isPairedDeviceEnabled } from "../../infra/device-pairing.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  NODE_OCCUPANCY_REVOKE_COMMAND,
  NODE_DEVICE_OCCUPIED_ERROR_CODE,
} from "../../infra/node-commands.js";
import { logWarn } from "../../logger.js";
import type { NodeRegistry } from "../node-registry.js";
import type { NodeSession } from "../node-session.types.js";
import {
  applyNodeOccupancyStatus,
  readSessionScopeLease,
  recordSessionScopeLease,
  releaseSessionScopeLease,
  takeSessionScopeLeasesForDevice,
  type SessionScopeLeaseRecord,
} from "../session-scope-lease.js";
import { resolveSessionSharingTarget } from "../session-sharing.js";

/** Narrow registry surface this owner needs; the Gateway passes the real registry. */
export type DeviceScopeRegistry = {
  invoke: NodeRegistry["invoke"];
  get?: (nodeId: string) => NodeSession | undefined;
  listConnected?: () => NodeSession[];
};

/** How long a mirrored grant is trusted before the next device call re-acquires. */
export const DEVICE_SCOPE_LEASE_TTL_MS = 30 * 60_000;

/** Non-root lineage keys are bounded so a corrupt store cannot loop the walk. */
const MAX_SCOPE_ROOT_DEPTH = 8;

/**
 * Commands a device must advertise to execute this session's placement tools.
 * `system.run` is the exec adapter; the occupancy pair is the lease contract.
 */
export const DEVICE_EXECUTOR_REQUIRED_COMMANDS = [
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  "system.run",
] as const;

export type DeviceScopeFailureCode =
  | "DEVICE_NOT_FOUND"
  | "DEVICE_DISABLED"
  | "DEVICE_NOT_CONNECTED"
  | "DEVICE_NOT_EXECUTOR"
  | "DEVICE_OCCUPIED"
  | "DEVICE_LEASE_FAILED"
  | "DEVICE_SCOPE_NOT_ROOT"
  | "DEVICE_SCOPE_UNAVAILABLE";

export type DeviceScopeFailure = {
  ok: false;
  code: DeviceScopeFailureCode;
  message: string;
};

export type DeviceScopeFacts = {
  deviceId: string;
  displayName?: string;
  platform?: string;
  connected: boolean;
  commands: readonly string[];
  caps?: readonly string[];
};

export type DeviceScopeLeaseGrant = {
  holder: NodeOccupancyHolder;
  leaseToken: string;
  acquiredAtMs: number;
};

export type DeviceScopeSwitch = {
  ok: true;
  /** Absent for a switch back to the gateway. */
  device?: DeviceScopeFacts;
  lease?: DeviceScopeLeaseGrant;
  /**
   * Lease the tree held before this switch. Released by the caller only after
   * the scope write commits, so a failed patch keeps the previous grant.
   */
  previousLease?: { deviceId: string; leaseToken: string };
};

/** Human-readable switch failure; the code travels separately for machine routing. */
export function describeDeviceScopeFailure(result: DeviceScopeFailure): string {
  return result.message;
}

function failure(code: DeviceScopeFailureCode, message: string): DeviceScopeFailure {
  return { ok: false, code, message };
}

/**
 * Queue one lease fact for the transition this owner just observed. Best
 * effort: a missing admitted execution (operator-side boundaries, restart-lost
 * mirrors) or a closed audit sink records nothing, and any audit failure only
 * logs so it can never block or fail the lease transition itself.
 */
function recordDeviceScopeLeaseFact(params: {
  deviceId: string;
  rootSessionKey: string;
  phase: "acquire" | "release" | "reject";
  rejectReason?: DeviceLeaseRejectReason;
  releaseReason?: DeviceLeaseReleaseReason;
  agentId?: string;
  permissionMode?: string;
  leaseToken?: string;
  admissionToken?: SessionScopeLeaseRecord["admissionToken"];
  occurredAt?: number;
}): void {
  try {
    const caller = getGatewayToolCallerIdentity();
    const token = params.admissionToken ?? caller?.executionIdentityToken;
    if (!token) {
      return;
    }
    if (params.phase !== "release" && caller?.receiptAuthority) {
      // Enforced facts revalidate the live admitted run after the node await.
      if (caller.receiptAuthority() === false) {
        return;
      }
    }
    recordDeviceLeaseDecision({
      token,
      phase: params.phase,
      deviceId: params.deviceId,
      rootSessionKey: params.rootSessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
      ...(params.rejectReason ? { rejectReason: params.rejectReason } : {}),
      ...(params.releaseReason ? { releaseReason: params.releaseReason } : {}),
      ...(params.leaseToken ? { leaseToken: params.leaseToken } : {}),
      ...(params.occurredAt !== undefined ? { occurredAt: params.occurredAt } : {}),
    });
  } catch (error) {
    logWarn(`device scope: lease audit fact failed: ${formatErrorMessage(error)}`);
  }
}

/** Reject codes that describe an occupancy eligibility denial worth a fact. */
const LEASE_REJECT_CODES: Partial<Record<DeviceScopeFailureCode, DeviceLeaseRejectReason>> = {
  DEVICE_OCCUPIED: "occupied",
  DEVICE_DISABLED: "disabled",
  DEVICE_NOT_CONNECTED: "disconnected",
  DEVICE_NOT_EXECUTOR: "not-executor",
};

const SCOPE_PERMISSION_MODES = new Set(["read-only", "guarded", "workspace", "full"]);

/** Bounded session permission mode at the scope root; absent when unrecorded. */
function readScopePermissionMode(params: {
  cfg: OpenClawConfig;
  rootSessionKey: string;
  agentId?: string;
}): string | undefined {
  try {
    const mode = resolveSessionScopeRoot({
      cfg: params.cfg,
      sessionKey: params.rootSessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    })?.entry.permissionMode?.trim();
    return mode && SCOPE_PERMISSION_MODES.has(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCommands(commands: readonly string[] | undefined): string[] {
  return [...new Set((commands ?? []).map((command) => command.trim()).filter(Boolean))];
}

/**
 * Pure eligibility decision. Registry state comes from the persisted pairing
 * record so a disabled device is rejected with its own reason even while it is
 * still connected, and the live session supplies the advertisable surface.
 */
export function validateDeviceScopeDevice(params: {
  device: PairedDevice | null;
  session: NodeSession | undefined;
  requiredCommands?: readonly string[];
}): { ok: true; device: DeviceScopeFacts } | DeviceScopeFailure {
  const deviceId = normalizeOptionalString(params.device?.deviceId) ?? "";
  if (!params.device || !deviceId || !hasEffectivePairedDeviceRole(params.device, "node")) {
    return failure(
      "DEVICE_NOT_FOUND",
      `${deviceId || "the requested device"} is not a paired node device; pair it first`,
    );
  }
  if (!isPairedDeviceEnabled(params.device)) {
    return failure(
      "DEVICE_DISABLED",
      `paired device ${deviceId} is disabled; enable it with node.device.enable before routing a session to it`,
    );
  }
  const session = params.session;
  if (!session || session.client?.invalidated === true) {
    return failure(
      "DEVICE_NOT_CONNECTED",
      `paired device ${deviceId} is not connected; start the node host on that device and retry`,
    );
  }
  const commands = normalizeCommands(session.commands);
  const required = params.requiredCommands ?? DEVICE_EXECUTOR_REQUIRED_COMMANDS;
  const missing = required.filter((command) => !commands.includes(command));
  if (missing.length > 0) {
    return failure(
      "DEVICE_NOT_EXECUTOR",
      `paired device ${deviceId} does not advertise the device executor surface (missing ${missing.join(", ")}); run the node host with the executor profile on that device`,
    );
  }
  return {
    ok: true,
    device: {
      deviceId,
      connected: true,
      commands,
      ...(normalizeOptionalString(session.displayName)
        ? { displayName: normalizeOptionalString(session.displayName) }
        : {}),
      ...(normalizeOptionalString(session.platform)
        ? { platform: normalizeOptionalString(session.platform) }
        : {}),
      ...(session.caps?.length ? { caps: normalizeCommands(session.caps) } : {}),
    },
  };
}

function resolveLeaseInvokeFailure(message: string): DeviceScopeFailure {
  return failure("DEVICE_LEASE_FAILED", message);
}

/**
 * Ask the device node for the occupancy lease of one root session turn. The
 * invoke envelope carries the root session identity, which the node treats as
 * authoritative; the token rides inside the command params so the wire format
 * is unchanged.
 */
export async function acquireDeviceScopeLease(params: {
  registry: DeviceScopeRegistry;
  deviceId: string;
  rootSessionKey: string;
  sessionId: string;
  agentId?: string;
  runId?: string;
  turnId?: string;
  signal?: AbortSignal;
  connectionSignal?: AbortSignal;
  now?: () => number;
  mintLeaseToken?: () => string;
  /** Session permission mode retained with the grant for audit correlation. */
  permissionMode?: string;
}): Promise<{ ok: true; lease: DeviceScopeLeaseGrant } | DeviceScopeFailure> {
  const deviceId = normalizeOptionalString(params.deviceId) ?? "";
  const rootSessionKey = normalizeOptionalString(params.rootSessionKey) ?? "";
  const sessionId = normalizeOptionalString(params.sessionId) ?? "";
  if (!deviceId || !rootSessionKey || !sessionId) {
    return failure(
      "DEVICE_SCOPE_UNAVAILABLE",
      "device scope requires a device, root session key, and session id",
    );
  }
  const leaseToken = (params.mintLeaseToken ?? randomUUID)();
  const agentId = normalizeOptionalString(params.agentId);
  const runId = normalizeOptionalString(params.runId) ?? `scope-${leaseToken}`;
  const turnId = normalizeOptionalString(params.turnId);
  const result = await params.registry.invoke({
    nodeId: deviceId,
    command: NODE_OCCUPANCY_ACQUIRE_COMMAND,
    params: {
      sessionKey: rootSessionKey,
      sessionId,
      ...(agentId ? { agentId } : {}),
      runId,
      ...(turnId ? { turnId } : {}),
      leaseToken,
    },
    sessionKey: rootSessionKey,
    timeoutMs: 15_000,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!result.ok) {
    const nodeError = result.error;
    const message =
      normalizeOptionalString(nodeError?.message) ?? "device occupancy acquire failed";
    if (nodeError?.code === NODE_DEVICE_OCCUPIED_ERROR_CODE) {
      recordDeviceScopeLeaseFact({
        deviceId,
        rootSessionKey,
        phase: "reject",
        rejectReason: "occupied",
        ...(agentId ? { agentId } : {}),
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        leaseToken,
      });
      return failure(
        "DEVICE_OCCUPIED",
        `${deviceId} is occupied: ${message}. No queueing and no gateway fallback; retry after the holder releases the device or switch to gateway scope.`,
      );
    }
    return resolveLeaseInvokeFailure(`${deviceId} refused the occupancy lease: ${message}`);
  }
  const payload = result.payload as
    | {
        holder?: NodeOccupancyHolder;
        leaseToken?: string;
        acquiredAtMs?: number;
      }
    | undefined;
  const holder = payload?.holder;
  if (!holder || typeof holder.sessionKey !== "string") {
    return resolveLeaseInvokeFailure(`${deviceId} returned a malformed occupancy grant`);
  }
  const acquiredAtMs =
    typeof payload?.acquiredAtMs === "number" && Number.isFinite(payload.acquiredAtMs)
      ? payload.acquiredAtMs
      : (params.now?.() ?? Date.now());
  const grantToken = normalizeOptionalString(payload?.leaseToken) ?? leaseToken;
  const admissionToken = getGatewayToolCallerIdentity()?.executionIdentityToken;
  recordSessionScopeLease({
    rootSessionKey,
    deviceId,
    holder: holder.sessionKey,
    leaseToken: grantToken,
    expiresAt: (params.now?.() ?? Date.now()) + DEVICE_SCOPE_LEASE_TTL_MS,
    ...(agentId ? { agentId } : {}),
    ...(admissionToken ? { admissionToken } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.connectionSignal ? { connectionSignal: params.connectionSignal } : {}),
  });
  recordDeviceScopeLeaseFact({
    deviceId,
    rootSessionKey,
    phase: "acquire",
    ...(agentId ? { agentId } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(admissionToken ? { admissionToken } : {}),
    leaseToken: grantToken,
    occurredAt: acquiredAtMs,
  });
  return { ok: true, lease: { holder, leaseToken: grantToken, acquiredAtMs } };
}

/**
 * Release the device occupancy lease. The node owns occupancy, so this is a
 * best-effort notification; the Gateway mirror is always dropped for the token
 * it was granted (a newer grant is never released by an older caller).
 */
export async function releaseDeviceScopeLease(params: {
  registry?: DeviceScopeRegistry;
  rootSessionKey: string;
  leaseToken?: string;
  deviceId?: string;
  signal?: AbortSignal;
  /** Lifecycle boundary that owns this release; audit correlation only. */
  releaseReason?: DeviceLeaseReleaseReason;
}): Promise<boolean> {
  const rootSessionKey = normalizeOptionalString(params.rootSessionKey) ?? "";
  if (!rootSessionKey) {
    return false;
  }
  const mirrored = readSessionScopeLease(rootSessionKey);
  const leaseToken = normalizeOptionalString(params.leaseToken) ?? mirrored?.leaseToken;
  const deviceId = normalizeOptionalString(params.deviceId) ?? mirrored?.deviceId ?? undefined;
  if (params.registry && deviceId && leaseToken) {
    await params.registry
      .invoke({
        nodeId: deviceId,
        command: NODE_OCCUPANCY_RELEASE_COMMAND,
        params: { sessionKey: rootSessionKey, leaseToken },
        sessionKey: rootSessionKey,
        timeoutMs: 10_000,
        ...(params.signal ? { signal: params.signal } : {}),
      })
      .catch((error: unknown) => {
        // A disconnected node clears its own occupancy; anything else means the
        // lease may survive, so say so instead of pretending the release landed.
        logWarn(
          `device scope: occupancy release failed device=${deviceId} session=${rootSessionKey}: ${formatErrorMessage(error)}`,
        );
      });
  }
  const released = releaseSessionScopeLease(
    rootSessionKey,
    leaseToken ? { leaseToken } : undefined,
  );
  if (released) {
    // Exactly one fact per real mirror drop: a replaced or absent mirror is a
    // no-op, so a transition cannot emit twice.
    recordDeviceScopeLeaseFact({
      deviceId: released.deviceId,
      rootSessionKey,
      phase: "release",
      releaseReason: params.releaseReason ?? "released",
      ...(released.agentId ? { agentId: released.agentId } : {}),
      ...(released.permissionMode ? { permissionMode: released.permissionMode } : {}),
      ...(released.admissionToken ? { admissionToken: released.admissionToken } : {}),
      ...(released.leaseToken ? { leaseToken: released.leaseToken } : {}),
    });
  }
  return Boolean(released);
}

/**
 * Force-clear every lease the node holds for one device. Used when the device
 * is disabled or deleted: the Gateway is the operator here, so the invoke
 * carries no session identity and the node tree-kills holder processes before
 * clearing occupancy. The A-side mirrors are dropped either way.
 */
export async function revokeDeviceScopeLeases(params: {
  registry?: DeviceScopeRegistry;
  deviceId: string;
  signal?: AbortSignal;
}): Promise<{ revoked: boolean; clearedRootSessionKeys: string[] }> {
  const deviceId = normalizeOptionalString(params.deviceId) ?? "";
  if (!deviceId) {
    return { revoked: false, clearedRootSessionKeys: [] };
  }
  let revoked = false;
  if (params.registry) {
    try {
      const result = await params.registry.invoke({
        nodeId: deviceId,
        command: NODE_OCCUPANCY_REVOKE_COMMAND,
        // No session identity: the operator force-clear path.
        params: {},
        timeoutMs: 10_000,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      revoked = result.ok;
      if (!result.ok) {
        logWarn(
          `device scope: occupancy revoke failed device=${deviceId}: ${formatErrorMessage(result.error?.message ?? "unknown")}`,
        );
      }
    } catch (error) {
      logWarn(
        `device scope: occupancy revoke failed device=${deviceId}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const cleared = takeSessionScopeLeasesForDevice(deviceId, Date.now());
  for (const { rootSessionKey, record } of cleared) {
    recordDeviceScopeLeaseFact({
      deviceId,
      rootSessionKey,
      phase: "release",
      releaseReason: "revoked",
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
      ...(record.admissionToken ? { admissionToken: record.admissionToken } : {}),
      ...(record.leaseToken ? { leaseToken: record.leaseToken } : {}),
    });
  }
  return {
    revoked,
    clearedRootSessionKeys: cleared.map((entry) => entry.rootSessionKey),
  };
}

/**
 * Retire the mirrored leases of a removed device pairing without contacting the
 * node: unpairing disconnects it, and the node clears its own occupancy then.
 * Audit-only release semantics for the delete boundary.
 */
export function releaseRemovedDeviceScopeLeases(params: { deviceId: string }): {
  clearedRootSessionKeys: string[];
} {
  const deviceId = normalizeOptionalString(params.deviceId) ?? "";
  if (!deviceId) {
    return { clearedRootSessionKeys: [] };
  }
  const cleared = takeSessionScopeLeasesForDevice(deviceId, Date.now());
  for (const { rootSessionKey, record } of cleared) {
    recordDeviceScopeLeaseFact({
      deviceId,
      rootSessionKey,
      phase: "release",
      releaseReason: "delete",
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
      ...(record.admissionToken ? { admissionToken: record.admissionToken } : {}),
      ...(record.leaseToken ? { leaseToken: record.leaseToken } : {}),
    });
  }
  return {
    clearedRootSessionKeys: cleared.map((entry) => entry.rootSessionKey),
  };
}

/** Mirror a node-reported release: only the node can prove the lease ended. */
export function applyNodeOccupancyStatusForDevice(params: {
  deviceId: string;
  occupied: boolean;
}): string[] {
  if (!params.occupied) {
    const cleared = takeSessionScopeLeasesForDevice(params.deviceId, Date.now());
    for (const { rootSessionKey, record } of cleared) {
      recordDeviceScopeLeaseFact({
        deviceId: params.deviceId,
        rootSessionKey,
        phase: "release",
        releaseReason: "released",
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.permissionMode ? { permissionMode: record.permissionMode } : {}),
        ...(record.admissionToken ? { admissionToken: record.admissionToken } : {}),
        ...(record.leaseToken ? { leaseToken: record.leaseToken } : {}),
      });
    }
    return cleared.map((entry) => entry.rootSessionKey);
  }
  return applyNodeOccupancyStatus(params);
}

/**
 * Resolve the root session of a session tree. Device scope is shared by the
 * tree through its root: forks are their own root, subagents walk up their
 * spawn lineage (a subagent can never own a separate lease).
 */
export function resolveSessionScopeRoot(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): { rootSessionKey: string; agentId: string; entry: SessionEntry } | undefined {
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  if (!target) {
    return undefined;
  }
  let root = {
    rootSessionKey: target.canonicalKey,
    agentId: target.agentId,
    entry: target.entry,
  };
  for (let depth = 0; depth < MAX_SCOPE_ROOT_DEPTH; depth += 1) {
    // A fork is a new root: it keeps its own scope and its own lease.
    if (root.entry.forkSource) {
      break;
    }
    const parentKey =
      normalizeOptionalString(root.entry.parentSessionKey) ??
      normalizeOptionalString(root.entry.spawnedBy);
    if (!parentKey || parentKey === root.rootSessionKey) {
      break;
    }
    const parent = resolveSessionSharingTarget({
      cfg: params.cfg,
      sessionKey: parentKey,
      agentId: root.agentId,
    });
    if (!parent) {
      break;
    }
    root = {
      rootSessionKey: parent.canonicalKey,
      agentId: parent.agentId,
      entry: parent.entry,
    };
  }
  return root;
}

/**
 * Prepare one scope switch: validate the device, release the tree's previous
 * lease, and acquire the new one. The caller writes the scope only after this
 * resolves, so a rejected device never changes where the session executes.
 */
export async function prepareDeviceScopeSwitch(params: {
  cfg: OpenClawConfig;
  registry?: DeviceScopeRegistry;
  rootSessionKey: string;
  sessionId: string;
  agentId?: string;
  runId?: string;
  deviceId: string | null;
  signal?: AbortSignal;
  connectionSignal?: AbortSignal;
  getPairedDevice?: (deviceId: string) => Promise<PairedDevice | null>;
  getNodeSession?: (deviceId: string) => NodeSession | undefined;
  now?: () => number;
  mintLeaseToken?: () => string;
}): Promise<DeviceScopeSwitch | DeviceScopeFailure> {
  if (params.deviceId === null) {
    const previous = readSessionScopeLease(params.rootSessionKey);
    return {
      ok: true,
      ...(previous
        ? {
            previousLease: {
              deviceId: previous.deviceId,
              leaseToken: previous.leaseToken,
            },
          }
        : {}),
    };
  }
  const deviceId = normalizeOptionalString(params.deviceId) ?? "";
  if (!deviceId) {
    return failure("DEVICE_NOT_FOUND", "device id is required to switch scope");
  }
  const readDevice = params.getPairedDevice ?? ((id) => getPairedDevice(id));
  const readSession = params.getNodeSession ?? ((id) => params.registry?.get?.(id));
  const permissionMode = readScopePermissionMode({
    cfg: params.cfg,
    rootSessionKey: params.rootSessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const device = await readDevice(deviceId);
  const validated = validateDeviceScopeDevice({
    device,
    session: readSession ? readSession(deviceId) : undefined,
  });
  if (!validated.ok) {
    const rejectReason = LEASE_REJECT_CODES[validated.code];
    if (rejectReason) {
      recordDeviceScopeLeaseFact({
        deviceId,
        rootSessionKey: params.rootSessionKey,
        phase: "reject",
        rejectReason,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      });
    }
    return validated;
  }
  if (!params.registry) {
    return failure(
      "DEVICE_SCOPE_UNAVAILABLE",
      "device scope requires the Gateway node registry to acquire the occupancy lease",
    );
  }
  const previous = readSessionScopeLease(params.rootSessionKey);
  const grant = await acquireDeviceScopeLease({
    registry: params.registry,
    deviceId,
    rootSessionKey: params.rootSessionKey,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.connectionSignal ? { connectionSignal: params.connectionSignal } : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.mintLeaseToken ? { mintLeaseToken: params.mintLeaseToken } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  });
  if (!grant.ok) {
    return grant;
  }
  return {
    ok: true,
    device: validated.device,
    lease: grant.lease,
    // Released by the caller once the scope write commits; a failed patch must
    // keep the tree's previous grant intact.
    ...(previous && previous.deviceId !== deviceId
      ? {
          previousLease: {
            deviceId: previous.deviceId,
            leaseToken: previous.leaseToken,
          },
        }
      : {}),
  };
}

/**
 * Persist the scope decision on the session entry. `undefined` clears the
 * field; the merge owner preserves it for every later patch that does not name
 * it, so compaction, resume, and unrelated patches keep the scope.
 */
export async function writeSessionDeviceScope(params: {
  cfg: OpenClawConfig;
  rootSessionKey: string;
  agentId: string;
  deviceId: string | null;
}): Promise<SessionEntry | null> {
  const written = await updateSessionEntry(
    { agentId: params.agentId, sessionKey: params.rootSessionKey },
    () => ({ scopeDeviceId: params.deviceId ?? undefined }),
  );
  if (written) {
    // A committed scope change is authoritative for the audit projection:
    // drop cached child scopes and publish the root's new scope immediately so
    // a switch back to gateway cannot leave a stale deviceRef behind.
    invalidateToolActionDeviceScopes();
    publishToolActionDeviceScope({
      sessionKey: params.rootSessionKey,
      deviceId: params.deviceId,
    });
  }
  return written;
}

/**
 * Build M64's turn-boundary device-scope snapshot. The device list is the live
 * connected set: a disconnected or disabled device cannot execute, so listing
 * it would invite a call that must fail. No pairing store read happens here.
 */
export function buildSessionDeviceScopeSnapshot(params: {
  scopeDeviceId?: string;
  scopeCwd?: string;
  connectedDevices: ReadonlyArray<{
    nodeId: string;
    displayName?: string;
    platform?: string;
  }>;
}): PromptDeviceScopeSnapshot {
  const devices = params.connectedDevices.map((device) => ({
    deviceId: device.nodeId,
    ...(device.displayName ? { displayName: device.displayName } : {}),
    ...(device.platform ? { platform: device.platform } : {}),
    connected: true,
  }));
  const scopeDeviceId = normalizeOptionalString(params.scopeDeviceId);
  if (!scopeDeviceId) {
    return { target: { kind: "gateway" }, devices };
  }
  const matched = params.connectedDevices.find((device) => device.nodeId === scopeDeviceId);
  return {
    target: {
      kind: "node",
      deviceId: scopeDeviceId,
      ...(matched?.displayName ? { displayName: matched.displayName } : {}),
      ...(matched?.platform ? { platform: matched.platform } : {}),
      ...(normalizeOptionalString(params.scopeCwd) ? { cwd: params.scopeCwd!.trim() } : {}),
    },
    devices,
  };
}

/**
 * Publish the turn-boundary scope fact for one session. Publishing no snapshot
 * withdraws it, so a missing session never leaves stale scope prose behind.
 */
export function publishSessionDeviceScopePrompt(params: {
  sessionKey: string;
  registry?: Pick<DeviceScopeRegistry, "listConnected">;
  scopeDeviceId?: string;
  scopeCwd?: string;
  isCurrent?: () => boolean;
}): PromptDeviceScopeSnapshot | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  if (!params.registry?.listConnected) {
    publishPromptDeviceScopeSnapshot({ sessionKey });
    return undefined;
  }
  const connectedDevices: Array<{
    nodeId: string;
    displayName?: string;
    platform?: string;
  }> = [];
  for (const session of params.registry.listConnected()) {
    connectedDevices.push({
      nodeId: session.nodeId,
      ...(session.displayName ? { displayName: session.displayName } : {}),
      ...(session.platform ? { platform: session.platform } : {}),
    });
  }
  const snapshot = buildSessionDeviceScopeSnapshot({
    ...(params.scopeDeviceId ? { scopeDeviceId: params.scopeDeviceId } : {}),
    ...(params.scopeCwd ? { scopeCwd: params.scopeCwd } : {}),
    connectedDevices,
  });
  publishPromptDeviceScopeSnapshot({
    sessionKey,
    snapshot,
    ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
  });
  return snapshot;
}
