/** Occupancy wiring for the node-host invoke pipeline and disconnect cleanup. */
import type { NodeOccupancyStatus } from "../../packages/gateway-protocol/src/schema/nodes.js";
import {
  NODE_OCCUPANCY_COMMANDS,
  NODE_OCCUPANCY_STATUS_EVENT,
  NODE_SYSTEM_RUN_COMMAND,
  isNodeOccupancyAdmissionExemptCommand,
  isNodeOccupancyCommand,
  isNodeOccupancyControlCommand,
} from "../infra/node-commands.js";
import { logDebug } from "../logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeHostClient, NodeInvokeResponder } from "./client.js";
import { handleOccupancyInvoke } from "./invoke-occupancy.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";
import { buildNodeEventParams } from "./node-event-params.js";
import { NodeOccupancyControlGate } from "./node-occupancy-control-gate.js";
import {
  NodeOccupancyOwner,
  extractOccupancyLeaseToken,
  type NodeOccupancyAdmission,
} from "./node-occupancy.js";

export type NodeOccupancyGrant = Extract<NodeOccupancyAdmission, { ok: true }>;

export type OccupancyInvokeOutcome =
  | { handoff: "dispatch"; admission?: NodeOccupancyGrant }
  | { handoff: "answered" };

/**
 * Owns the node's occupancy orchestration around one `NodeOccupancyOwner`: the
 * lifecycle command handlers, per-call admission, lease-tagged exec registration,
 * control serialization, status events, and disconnect cleanup.
 */
export class NodeOccupancyRuntime {
  readonly owner: NodeOccupancyOwner;
  private readonly controlGate = new NodeOccupancyControlGate();
  private statusSink: ((status: NodeOccupancyStatus) => void) | undefined;

  constructor(params: { env: NodeJS.ProcessEnv }) {
    this.owner = new NodeOccupancyOwner({
      env: params.env,
      onStatusEvent: (status) => this.emitStatus(status),
    });
  }

  attachClient(client: NodeHostClient): void {
    this.statusSink = (status) => {
      void client
        .request("node.event", buildNodeEventParams(NODE_OCCUPANCY_STATUS_EVENT, status))
        .catch(() => {
          // Status events are best-effort; the durable row stays diagnostic.
        });
    };
  }

  /**
   * Classify an invoke before dispatch. Lifecycle commands answer through the
   * responder here; every other command must pass lease admission unless it is
   * exempt.
   */
  async beginInvoke(
    frame: NodeInvokeRequestPayload,
    response: NodeInvokeResponder,
  ): Promise<OccupancyInvokeOutcome> {
    if (isNodeOccupancyCommand(frame.command)) {
      await this.handleLifecycle(frame, response);
      return { handoff: "answered" };
    }
    if (isNodeOccupancyAdmissionExemptCommand(frame.command)) {
      return { handoff: "dispatch" };
    }
    const admission = this.owner.admitExecution({
      command: frame.command,
      sessionKey: frame.sessionKey ?? undefined,
      leaseToken: extractOccupancyLeaseToken(frame.paramsJSON),
    });
    if (!admission.ok) {
      await response.error(admission.code, admission.message);
      return { handoff: "answered" };
    }
    return { handoff: "dispatch", admission };
  }

  async handleLifecycle(
    frame: NodeInvokeRequestPayload,
    response: NodeInvokeResponder,
  ): Promise<void> {
    await handleOccupancyInvoke({
      command: frame.command,
      paramsJSON: frame.paramsJSON,
      sessionKey: frame.sessionKey ?? undefined,
      occupancy: this.owner,
      response,
    });
  }

  /**
   * Register a lease-tagged exec under the lease. The returned settle hook
   * releases the registration once the process tree is extinct; revoke and
   * disconnect abort through the same handle and wait for that settlement.
   */
  registerLeaseProcessForInvoke(params: {
    command: string;
    admission: NodeOccupancyGrant | undefined;
    abort: () => void;
  }): (() => void) | undefined {
    if (params.command !== NODE_SYSTEM_RUN_COMMAND || params.admission === undefined) {
      return undefined;
    }
    const settled = createDeferredCore();
    const { settle } = this.owner.registerLeaseProcess(params.admission, {
      detached: false,
      kill: async () => {
        params.abort();
        await settled.promise;
      },
    });
    return () => {
      settle();
      settled.resolve();
    };
  }

  shouldSerializeControl(command: string): boolean {
    return isNodeOccupancyControlCommand(command);
  }

  async runControl<T>(operation: () => Promise<T>): Promise<T> {
    return await this.controlGate.run(operation);
  }

  hasActiveWork(): boolean {
    return this.owner.hasActiveWork();
  }

  async handleDisconnect(): Promise<void> {
    await this.owner.handleDisconnect();
  }

  emitStatus(status: NodeOccupancyStatus): void {
    this.statusSink?.(status);
  }
}

/**
 * Build the occupancy runtime when this node advertises the lease: the executor
 * profile, an explicit enable, or a command allowlist carrying occupancy
 * commands. Boot clearing runs here, before the node advertises anything.
 */
export function createNodeOccupancyRuntime(params: {
  profile: boolean;
  enabled?: boolean;
  commandAllowlist?: ReadonlySet<string>;
  env: NodeJS.ProcessEnv;
}): NodeOccupancyRuntime | undefined {
  const enabled =
    params.profile ||
    params.enabled === true ||
    (params.commandAllowlist !== undefined &&
      NODE_OCCUPANCY_COMMANDS.some((command) => params.commandAllowlist?.has(command)));
  if (!enabled) {
    return undefined;
  }
  const runtime = new NodeOccupancyRuntime({ env: params.env });
  try {
    runtime.owner.initialize();
  } catch (error) {
    logDebug(`node-host: occupancy boot clearing failed: ${String(error)}`);
  }
  return runtime;
}
