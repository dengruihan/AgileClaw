/** Node-side device occupancy owner: one holder, node-authoritative lease state. */
import type {
  NodeOccupancyHolder,
  NodeOccupancyStatus,
} from "../../packages/gateway-protocol/src/schema/nodes.js";
import {
  NODE_DEVICE_OCCUPIED_ERROR_CODE,
  NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
  NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
} from "../infra/node-commands.js";
import { logWarn } from "../logger.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";

/** Internal lease record; the durable row and status views never carry the token. */
type NodeOccupancyLease = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  runId: string;
  turnId?: string;
  leaseToken: string;
  acquiredAtMs: number;
  renewedAtMs?: number;
};

export const NODE_OCCUPANCY_MACHINE_STATE_KEY = "nodeHost.occupancy.v1";

/** Durable-row access over the canonical shared-state machine-state store. */
type NodeOccupancyPersistence = {
  read: (env: NodeJS.ProcessEnv | undefined) => NodeOccupancyHolder | undefined;
  write: (holder: NodeOccupancyHolder | undefined, env: NodeJS.ProcessEnv | undefined) => void;
};

export function createConfigMachineStateOccupancyPersistence(): NodeOccupancyPersistence {
  return {
    read: (env) =>
      readConfigMachineState<NodeOccupancyHolder>(NODE_OCCUPANCY_MACHINE_STATE_KEY, {
        env: env ?? process.env,
      }),
    write: (holder, env) => {
      updateConfigMachineState<NodeOccupancyHolder | undefined>(
        NODE_OCCUPANCY_MACHINE_STATE_KEY,
        () => holder,
        { env: env ?? process.env },
      );
    },
  };
}

export type NodeOccupancyErrorCode =
  | typeof NODE_DEVICE_OCCUPIED_ERROR_CODE
  | typeof NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE
  | typeof NODE_DEVICE_UNOCCUPIED_ERROR_CODE;

export type NodeOccupancyRejection = {
  ok: false;
  code: NodeOccupancyErrorCode;
  message: string;
};

export type NodeOccupancyAdmission =
  | { ok: true; sessionKey: string; leaseToken: string }
  | NodeOccupancyRejection;

export type NodeOccupancyLeasedProcess = {
  /** Tree-kill this process and resolve only after its tree is extinct. */
  kill: () => Promise<void>;
  detached: boolean;
};

type RegisteredLeaseProcess = NodeOccupancyLeasedProcess & {
  id: string;
  sessionKey: string;
};

const LEASE_TOKEN_MAX_LENGTH = 256;
const IDENTITY_MAX_LENGTH = 256;

/**
 * Read the lease token an execution command carries beside its own parameters.
 * Riding inside paramsJSON keeps the invoke wire format unchanged.
 */
export function extractOccupancyLeaseToken(paramsJSON?: string | null): string | undefined {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    const params: unknown = JSON.parse(paramsJSON);
    if (typeof params !== "object" || params === null) {
      return undefined;
    }
    const token = (params as { leaseToken?: unknown }).leaseToken;
    return typeof token === "string" && token.trim() ? token : undefined;
  } catch {
    return undefined;
  }
}

function validateIdentityField(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > IDENTITY_MAX_LENGTH || normalized.includes("\0")) {
    throw new Error(`INVALID_REQUEST: occupancy ${label} must be a bounded non-empty string`);
  }
  return normalized;
}

function validateLeaseToken(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > LEASE_TOKEN_MAX_LENGTH || normalized.includes("\0")) {
    throw new Error("INVALID_REQUEST: occupancy leaseToken must be a bounded non-empty string");
  }
  return normalized;
}

function describeHolder(
  holder: Pick<NodeOccupancyHolder, "sessionKey" | "sessionId" | "agentId" | "acquiredAtMs">,
): string {
  const identity = [`session ${holder.sessionKey}`, `session id ${holder.sessionId}`];
  if (holder.agentId) {
    identity.push(`agent ${holder.agentId}`);
  }
  identity.push(`since ${new Date(holder.acquiredAtMs).toISOString()}`);
  return identity.join(", ");
}

function holderIdentity(lease: NodeOccupancyLease, detachedProcesses: number): NodeOccupancyHolder {
  return {
    sessionKey: lease.sessionKey,
    sessionId: lease.sessionId,
    ...(lease.agentId ? { agentId: lease.agentId } : {}),
    runId: lease.runId,
    ...(lease.turnId ? { turnId: lease.turnId } : {}),
    acquiredAtMs: lease.acquiredAtMs,
    ...(lease.renewedAtMs !== undefined ? { renewedAtMs: lease.renewedAtMs } : {}),
    detachedProcesses,
  };
}

/**
 * Owns the single device occupancy lease plus the registry of processes
 * launched under it. The node host process is the sole authority: decisions are
 * synchronous and in-memory, while a durable shared-state row mirrors the holder
 * identity (never the lease token) for boot clearing and diagnostics.
 */
export class NodeOccupancyOwner {
  private lease: NodeOccupancyLease | undefined;
  private releaseRequested = false;
  private readonly processes = new Map<string, RegisteredLeaseProcess>();
  private readonly persistence = createConfigMachineStateOccupancyPersistence();
  private nextProcessId = 0;

  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      now?: () => number;
      onStatusEvent?: (status: NodeOccupancyStatus) => void;
    } = {},
  ) {}

  /** Occupancy cannot survive a node restart: processes are gone with the host. */
  initialize(): NodeOccupancyHolder | undefined {
    const persisted = this.persistence.read(this.options.env);
    if (persisted) {
      this.persistence.write(undefined, this.options.env);
    }
    this.lease = undefined;
    this.releaseRequested = false;
    return persisted;
  }

  acquire(params: {
    sessionKey: string;
    sessionId: string;
    agentId?: string;
    runId: string;
    turnId?: string;
    leaseToken: string;
  }):
    | { ok: true; holder: NodeOccupancyHolder; leaseToken: string; acquiredAtMs: number }
    | NodeOccupancyRejection {
    const sessionKey = validateIdentityField(params.sessionKey, "sessionKey");
    const sessionId = validateIdentityField(params.sessionId, "sessionId");
    const agentId =
      params.agentId === undefined ? undefined : validateIdentityField(params.agentId, "agentId");
    const runId = validateIdentityField(params.runId, "runId");
    const turnId =
      params.turnId === undefined ? undefined : validateIdentityField(params.turnId, "turnId");
    const leaseToken = validateLeaseToken(params.leaseToken);
    const occupied = this.deviceOccupiedRejection(sessionKey);
    if (occupied) {
      return occupied;
    }
    const acquiredAtMs = this.now();
    this.lease = {
      sessionKey,
      sessionId,
      ...(agentId ? { agentId } : {}),
      runId,
      ...(turnId ? { turnId } : {}),
      leaseToken,
      acquiredAtMs,
    };
    this.releaseRequested = false;
    this.writePersisted();
    return { ok: true, holder: this.requireHolderView(), leaseToken, acquiredAtMs };
  }

  renew(params: {
    sessionKey: string;
    leaseToken: string;
  }): { ok: true; holder: NodeOccupancyHolder; renewedAtMs: number } | NodeOccupancyRejection {
    const sessionKey = validateIdentityField(params.sessionKey, "sessionKey");
    const leaseToken = validateLeaseToken(params.leaseToken);
    const lease = this.lease;
    if (!lease) {
      return this.unoccupiedRejection();
    }
    const occupied = this.deviceOccupiedRejection(sessionKey);
    if (occupied) {
      return occupied;
    }
    if (lease.leaseToken !== leaseToken) {
      return this.tokenMismatchRejection(lease);
    }
    lease.renewedAtMs = this.now();
    this.writePersisted();
    return { ok: true, holder: this.requireHolderView(), renewedAtMs: lease.renewedAtMs };
  }

  release(params: {
    sessionKey: string;
    leaseToken: string;
  }): { ok: true; released: boolean; holder?: NodeOccupancyHolder } | NodeOccupancyRejection {
    const sessionKey = validateIdentityField(params.sessionKey, "sessionKey");
    const leaseToken = validateLeaseToken(params.leaseToken);
    const lease = this.lease;
    if (!lease) {
      return { ok: true, released: false };
    }
    const occupied = this.deviceOccupiedRejection(sessionKey);
    if (occupied) {
      return occupied;
    }
    if (lease.leaseToken !== leaseToken) {
      return this.tokenMismatchRejection(lease);
    }
    const holder = this.requireHolderView();
    if (this.processes.size > 0) {
      // Live lease-tagged processes keep occupancy until they are extinct.
      this.releaseRequested = true;
      return { ok: true, released: false, holder };
    }
    this.clearLease();
    return { ok: true, released: true, holder };
  }

  /**
   * Current occupancy. The holder identity is visible only to the holder
   * session or an operator view (no viewer session); other sessions learn only
   * whether the device is occupied.
   */
  status(viewerSessionKey?: string): NodeOccupancyStatus {
    const holder = this.holderView();
    if (!holder) {
      return { occupied: false };
    }
    if (viewerSessionKey !== undefined && viewerSessionKey !== holder.sessionKey) {
      return { occupied: true };
    }
    return { occupied: true, holder };
  }

  /** Lease-tagged processes must not be killed by a surprise auto-update. */
  hasActiveWork(): boolean {
    return this.processes.size > 0;
  }

  /**
   * Force-clear occupancy after tree-killing holder-owned processes. Embedding
   * hosts (and the node's own operator path) may revoke without identity; a
   * dispatching session must prove it is the holder with the current token.
   */
  async revoke(
    params: { sessionKey?: string; leaseToken?: string } = {},
  ): Promise<
    | { ok: true; revoked: boolean; holder?: NodeOccupancyHolder; killedProcesses: number }
    | NodeOccupancyRejection
  > {
    const lease = this.lease;
    if (!lease) {
      return { ok: true, revoked: false, killedProcesses: 0 };
    }
    if (params.sessionKey !== undefined) {
      const occupied = this.deviceOccupiedRejection(
        validateIdentityField(params.sessionKey, "sessionKey"),
      );
      if (occupied) {
        return occupied;
      }
      if (params.leaseToken === undefined || params.leaseToken !== lease.leaseToken) {
        return this.tokenMismatchRejection(lease);
      }
    }
    const holder = this.requireHolderView();
    const owned = [...this.processes.values()].filter(
      (process) => process.sessionKey === lease.sessionKey,
    );
    await this.killProcesses(owned);
    this.clearLease();
    return { ok: true, revoked: true, holder, killedProcesses: owned.length };
  }

  /**
   * Per-call admission for every execution command: the caller must be the
   * holder session presenting the current lease token.
   */
  admitExecution(params: {
    command: string;
    sessionKey: string | undefined;
    leaseToken: string | undefined;
  }): NodeOccupancyAdmission {
    const lease = this.lease;
    if (!lease) {
      return {
        ok: false,
        code: NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
        message:
          "device is not occupied; acquire the occupancy lease for this turn before executing commands",
      };
    }
    if (params.sessionKey === undefined || params.sessionKey !== lease.sessionKey) {
      const occupied = this.deviceOccupiedRejection(params.sessionKey);
      if (occupied) {
        return occupied;
      }
    }
    if (params.leaseToken === undefined || params.leaseToken !== lease.leaseToken) {
      return this.tokenMismatchRejection(lease);
    }
    return { ok: true, sessionKey: lease.sessionKey, leaseToken: lease.leaseToken };
  }

  /**
   * Register a process launched under the lease. The returned `settle` reports
   * process exit; a detached process keeps occupancy until the last
   * lease-tagged process is extinct, after which a held-for-processes lease
   * auto-releases.
   */
  registerLeaseProcess(
    params: { sessionKey: string; leaseToken: string },
    process: NodeOccupancyLeasedProcess,
  ): { settle: () => void } {
    const lease = this.lease;
    if (
      !lease ||
      lease.sessionKey !== params.sessionKey ||
      lease.leaseToken !== params.leaseToken
    ) {
      throw new Error("INVALID_REQUEST: lease process registration requires the current lease");
    }
    const id = `lease-process-${this.nextProcessId++}`;
    this.processes.set(id, { id, sessionKey: params.sessionKey, ...process });
    return {
      settle: () => {
        this.processes.delete(id);
        this.evaluateAutoRelease();
      },
    };
  }

  /**
   * Disconnect cleanup: tree-kill attached holder-owned processes and wait for
   * extinction. Detached processes keep the lease; their last exit releases it.
   */
  async handleDisconnect(): Promise<void> {
    const lease = this.lease;
    if (!lease) {
      return;
    }
    this.releaseRequested = true;
    const attached = [...this.processes.values()].filter((process) => !process.detached);
    if (attached.length === 0) {
      this.evaluateAutoRelease();
      return;
    }
    await this.killProcesses(attached);
    this.evaluateAutoRelease();
  }

  private async killProcesses(targets: RegisteredLeaseProcess[]): Promise<void> {
    await Promise.all(
      targets.map(async (process) => {
        try {
          await process.kill();
        } catch (error) {
          logWarn(`node-host: occupancy process kill failed (${process.id}): ${String(error)}`);
        } finally {
          this.processes.delete(process.id);
        }
      }),
    );
  }

  /** A held-for-processes lease clears once its last lease-tagged process exits. */
  private evaluateAutoRelease(): void {
    if (!this.lease || !this.releaseRequested || this.processes.size > 0) {
      this.emitStatus();
      return;
    }
    this.clearLease();
  }

  private clearLease(): void {
    this.lease = undefined;
    this.releaseRequested = false;
    this.writePersisted();
    this.emitStatus();
  }

  private emitStatus(): void {
    try {
      this.options.onStatusEvent?.(this.status());
    } catch (error) {
      logWarn(`node-host: occupancy status event failed: ${String(error)}`);
    }
  }

  private holderView(): NodeOccupancyHolder | undefined {
    const lease = this.lease;
    return lease ? holderIdentity(lease, this.detachedProcessCount(lease.sessionKey)) : undefined;
  }

  private requireHolderView(): NodeOccupancyHolder {
    const holder = this.holderView();
    if (!holder) {
      throw new Error("node occupancy holder disappeared during an owned operation");
    }
    return holder;
  }

  private detachedProcessCount(sessionKey: string): number {
    let detached = 0;
    for (const process of this.processes.values()) {
      if (process.detached && process.sessionKey === sessionKey) {
        detached += 1;
      }
    }
    return detached;
  }

  private deviceOccupiedRejection(
    callerSessionKey: string | undefined,
  ): NodeOccupancyRejection | undefined {
    const lease = this.lease;
    if (lease && callerSessionKey !== lease.sessionKey) {
      return {
        ok: false,
        code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
        message: `device occupied by ${describeHolder(lease)}`,
      };
    }
    return undefined;
  }

  private tokenMismatchRejection(lease: NodeOccupancyLease): NodeOccupancyRejection {
    return {
      ok: false,
      code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
      message: `lease token does not match the current lease for session ${lease.sessionKey}; the lease was likely re-acquired for a newer turn`,
    };
  }

  private unoccupiedRejection(): NodeOccupancyRejection {
    return {
      ok: false,
      code: NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
      message: "device is not occupied; acquire the occupancy lease before renewing",
    };
  }

  private writePersisted(): void {
    const holder = this.holderView();
    try {
      this.persistence.write(holder, this.options.env);
    } catch (error) {
      // Occupancy stays authoritative in memory; the durable row is diagnostic.
      logWarn(`node-host: occupancy persistence failed: ${String(error)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
