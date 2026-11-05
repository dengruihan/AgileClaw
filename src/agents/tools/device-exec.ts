/**
 * Device-routed exec adapter.
 *
 * Runs the `exec` tool's command on the session's scoped device over the
 * existing `system.run` node command. Every call carries the root session
 * identity in the invoke envelope and the occupancy lease token inside the
 * command params, which is exactly what M61 per-call admission checks. Exec is
 * foreground by contract: detached spawn is rejected here instead of silently
 * escaping the lease.
 */
import { randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { buildNodeShellCommand } from "../../infra/node-shell.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { textResult } from "./tool-results.js";

/** Node exec default program timer matches the Gateway exec tool default. */
const DEVICE_EXEC_DEFAULT_TIMEOUT_SEC = 1_800;
/** The Gateway must outlive the node program timer to report its structured timeout. */
const DEVICE_EXEC_TIMEOUT_GRACE_MS = 15_000;
/** Model-facing bound; a longer result is truncated instead of dropped. */
const DEVICE_EXEC_OUTPUT_MAX_BYTES = 32 * 1024;

export type DeviceExecDetails = {
  status: "completed" | "failed";
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
      },
    },
    params.signal ? { signal: params.signal } : undefined,
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
