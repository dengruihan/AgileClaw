/**
 * `use_device` — switch this session's tool-execution scope.
 *
 * The tool always runs on the Gateway (it is a gateway-kind catalog tool). It
 * never executes placement work itself: it validates and leases the device
 * through the session patch owner, then reports the new scope. The switch takes
 * effect for subsequent placement calls at the next step boundary, so it must
 * be the only placement-affecting call in its step.
 */
import { Type } from "typebox";
import { publishToolActionDeviceScope } from "../../audit/tool-action-device-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionScopeRoot } from "../../gateway/server-methods/session-device-scope.js";
import { readSessionScopeLease } from "../../gateway/session-scope-lease.js";
import { bindAgentToolExecutionLocation } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import type { DeviceScopeRoutingState } from "./device-routing.js";
import { deviceScopeSwitchGuidance, parseUseDeviceTarget } from "./device-scope.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";
import { listNodes, resolveNodeIdFromList } from "./nodes-utils.js";
import { textResult } from "./tool-results.js";

export const USE_DEVICE_TOOL_NAME = "use_device";

export const USE_DEVICE_TOOL_DESCRIPTION =
  "Switch this session's placement-tool execution scope between the Gateway and one paired device. Placement tools (exec, read/write/ls, browser/computer control) then run on that device under its occupancy lease; Gateway tools always run on the Gateway. The switch applies from the next step, so call it alone: never combine it with another placement tool in the same step. Switching to a busy, disabled, or disconnected device fails immediately with the holder identity; nothing queues and nothing falls back to the Gateway.";

const UseDeviceToolSchema = Type.Object({
  device: Type.String({
    description:
      "Paired device id, display name, or IP to execute this session's placement tools, or 'gateway' to return execution to the Gateway.",
  }),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

type UseDeviceDetails = {
  scope: "gateway" | "device";
  deviceId: string | null;
  displayName?: string;
  platform?: string;
  connected?: boolean;
  leaseHeld: boolean;
  lease?: { holder: string; expiresAt: number };
  previousScopeDeviceId: string | null;
};

function readEntryScopeDeviceId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = (value as { entry?: unknown }).entry;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const scope = (raw as { scopeDeviceId?: unknown }).scopeDeviceId;
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

/**
 * Build the gateway-bound use_device tool. The routing state is shared with the
 * placement-tool wrappers so the switch is visible to the very next call.
 */
export function createUseDeviceTool(params: {
  state: DeviceScopeRoutingState;
  sessionKey: string;
  agentId: string;
  cfg?: OpenClawConfig;
  signal?: AbortSignal;
}): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: USE_DEVICE_TOOL_NAME,
    label: "Use Device",
    description: USE_DEVICE_TOOL_DESCRIPTION,
    parameters: UseDeviceToolSchema,
    displaySummary: "Switch tool-execution device",
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      const input = (rawParams ?? {}) as Record<string, unknown>;
      const requestedDevice = input.device;
      const target = parseUseDeviceTarget(
        typeof requestedDevice === "string" ? requestedDevice : "",
      );
      const gatewayOpts = readGatewayCallOptions(input);
      const rootScope = params.cfg
        ? resolveSessionScopeRoot({
            cfg: params.cfg,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
          })
        : undefined;
      const previous =
        params.state.resolveRoot()?.scopeDeviceId ?? rootScope?.entry.scopeDeviceId ?? null;

      // A subagent shares its tree's lease and scope: switching must happen at
      // the root, where the occupancy holder identity lives.
      if (rootScope && rootScope.rootSessionKey !== params.sessionKey) {
        throw new Error(
          `device scope is shared with the root session ${rootScope.rootSessionKey}; call use_device from that root session instead`,
        );
      }

      let deviceId: string | null = null;
      let matched:
        | { nodeId: string; displayName?: string; platform?: string; connected?: boolean }
        | undefined;
      if (target.kind === "device") {
        const nodes = await listNodes(gatewayOpts, params.signal);
        if (nodes.length === 0) {
          throw new Error(
            "no paired devices available; pair a device and run its node host with the executor profile before using it",
          );
        }
        deviceId = resolveNodeIdFromList(nodes, target.deviceId);
        const node = nodes.find((entry) => entry.nodeId === deviceId);
        matched = {
          nodeId: deviceId,
          ...(node?.displayName ? { displayName: node.displayName } : {}),
          ...(node?.platform ? { platform: node.platform } : {}),
          ...(typeof node?.connected === "boolean" ? { connected: node.connected } : {}),
        };
      }

      // Only one placement-affecting call may run in a step; the routing guard
      // rejects any placement call that starts while this switch is in flight.
      params.state.switchPending = true;
      let result: unknown;
      try {
        // The patch owner releases the previous device's lease once the new
        // scope commits. Close that device's routed computer sessions first,
        // while its lease still admits the close — otherwise the stale
        // execution wedges the device for other sessions until a node restart.
        if (previous && previous !== deviceId) {
          await params.state.closeDeviceControlSessions(previous, "scope-switched");
        }
        result = await callGatewayTool(
          "sessions.patch",
          gatewayOpts,
          { key: params.sessionKey, scopeDeviceId: deviceId },
          params.signal ? { signal: params.signal } : undefined,
        );
      } catch (error) {
        const details = (error as { details?: { code?: unknown } } | undefined)?.details;
        const code = typeof details?.code === "string" ? `${details.code}: ` : "";
        throw new Error(
          `${code}${error instanceof Error ? error.message : String(error)}. The session keeps its previous scope (${previous ?? "gateway"}); no queueing and no gateway fallback.`,
          { cause: error },
        );
      } finally {
        params.state.switchPending = false;
      }

      // The Gateway commits the entry write before responding; drop our cached
      // read so the next placement call observes the new scope.
      params.state.markScope();
      const writtenScope = readEntryScopeDeviceId(result) ?? deviceId;
      const rootSessionKey = params.state.resolveRoot()?.rootSessionKey ?? params.sessionKey;
      const mirror = readSessionScopeLease(rootSessionKey);
      // The committed scope feeds the tool-action audit projection: placement
      // calls from the next step on carry the executing device.
      publishToolActionDeviceScope({ sessionKey: params.sessionKey, deviceId: writtenScope });
      if (writtenScope) {
        // The switch acquired a real lease; turn end must hand it back.
        params.state.noteLeaseUsed(rootSessionKey, getInProcessGatewayToolContext()?.nodeRegistry);
      }
      const leaseHeld = Boolean(mirror && (!deviceId || mirror.deviceId === deviceId));
      const details: UseDeviceDetails = {
        scope: writtenScope ? "device" : "gateway",
        deviceId: writtenScope,
        ...(matched?.displayName ? { displayName: matched.displayName } : {}),
        ...(matched?.platform ? { platform: matched.platform } : {}),
        ...(matched?.connected !== undefined ? { connected: matched.connected } : {}),
        leaseHeld,
        ...(mirror ? { lease: { holder: mirror.holder, expiresAt: mirror.expiresAt } } : {}),
        previousScopeDeviceId: previous,
      };
      const text = [
        writtenScope
          ? `Scope: device ${writtenScope}${matched?.displayName ? ` (${matched.displayName})` : ""}`
          : "Scope: gateway",
        writtenScope
          ? `Occupancy lease: ${leaseHeld ? `held by ${mirror?.holder ?? rootSessionKey}` : "acquired by the Gateway (mirror not visible in this process)"}`
          : "Occupancy lease: released",
        deviceScopeSwitchGuidance(),
      ].join("\n");
      return textResult(text, details);
    },
  };
  bindAgentToolExecutionLocation(tool, { kind: "gateway" });
  return tool;
}
