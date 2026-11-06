import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { readSystemInfo } from "../../lib/system-info.ts";

export type MonitoringInventory = {
  environments: EnvironmentSummary[];
  nodes: NodeListNode[];
  gatewaySystemInfo: SystemInfoResult | null;
  gatewaySampledAtMs: number | null;
  errors: { nodes?: string; systemInfo?: string };
};

export type MonitoringSessionRelation = {
  // These are recorded bindings, not proof that a model turn ran on the host.
  kind: "placement" | "retained-placement" | "runner" | "exec-binding" | "gateway";
  session: GatewaySessionRow;
};

export type MonitoringRow = {
  environment: EnvironmentSummary;
  node?: NodeListNode;
  gatewaySystemInfo?: SystemInfoResult;
  sessions: MonitoringSessionRelation[];
};

/** The dashboards monitoring owner schedules refreshes and publishes this snapshot. */
export async function loadMonitoringInventory(
  gateway: ApplicationGateway,
  options: { isCurrent: () => boolean; signal?: AbortSignal; fresh?: boolean },
): Promise<MonitoringInventory | undefined> {
  const client = gateway.snapshot.client;
  if (!client || !options.isCurrent() || options.signal?.aborted) {
    return undefined;
  }
  const requestOptions = { signal: options.signal };
  const [inventory, nodes, systemInfo] = await Promise.allSettled([
    client.request<EnvironmentsListResult>(
      "environments.list",
      { includeDesktopSetup: true },
      requestOptions,
    ),
    client.request<{ nodes: NodeListNode[] }>("node.list", {}, requestOptions),
    readSystemInfo(gateway, options.signal, { fresh: options.fresh }),
  ]);
  if (!options.isCurrent() || options.signal?.aborted) {
    return undefined;
  }
  // A hidden document cancels its reads and the next visibility check owns the
  // retry. An unavailable `system.info` method is not a cancelled load: publish
  // the inventory without measurements instead of retrying forever.
  if (
    systemInfo.status === "rejected" &&
    systemInfo.reason instanceof DOMException &&
    systemInfo.reason.name === "AbortError" &&
    document.visibilityState === "hidden"
  ) {
    return undefined;
  }
  // Never rebuild inventory from auxiliary node reads: that would resurrect cloud-owned
  // pairings deliberately suppressed by environments.list and hide inventory failures.
  if (inventory.status === "rejected") {
    throw inventory.reason;
  }
  return {
    environments: inventory.value.environments,
    nodes: nodes.status === "fulfilled" ? nodes.value.nodes : [],
    gatewaySystemInfo: systemInfo.status === "fulfilled" ? systemInfo.value.value : null,
    gatewaySampledAtMs: systemInfo.status === "fulfilled" ? systemInfo.value.at : null,
    errors: {
      ...(nodes.status === "rejected" ? { nodes: formatUiError(nodes.reason) } : {}),
      ...(systemInfo.status === "rejected" ? { systemInfo: formatUiError(systemInfo.reason) } : {}),
    },
  };
}

/** Join only exact Gateway identities; desktop capability never determines row membership. */
export function projectMonitoringInventory(
  inventory: MonitoringInventory,
  sessions: readonly GatewaySessionRow[],
): MonitoringRow[] {
  const nodes = new Map(inventory.nodes.map((node) => [`node:${node.nodeId}`, node]));
  const relations = new Map<string, MonitoringSessionRelation[]>();
  const add = (id: string, kind: MonitoringSessionRelation["kind"], session: GatewaySessionRow) => {
    const existing = relations.get(id);
    const relation = { kind, session };
    if (existing) {
      existing.push(relation);
    } else {
      relations.set(id, [relation]);
    }
  };
  for (const session of sessions) {
    const placement = session.placement;
    if (placement && placement.state !== "local") {
      if (placement.state === "requested") {
        continue;
      }
      if (placement.environmentId) {
        add(
          placement.environmentId,
          placement.state === "reclaimed" || placement.state === "failed"
            ? "retained-placement"
            : "placement",
          session,
        );
      }
      if (placement.state === "active" && placement.runner?.deviceId) {
        add(`node:${placement.runner.deviceId}`, "runner", session);
      }
      continue;
    }
    const execNode = session.execNode?.trim();
    add(execNode ? `node:${execNode}` : "gateway", execNode ? "exec-binding" : "gateway", session);
  }
  return inventory.environments
    .filter((environment) => {
      // Terminal worker records remain in Gateway history after their machine is gone.
      return (
        environment.type !== "worker" ||
        (environment.worker?.state !== "destroyed" && environment.worker?.state !== "failed")
      );
    })
    .map((environment) => ({
      environment,
      node: environment.type === "node" ? nodes.get(environment.id) : undefined,
      gatewaySystemInfo:
        environment.id === "gateway" ? (inventory.gatewaySystemInfo ?? undefined) : undefined,
      sessions: relations.get(environment.id) ?? [],
    }));
}
