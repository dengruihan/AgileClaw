/**
 * Device-routed control adapters for the browser and computer tools.
 *
 * The catalog stays constant: a control tool call under device scope executes
 * here against the session's scoped device through the node commands the
 * executor profile already advertises — `browser.proxy*` for browser control,
 * `computer.act` plus `screen.snapshot` for computer/desktop control. Every
 * invoke carries the root session identity in the envelope and the occupancy
 * lease token inside the command params, which is exactly what the node's
 * per-call admission checks; admission is the token's only consumer, and the
 * node strips it again before the command's closed contract parses the payload.
 * The token is server-side truth carried in call context, never a
 * model-visible tool param. A device that is offline or lacks the command fails
 * that call with a reason; there is no Gateway fallback and no second device.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import {
  COMPUTER_ACT_COMMAND,
  type ComputerContextEpoch,
  type ComputerToolTransport,
  SCREEN_SNAPSHOT_COMMAND,
} from "./computer-tool-shared.js";
import { createComputerTool } from "./computer-tool.js";
import type { DeviceScopeRoutingState } from "./device-routing.js";
import { callGatewayTool } from "./gateway.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

/** Device-control facts of the current routed browser call. */
export type BrowserDeviceControlScope = {
  readonly deviceId: string;
  readonly rootSessionKey: string;
  readonly leaseToken: string;
};

const browserDeviceControlScopes = new AsyncLocalStorage<BrowserDeviceControlScope>();

/** Run one delegated browser tool execution bound to its device-control facts. */
export function withBrowserDeviceControlScope<T>(
  scope: BrowserDeviceControlScope,
  run: () => T,
): T {
  return browserDeviceControlScopes.run(scope, run);
}

/**
 * The device-control facts of the current routed browser call, if any. Exposed
 * to plugins through `openclaw/plugin-sdk/agent-harness-runtime` so the browser
 * tool can pin its node routing and admit its node commands under the lease.
 */
export function readBrowserDeviceControlScope(): BrowserDeviceControlScope | undefined {
  return browserDeviceControlScopes.getStore();
}

/**
 * Admission identity the routed computer transport holds for itself. Run
 * cleanup fires after the turn's calls, outside any routed-call context, so the
 * transport cannot rely on call context for its `__close_execution` invoke.
 * Each routed call refreshes the token so a mid-turn lease re-acquisition is
 * observed before the next dispatch.
 */
type DeviceComputerIdentity = { rootSessionKey: string; leaseToken: string };

/** The registry session of the scoped device; undefined means not connected. */
function readScopedDeviceSession(deviceId: string) {
  const node = getInProcessGatewayToolContext()?.nodeRegistry.get(deviceId);
  return node && node.client?.invalidated !== true ? node : undefined;
}

/**
 * Device-pinned computer transport. Observation and input run over the public
 * `computer.act`/`screen.snapshot` node commands — the same policy, approval,
 * and lease admission path any node computer invoke takes. The command params
 * carry only the admission lease token: `computer.act` and `screen.snapshot`
 * params are closed schemas, the envelope carries the session identity, and the
 * node strips the token after admission.
 */
function createDeviceComputerTransport(params: {
  deviceId: string;
  identity: DeviceComputerIdentity;
}): ComputerToolTransport {
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
      const identity = params.identity;
      const gatewayOpts = request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs };
      const raw = await callGatewayTool<{ payload?: unknown }>(
        "node.invoke",
        gatewayOpts,
        {
          nodeId: request.nodeId,
          command: request.command,
          params: {
            ...request.commandParams,
            // Admission token only; the node strips it before the closed
            // command contract parses the payload.
            leaseToken: identity.leaseToken,
          },
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          idempotencyKey: request.idempotencyKey ?? randomUUID(),
          // Envelope identity is what the node's occupancy admission checks.
          sessionKey: identity.rootSessionKey,
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      return raw && typeof raw === "object" && Object.hasOwn(raw, "payload") ? raw.payload : raw;
    },
  };
}

/** Per-turn routed computer sessions, one per scoped device (a switch rebuilds). */
const routedComputerSessions = new WeakMap<
  object,
  Map<string, { tool: AnyAgentTool; identity: DeviceComputerIdentity }>
>();

/**
 * Host selectors are meaningless under device scope: the routing wrapper owns
 * placement, so a per-call `target`/`node`/`environmentId` from the model is
 * dropped instead of failing the call.
 */
function pinComputerParams(params: Record<string, unknown>): Record<string, unknown> {
  const pinned = { ...params };
  delete pinned.target;
  delete pinned.node;
  delete pinned.environmentId;
  return pinned;
}

/**
 * Execute one already-authorized `computer` tool call on the scoped device.
 * Delegates to a real computer tool instance bound to the device transport, so
 * validation, frames, screenshots, and result projection stay with their one
 * owner instead of gaining a device duplicate. The routing state keys the
 * delegated sessions — one per turn per device — and turn cleanup closes them
 * (`__close_execution`) before the occupancy lease releases, so a later
 * device-scoped session never meets `COMPUTER_HOST_BUSY` from this turn.
 */
export async function runDeviceComputerControl(params: {
  toolCallId: string;
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  /** Routing state; owns the routed sessions and their turn cleanup. */
  state: DeviceScopeRoutingState;
  contextEpoch?: ComputerContextEpoch;
  runId?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (params.params.action === "take_control") {
    // Same boundary as the paired path: there is no takeover arbitration for a
    // scoped device, and `computer.act __take_control` is outside the closed
    // command contract. Fail per call instead of dispatching a doomed invoke.
    throw new Error(
      "take_control is only available for an attached or session desktop; a device-scoped computer has no takeover arbitration. Switch back with use_device device='gateway' for a desktop that supports it.",
    );
  }
  const sessions = routedComputerSessions.get(params.state) ?? new Map();
  routedComputerSessions.set(params.state, sessions);
  let session = sessions.get(params.deviceId);
  if (!session) {
    const identity: DeviceComputerIdentity = {
      rootSessionKey: params.rootSessionKey,
      leaseToken: params.leaseToken,
    };
    session = {
      identity,
      tool: createComputerTool({
        config: getRuntimeConfig(),
        transport: createDeviceComputerTransport({ deviceId: params.deviceId, identity }),
        // Turn cleanup and a mid-turn use_device switch close this device's
        // execution before its lease releases; a closed session is purged so
        // returning to the device opens a fresh execution, never a wedged tool.
        registerRunCleanup: (cleanup) => {
          params.state.registerDeviceControlCleanup?.(params.deviceId, async (reason) => {
            await cleanup(reason);
            routedComputerSessions.get(params.state)?.delete(params.deviceId);
          });
        },
        ...(params.contextEpoch ? { contextEpoch: params.contextEpoch } : {}),
        // Run ids expire before later assistant runs can reuse a provider call id.
        ...(params.runId ? { idempotencyScope: params.runId } : {}),
      }),
    };
    sessions.set(params.deviceId, session);
  }
  // A mid-turn lease re-acquisition mints a fresh token; carry it into the
  // transport so the next dispatch and the turn close both admit.
  session.identity.rootSessionKey = params.rootSessionKey;
  session.identity.leaseToken = params.leaseToken;
  return await session.tool.execute(
    params.toolCallId,
    pinComputerParams(params.params),
    params.signal,
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
 * `state` owns the routed computer sessions for this turn: their lifetime,
 * per-device identity, and turn cleanup.
 */
export function deviceControlAdapter(
  toolName: string,
  state: DeviceScopeRoutingState,
): ((params: DeviceControlAdapterCall) => Promise<unknown>) | undefined {
  if (toolName === "computer") {
    return (params) =>
      runDeviceComputerControl({
        toolCallId: params.toolCallId,
        params: params.params,
        deviceId: params.deviceId,
        rootSessionKey: params.rootSessionKey,
        leaseToken: params.leaseToken,
        state,
        ...(state.computerContextEpoch ? { contextEpoch: state.computerContextEpoch } : {}),
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
