/**
 * Placement-tool routing layer.
 *
 * Tool assembly keeps one constant catalog: every placement-kind tool is
 * wrapped here once, and each call resolves the session's device scope at call
 * time. Gateway-kind tools are never wrapped, so they always run on the
 * Gateway. A call that has no device adapter fails loudly instead of falling
 * back to Gateway execution.
 */
import { getRuntimeConfig } from "../../config/config.js";
import {
  acquireDeviceScopeLease,
  resolveSessionScopeRoot,
} from "../../gateway/server-methods/session-device-scope.js";
import { readSessionScopeLease } from "../../gateway/session-scope-lease.js";
import { getAgentToolExecutionLocation, copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { runDeviceExec } from "./device-exec.js";
import { listDeviceDirectory, readDeviceFile, writeDeviceFile } from "./device-files.js";
import {
  deviceScopeSwitchPendingMessage,
  resolveDevicePlacementToolKind,
  unsupportedDeviceToolMessage,
} from "./device-scope.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

export type DeviceScopeRoutingState = {
  /** Session that owns the tools; the scope root may be an ancestor. */
  sessionKey: string;
  agentId: string;
  sessionId?: string;
  runId?: string;
  /** True while use_device is switching; no other placement call may start. */
  switchPending: boolean;
  /** Set by use_device so the next call re-reads the committed scope. */
  markScope(): void;
  resolveRoot(): { rootSessionKey: string; agentId: string; scopeDeviceId?: string } | undefined;
};

export function createDeviceScopeRoutingState(params: {
  sessionKey: string;
  agentId: string;
  sessionId?: string;
  runId?: string;
}): DeviceScopeRoutingState {
  let cached: { rootSessionKey: string; agentId: string; scopeDeviceId?: string } | undefined;
  let resolved = false;
  const state: DeviceScopeRoutingState = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    switchPending: false,
    markScope() {
      // The scope write is committed by the patch owner; drop the cached read
      // so the next placement call observes the new value.
      resolved = false;
      cached = undefined;
    },
    resolveRoot() {
      if (!resolved) {
        const root = resolveSessionScopeRoot({
          cfg: getRuntimeConfig(),
          sessionKey: state.sessionKey,
          agentId: state.agentId,
        });
        cached = root
          ? {
              rootSessionKey: root.rootSessionKey,
              agentId: root.agentId,
              ...(root.entry.scopeDeviceId ? { scopeDeviceId: root.entry.scopeDeviceId } : {}),
            }
          : undefined;
        resolved = true;
      }
      return cached;
    },
  };
  return state;
}

/** The mirror is authoritative for the token; the node is authoritative for the lease. */
function readMirroredLeaseToken(rootSessionKey: string, deviceId: string): string | undefined {
  const mirrored = readSessionScopeLease(rootSessionKey);
  return mirrored?.deviceId === deviceId ? mirrored.leaseToken : undefined;
}

/**
 * Resolve the lease token for one device call. A missing mirror (Gateway
 * restart, expired hygiene) re-acquires through the same owner that use_device
 * uses; a busy device fails here with the holder identity, never by falling
 * back to Gateway execution.
 */
async function ensureDeviceScopeLease(params: {
  rootSessionKey: string;
  sessionId: string;
  agentId: string;
  runId?: string;
  deviceId: string;
  signal?: AbortSignal;
}): Promise<string> {
  const mirrored = readMirroredLeaseToken(params.rootSessionKey, params.deviceId);
  if (mirrored) {
    return mirrored;
  }
  const context = getInProcessGatewayToolContext();
  if (!context) {
    throw new Error(
      "device-scoped tools require a Gateway-hosted session: the Gateway owns the device lease. Switch back with use_device device='gateway' or run this session on the Gateway.",
    );
  }
  const session = context.nodeRegistry.get(params.deviceId);
  if (!session || session.client?.invalidated === true) {
    throw new Error(
      `scoped device ${params.deviceId} is not connected; reconnect it before running placement tools. There is no gateway fallback.`,
    );
  }
  const grant = await acquireDeviceScopeLease({
    registry: context.nodeRegistry,
    deviceId: params.deviceId,
    rootSessionKey: params.rootSessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!grant.ok) {
    throw new Error(grant.message);
  }
  return grant.lease.leaseToken;
}

type AdapterCall = (params: {
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  platform?: string;
  agentId: string;
  runId?: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

function deviceFileAdapter(toolName: string): AdapterCall | undefined {
  if (toolName === "read") {
    return (params) => readDeviceFile(params);
  }
  if (toolName === "ls") {
    return (params) => listDeviceDirectory(params);
  }
  if (toolName === "write") {
    return (params) => writeDeviceFile(params);
  }
  return undefined;
}

async function executeOnDevice(params: {
  toolName: string;
  state: DeviceScopeRoutingState;
  root: { rootSessionKey: string; agentId: string; scopeDeviceId?: string };
  toolParams: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const deviceId = params.root.scopeDeviceId;
  if (!deviceId) {
    throw new Error("device scope disappeared during the call; retry after the next step");
  }
  if (!params.state.sessionId) {
    throw new Error("device-scoped tools require a durable session id");
  }
  if (params.toolName === "process") {
    // The process tool inspects Gateway-owned background exec; device exec is
    // foreground, so there is nothing for it to control under device scope.
    throw new Error(unsupportedDeviceToolMessage(params.toolName, deviceId));
  }
  const kind = resolveDevicePlacementToolKind(params.toolName);
  const adapter: AdapterCall | undefined =
    kind === "exec"
      ? runDeviceExec
      : kind === "file"
        ? deviceFileAdapter(params.toolName)
        : undefined;
  if (!adapter) {
    throw new Error(unsupportedDeviceToolMessage(params.toolName, deviceId));
  }
  const leaseToken = await ensureDeviceScopeLease({
    rootSessionKey: params.root.rootSessionKey,
    sessionId: params.state.sessionId,
    agentId: params.state.agentId,
    ...(params.state.runId ? { runId: params.state.runId } : {}),
    deviceId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const platform = getInProcessGatewayToolContext()?.nodeRegistry.get(deviceId)?.platform;
  return await adapter({
    params: params.toolParams,
    deviceId,
    rootSessionKey: params.root.rootSessionKey,
    leaseToken,
    agentId: params.state.agentId,
    ...(platform ? { platform } : {}),
    ...(params.state.runId ? { runId: params.state.runId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

const ROUTED_TOOLS = new WeakSet<object>();

/** Wrap every placement-kind tool once; Gateway-kind tools pass through untouched. */
export function applyDeviceScopeToolRouting(
  tools: AnyAgentTool[],
  state: DeviceScopeRoutingState,
): AnyAgentTool[] {
  return tools.map((tool) => {
    if (getAgentToolExecutionLocation(tool).kind !== "placement") {
      return tool;
    }
    // A routed tool already carries this call's state; re-wrapping would swap it.
    if (ROUTED_TOOLS.has(tool)) {
      return tool;
    }
    const source = tool;
    const routed: AnyAgentTool = {
      ...source,
      execute: async (toolCallId, toolParams, signal, onUpdate) => {
        if (state.switchPending) {
          throw new Error(deviceScopeSwitchPendingMessage());
        }
        const root = state.resolveRoot();
        if (!root?.scopeDeviceId) {
          return await source.execute(toolCallId, toolParams, signal, onUpdate);
        }
        const callParams =
          toolParams && typeof toolParams === "object"
            ? (toolParams as Record<string, unknown>)
            : {};
        const result = await executeOnDevice({
          toolName: source.name,
          state,
          root,
          toolParams: callParams,
          ...(signal ? { signal } : {}),
        });
        return result as Awaited<ReturnType<typeof source.execute>>;
      },
    };
    ROUTED_TOOLS.add(routed);
    return copyAgentToolMetadata(source, routed);
  });
}
