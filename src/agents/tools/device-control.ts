/**
 * Device-routed control adapters for the browser and computer tools.
 *
 * The catalog stays constant: a control tool call under device scope executes
 * here against the session's scoped device through the node commands the
 * executor profile already advertises — `browser.proxy*` for browser control,
 * `computer.act` plus `screen.snapshot` for computer/desktop control. Every
 * invoke carries the root session identity in the envelope and the occupancy
 * lease token inside the command params, which is exactly what the node's
 * per-call admission checks. The token is server-side truth carried in call
 * context, never a model-visible tool param. A device that is offline or lacks
 * the command fails that call with a reason; there is no Gateway fallback and
 * no second device.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import {
  COMPUTER_ACT_COMMAND,
  type ComputerToolTransport,
  SCREEN_SNAPSHOT_COMMAND,
} from "./computer-tool-shared.js";
import { createComputerTool } from "./computer-tool.js";
import { callGatewayTool } from "./gateway.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

/** Device-control facts of the current routed call. */
export type BrowserDeviceControlScope = {
  readonly deviceId: string;
  readonly rootSessionKey: string;
  readonly leaseToken: string;
};

const deviceControlScopes = new AsyncLocalStorage<BrowserDeviceControlScope>();

/** Run one delegated control-tool execution bound to its device-control facts. */
export function withBrowserDeviceControlScope<T>(
  scope: BrowserDeviceControlScope,
  run: () => T,
): T {
  return deviceControlScopes.run(scope, run);
}

/**
 * The device-control facts of the current routed control call, if any. Exposed
 * to plugins through `openclaw/plugin-sdk/agent-harness-runtime` so the browser
 * tool can pin its node routing and admit its node commands under the lease.
 */
export function readBrowserDeviceControlScope(): BrowserDeviceControlScope | undefined {
  return deviceControlScopes.getStore();
}

/** The registry session of the scoped device; undefined means not connected. */
function readScopedDeviceSession(deviceId: string) {
  const node = getInProcessGatewayToolContext()?.nodeRegistry.get(deviceId);
  return node && node.client?.invalidated !== true ? node : undefined;
}

/**
 * Device-pinned computer transport. Observation and input run over the public
 * `computer.act`/`screen.snapshot` node commands — the same policy, approval,
 * and lease admission path any node computer invoke takes — with the root
 * session identity and lease token injected on every call.
 */
function createDeviceComputerTransport(params: { deviceId: string }): ComputerToolTransport {
  return {
    resolveNode: async (query, signal) => {
      signal?.throwIfAborted();
      const node = readScopedDeviceSession(params.deviceId);
      if (!node) {
        throw new Error(
          `scoped device ${params.deviceId} is not connected; reconnect it before controlling its desktop. There is no gateway fallback.`,
        );
      }
      if (query !== undefined && query !== params.deviceId) {
        throw new Error(
          `computer control is bound to device ${params.deviceId} by this session's device scope; switch scope with use_device instead of selecting another node.`,
        );
      }
      const missing = [COMPUTER_ACT_COMMAND, SCREEN_SNAPSHOT_COMMAND].filter(
        (command) => !node.commands.includes(command),
      );
      if (missing.length > 0) {
        throw new Error(
          `scoped device ${params.deviceId} does not advertise computer control (missing ${missing.join(", ")}); it cannot run the computer tool under device scope. There is no gateway fallback.`,
        );
      }
      return {
        nodeId: params.deviceId,
        ...(node.computerUse ? { computerUse: node.computerUse } : {}),
      };
    },
    invoke: async (request) => {
      const scope = readBrowserDeviceControlScope();
      if (!scope || scope.deviceId !== request.nodeId) {
        throw new Error("device computer control was invoked outside its routed call");
      }
      const gatewayOpts = request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs };
      const raw = await callGatewayTool<{ payload?: unknown }>(
        "node.invoke",
        gatewayOpts,
        {
          nodeId: request.nodeId,
          command: request.command,
          params: {
            ...request.commandParams,
            // Admission identity rides inside params so the invoke wire is unchanged.
            sessionKey: scope.rootSessionKey,
            leaseToken: scope.leaseToken,
          },
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          idempotencyKey: request.idempotencyKey ?? randomUUID(),
          // Envelope identity is what the node's occupancy admission checks.
          sessionKey: scope.rootSessionKey,
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      return raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : raw;
    },
  };
}

/** One routed computer session per turn: frames and observations stay per scope. */
const routedComputerTools = new WeakMap<object, AnyAgentTool>();

/**
 * Execute one already-authorized `computer` tool call on the scoped device.
 * Delegates to a real computer tool instance bound to the device transport, so
 * validation, frames, screenshots, and result projection stay with their one
 * owner instead of gaining a device duplicate. The routing state keys the
 * delegated session: one per turn, the same lifetime the assembled computer
 * tool has.
 */
export async function runDeviceComputerControl(params: {
  toolCallId: string;
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  /** Routing state; keys the routed computer session for this turn. */
  cacheKey: object;
  runId?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  let delegated = routedComputerTools.get(params.cacheKey);
  if (!delegated) {
    delegated = createComputerTool({
      config: getRuntimeConfig(),
      transport: createDeviceComputerTransport({ deviceId: params.deviceId }),
      // Run ids expire before later assistant runs can reuse a provider call id.
      ...(params.runId ? { idempotencyScope: params.runId } : {}),
    });
    routedComputerTools.set(params.cacheKey, delegated);
  }
  const tool = delegated;
  return await withBrowserDeviceControlScope(
    {
      deviceId: params.deviceId,
      rootSessionKey: params.rootSessionKey,
      leaseToken: params.leaseToken,
    },
    () => tool.execute(params.toolCallId, params.params, params.signal),
  );
}

/**
 * Execute one already-authorized `browser` tool call on the scoped device. The
 * plugin tool keeps its full action surface; pinning `target=node` to the
 * scoped device makes its own guards fail closed for host, sandbox, dashboard,
 * and host-only lifecycle actions, and the call context carries the lease
 * identity its node proxy injects into every `browser.proxy*` invoke.
 */
export async function runDeviceBrowserControl(params: {
  source: AnyAgentTool;
  toolCallId: string;
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const pinned = { ...params.params, target: "node", node: params.deviceId };
  return await withBrowserDeviceControlScope(
    {
      deviceId: params.deviceId,
      rootSessionKey: params.rootSessionKey,
      leaseToken: params.leaseToken,
    },
    () => params.source.execute(params.toolCallId, pinned, params.signal),
  );
}

/** What the routing layer passes to a device control adapter. */
export type DeviceControlAdapterCall = {
  toolCallId: string;
  params: Record<string, unknown>;
  source: AnyAgentTool;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  agentId: string;
  runId?: string;
  signal?: AbortSignal;
};

/**
 * Adapter selector the routing layer consults for placement control tools.
 * `cacheKey` is the routing state, so the routed computer session lives exactly
 * as long as the turn's tool assembly.
 */
export function deviceControlAdapter(
  toolName: string,
  cacheKey: object,
): ((params: DeviceControlAdapterCall) => Promise<unknown>) | undefined {
  if (toolName === "computer") {
    return (params) =>
      runDeviceComputerControl({
        toolCallId: params.toolCallId,
        params: params.params,
        deviceId: params.deviceId,
        rootSessionKey: params.rootSessionKey,
        leaseToken: params.leaseToken,
        cacheKey,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
  }
  if (toolName === "browser") {
    return (params) =>
      runDeviceBrowserControl({
        source: params.source,
        toolCallId: params.toolCallId,
        params: params.params,
        deviceId: params.deviceId,
        rootSessionKey: params.rootSessionKey,
        leaseToken: params.leaseToken,
        ...(params.signal ? { signal: params.signal } : {}),
      });
  }
  return undefined;
}
