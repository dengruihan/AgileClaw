/**
 * Device-routed exec adapter.
 *
 * Runs the `exec` tool's command on the session's scoped device over the
 * existing `system.run` node command. Every call carries the root session
 * identity in the invoke envelope and the occupancy lease token inside the
 * command params, which is exactly what M61 per-call admission checks. Exec is
 * foreground by contract: detached spawn is rejected here instead of silently
 * escaping the lease.
 *
 * Output streams to the tool's onUpdate through the registry progress channel
 * (`node.invoke.progress` → PendingInvoke.onProgress) when the caller provides
 * an update callback; frames are bounded and the final result stays the single
 * authoritative outcome, so cancel and timeout behavior is unchanged.
 */
import { randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayNodeInvokeStream } from "../../gateway/server-methods/types.js";
import { buildNodeShellCommand } from "../../infra/node-shell.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import type { AgentToolResult } from "../runtime/index.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { textResult } from "./tool-results.js";

/** Node exec default program timer matches the Gateway exec tool default. */
const DEVICE_EXEC_DEFAULT_TIMEOUT_SEC = 1_800;
/** The Gateway must outlive the node program timer to report its structured timeout. */
const DEVICE_EXEC_TIMEOUT_GRACE_MS = 15_000;
/** Model-facing bound; a longer result is truncated instead of dropped. */
const DEVICE_EXEC_OUTPUT_MAX_BYTES = 32 * 1024;
/** Total streamed bytes forwarded to onUpdate before the stream goes quiet. */
const DEVICE_EXEC_STREAM_MAX_BYTES = 32 * 1024;
/** Rolling tail kept for each partial update so late output stays visible. */
const DEVICE_EXEC_STREAM_TAIL_BYTES = 4 * 1024;

export type DeviceExecDetails = {
  status: "completed" | "failed" | "running";
  nodeId: string;
  deviceScope: string;
  exitCode: number | null;
  durationMs: number;
  timedOut?: boolean;
  aggregated: string;
  cwd?: string;
  truncated?: boolean;
};

function rejectUnsupportedExecParams(params: Record<string, unknown>): void {
  if (params.background === true || params.yieldMs !== undefined) {
    throw new ToolInputError(
      "device-scoped exec is foreground; background processes are not supported under the device lease. Run it in the foreground or switch back with use_device device='gateway'.",
    );
  }
  if (params.pty === true) {
    throw new ToolInputError(
      "device-scoped exec does not allocate a PTY; switch back with use_device device='gateway' for PTY sessions.",
    );
  }
  if (params.elevated === true) {
    throw new ToolInputError(
      "device-scoped exec cannot elevate; the device node's own approval policy governs the command.",
    );
  }
  const host = readToolStringParam(params, "host");
  if (host && host !== "node") {
    throw new ToolInputError(
      `device-scoped exec runs on the session's device; a per-call host override (${host}) is not allowed. Switch scope with use_device instead.`,
    );
  }
  const gatewayOverride =
    readToolStringParam(params, "gatewayUrl") ?? readToolStringParam(params, "gatewayToken");
  if (gatewayOverride !== undefined) {
    throw new ToolInputError(
      "device-scoped exec targets the session's Gateway; per-call gateway overrides are not allowed.",
    );
  }
}

/**
 * Bounded progress consumer for one device exec. Chunks append to a capped
 * rolling tail; updates stop after the stream budget is spent so a chatty
 * command can never flood the model context.
 */
function createDeviceExecStream(params: {
  deviceId: string;
  startedAt: number;
  signal?: AbortSignal;
  onUpdate: (update: AgentToolResult<DeviceExecDetails>) => void;
}): GatewayNodeInvokeStream {
  let aggregated = "";
  let forwarded = 0;
  let quiet = false;
  const isRuntimeCurrent = () => !(params.signal?.aborted ?? false) && !quiet;
  return {
    isRuntimeCurrent,
    onDispatchReady: () => undefined,
    onProgress: (chunk: string) => {
      if (!chunk || !isRuntimeCurrent()) {
        return;
      }
      aggregated += chunk;
      if (aggregated.length > DEVICE_EXEC_STREAM_TAIL_BYTES) {
        aggregated = aggregated.slice(aggregated.length - DEVICE_EXEC_STREAM_TAIL_BYTES);
      }
      forwarded += chunk.length;
      if (forwarded > DEVICE_EXEC_STREAM_MAX_BYTES) {
        quiet = true;
        return;
      }
      params.onUpdate({
        content: [{ type: "text", text: aggregated }],
        details: {
          status: "running",
          nodeId: params.deviceId,
          deviceScope: params.deviceId,
          exitCode: null,
          durationMs: Date.now() - params.startedAt,
          aggregated,
          ...(forwarded >= DEVICE_EXEC_STREAM_MAX_BYTES ? { truncated: true as const } : {}),
        },
      });
    },
  };
}

/** Execute one already-authorized placement call on the scoped device. */
export async function runDeviceExec(params: {
  params: Record<string, unknown>;
  deviceId: string;
  platform?: string;
  rootSessionKey: string;
  leaseToken: string;
  agentId: string;
  runId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: AgentToolResult<DeviceExecDetails>) => void;
}) {
  const command = readToolStringParam(params.params, "command", { required: true });
  rejectUnsupportedExecParams(params.params);
  const requestedNode = readToolStringParam(params.params, "node");
  if (requestedNode && requestedNode !== params.deviceId) {
    throw new ToolInputError(
      `exec is scoped to device ${params.deviceId}; a per-call node (${requestedNode}) is not allowed. Switch scope with use_device instead.`,
    );
  }
  const workdir = readToolStringParam(params.params, "workdir");
  const timeoutSec =
    readPositiveIntegerParam(params.params, "timeout") ??
    readPositiveIntegerParam(params.params, "timeoutSec") ??
    DEVICE_EXEC_DEFAULT_TIMEOUT_SEC;
  const runTimeoutMs = timeoutSec * 1_000;
  const invokeWaitMs = runTimeoutMs + DEVICE_EXEC_TIMEOUT_GRACE_MS;
  const startedAt = Date.now();
  const runId = params.runId ?? randomUUID();
  const stream = params.onUpdate
    ? createDeviceExecStream({
        deviceId: params.deviceId,
        startedAt,
        ...(params.signal ? { signal: params.signal } : {}),
        onUpdate: params.onUpdate,
      })
    : undefined;
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: invokeWaitMs },
    {
      nodeId: params.deviceId,
      command: "system.run",
      timeoutMs: invokeWaitMs,
      // Envelope identity is what the node's occupancy admission checks.
      sessionKey: params.rootSessionKey,
      idempotencyKey: randomUUID(),
      params: {
        command: buildNodeShellCommand(command, params.platform),
        rawCommand: command,
        ...(workdir ? { cwd: workdir } : {}),
        timeoutMs: runTimeoutMs,
        sessionKey: params.rootSessionKey,
        agentId: params.agentId,
        runId,
        // Admission token; rides inside params so the invoke wire is unchanged.
        leaseToken: params.leaseToken,
        suppressNotifyOnExit: true,
        ...(stream ? { streamOutput: true } : {}),
      },
    },
    {
      ...(params.signal ? { signal: params.signal } : {}),
      ...(stream ? { nodeInvokeStream: stream } : {}),
    },
  );
  const payload = asNullableRecord(asNullableRecord(raw)?.payload) ?? {};
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const errorText = typeof payload.error === "string" ? payload.error : "";
  const success = payload.success === true;
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
  const timedOut = payload.timedOut === true;
  const outcomeNote = timedOut
    ? "Command timed out."
    : !success && exitCode !== null && exitCode !== 0
      ? `(Command exited with code ${exitCode})`
      : "";
  const aggregated = [stdout, stderr, errorText, outcomeNote].filter(Boolean).join("\n");
  const bounded = truncateUtf8Prefix(aggregated, DEVICE_EXEC_OUTPUT_MAX_BYTES);
  const truncated = bounded.length < aggregated.length;
  const text = [
    `Node: ${params.deviceId}`,
    timedOut && exitCode === null ? "Command timed out." : "",
    bounded,
    truncated
      ? `\n[output truncated at ${DEVICE_EXEC_OUTPUT_MAX_BYTES} bytes; rerun with a narrower command to see the rest]`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return textResult<DeviceExecDetails>(text, {
    status: success ? "completed" : "failed",
    nodeId: params.deviceId,
    deviceScope: params.deviceId,
    exitCode,
    durationMs: Date.now() - startedAt,
    ...(timedOut ? { timedOut: true } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(workdir ? { cwd: workdir } : {}),
    aggregated: bounded,
  });
}
