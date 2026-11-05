// Node tool command names shared by routing, auth, and approval surfaces.
export const NODE_SYSTEM_RUN_COMMAND = "system.run";
export const NODE_SYSTEM_RUN_COMMANDS = [
  "system.run.prepare",
  NODE_SYSTEM_RUN_COMMAND,
  "system.which",
] as const;

export const NODE_SYSTEM_NOTIFY_COMMAND = "system.notify";
export const NODE_FS_LIST_DIR_COMMAND = "fs.listDir";
export const NODE_TERMINAL_UPLOAD_COMMAND = "terminal.upload";
export const NODE_FILE_COMMANDS = [NODE_FS_LIST_DIR_COMMAND, NODE_TERMINAL_UPLOAD_COMMAND];
const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";
const NODE_BROWSER_PROXY_UPLOAD_COMMAND = "browser.proxy.upload.v1";
export const NODE_BROWSER_PROXY_COMMANDS = [
  NODE_BROWSER_PROXY_COMMAND,
  NODE_BROWSER_PROXY_UPLOAD_COMMAND,
] as const;
export const NODE_MCP_TOOLS_CALL_COMMAND = "mcp.tools.call.v1";
export const NODE_AGENT_CLI_CLAUDE_RUN_COMMAND = "agent.cli.claude.run.v1";
export const NODE_DEVICE_APPS_COMMAND = "device.apps";

// Node occupancy owns the single-device executor lease. The node is the sole
// authority; the Gateway relays results and surfaces rejection text.
export const NODE_OCCUPANCY_ACQUIRE_COMMAND = "occupancy.acquire.v1";
export const NODE_OCCUPANCY_RENEW_COMMAND = "occupancy.renew.v1";
export const NODE_OCCUPANCY_RELEASE_COMMAND = "occupancy.release.v1";
export const NODE_OCCUPANCY_STATUS_COMMAND = "occupancy.status.v1";
export const NODE_OCCUPANCY_REVOKE_COMMAND = "occupancy.revoke.v1";
export const NODE_OCCUPANCY_COMMANDS = [
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_RENEW_COMMAND,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  NODE_OCCUPANCY_STATUS_COMMAND,
  NODE_OCCUPANCY_REVOKE_COMMAND,
] as const;
export const NODE_DEVICE_OCCUPIED_ERROR_CODE = "DEVICE_OCCUPIED";
export const NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE = "LEASE_TOKEN_MISMATCH";
export const NODE_DEVICE_UNOCCUPIED_ERROR_CODE = "DEVICE_UNOCCUPIED";
export const NODE_OCCUPANCY_STATUS_EVENT = "node.occupancy.status";
export const NODE_OCCUPANCY_CAP = "occupancy";
export const NODE_EXECUTOR_PROFILE = "executor" as const;
export type NodeExecutorProfile = typeof NODE_EXECUTOR_PROFILE;

export function isNodeOccupancyCommand(command: unknown): boolean {
  return (
    typeof command === "string" && (NODE_OCCUPANCY_COMMANDS as readonly string[]).includes(command)
  );
}

export const NODE_WORKER_BUNDLE_INSTALL_COMMAND = "worker.bundle.install.v1";
export const NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND = "worker.launch.v1";
export const NODE_WORKER_SUPERVISOR_STATUS_COMMAND = "worker.status.v1";
export const NODE_WORKER_SUPERVISOR_CANCEL_COMMAND = "worker.cancel.v1";
export const NODE_WORKER_PROCESSES_COMMAND = "worker.processes.v1";
export const NODE_WORKER_ENVIRONMENT_STOP_COMMAND = "worker.environment.stop.v1";
export const NODE_WORKER_WORKSPACE_EXEC_COMMAND = "worker.workspace.exec.v1";
export const NODE_WORKER_WORKSPACE_PREPARE_COMMAND = "worker.workspace.prepare.v1";
export const NODE_WORKER_WORKSPACE_RETAIN_COMMAND = "worker.workspace.retain.v1";
export const NODE_WORKER_DESKTOP_STREAM_COMMAND = "worker.desktop.stream.v1";
export const NODE_WORKER_DESKTOP_LAUNCH_COMMAND = "worker.desktop.launch.v1";
export const NODE_WORKER_DESKTOP_COMPUTER_COMMAND = "worker.desktop.computer.v1";
export const NODE_WORKER_PORTAL_STREAM_COMMAND = "worker.portal.stream.v1";
export const NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE = "WORKER_CAPACITY_EXHAUSTED";
export const NODE_WORKER_PRIVATE_COMMANDS = [
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_PROCESSES_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
  NODE_WORKER_PORTAL_STREAM_COMMAND,
] as const;

const PRIVATE_NODE_INVOKE_COMMAND_SET = new Set<string>(NODE_WORKER_PRIVATE_COMMANDS);

// Interactive control surfaces mutate one shared device resource (a browser or
// desktop), so occupancy serializes them even while exec/file work stays parallel.
export const NODE_OCCUPANCY_CONTROL_COMMANDS = [
  ...NODE_BROWSER_PROXY_COMMANDS,
  "screen.snapshot",
  "computer.act",
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
  NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
] as const;

export function isNodeOccupancyControlCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (NODE_OCCUPANCY_CONTROL_COMMANDS as readonly string[]).includes(command)
  );
}

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",
  "system.execApprovals.set",
] as const;

/**
 * Commands that never require the lease: the occupancy lifecycle itself and the
 * operator approval policy. Approval reads and writes are device governance the
 * Gateway's approvals UI and CLI must reach while a session holds the device.
 */
export const NODE_OCCUPANCY_ADMISSION_EXEMPT_COMMANDS = [
  ...NODE_OCCUPANCY_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
] as const;

export function isNodeOccupancyAdmissionExemptCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (NODE_OCCUPANCY_ADMISSION_EXEMPT_COMMANDS as readonly string[]).includes(command)
  );
}

/**
 * Lease mutations change who controls the device, so the Gateway requires admin
 * scope for them on the direct `node.invoke` RPC. `occupancy.status.v1` stays
 * available to sessions: it reports the holder identity only to its holder.
 */
export const NODE_OCCUPANCY_MUTATING_COMMANDS = [
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_RENEW_COMMAND,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  NODE_OCCUPANCY_REVOKE_COMMAND,
] as const;

// The restricted executor profile: tool execution only. No worker session
// hosting and no bundle installation. Exec approvals stay listed because exec
// runs under the node's existing approval policy. Plugin-provided entries stay
// in the list even when their plugin is unavailable; the manifest drops
// unavailable commands.
export const NODE_EXECUTOR_PROFILE_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_TERMINAL_UPLOAD_COMMAND,
  "file.stat",
  "file.fetch",
  "file.create",
  "file.write",
  "dir.list",
  "dir.fetch",
  ...NODE_BROWSER_PROXY_COMMANDS,
  "screen.snapshot",
  "computer.act",
  ...NODE_OCCUPANCY_COMMANDS,
] as const;

/** Private node controls are never part of advertised or operator-invocable command surfaces. */
export function isPrivateNodeInvokeCommand(command: unknown): boolean {
  return typeof command === "string" && PRIVATE_NODE_INVOKE_COMMAND_SET.has(command.trim());
}

export function filterPublicNodeCommands(commands: readonly string[]): string[] {
  return commands.filter((command) => !isPrivateNodeInvokeCommand(command));
}

// Node duplex heartbeats must arrive before the Gateway relay declares the
// invoke idle, so both processes share this timeout contract.
export const NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS = 30_000;

// Direct node.invoke and pairing approval share this admin-only subset.
const NODE_ADMIN_ONLY_INVOKE_COMMANDS = [
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_TERMINAL_UPLOAD_COMMAND,
  // Lease mutations cross session ownership: a model-facing generic invoke must
  // never acquire, renew, release, or revoke another session's device.
  ...NODE_OCCUPANCY_MUTATING_COMMANDS,
] as const;

const NODE_ADMIN_ONLY_INVOKE_COMMAND_SET = new Set<string>(NODE_ADMIN_ONLY_INVOKE_COMMANDS);

/** Returns true when direct node invocation crosses an admin-only host boundary. */
export function isAdminOnlyNodeInvokeCommand(command: unknown): boolean {
  return typeof command === "string" && NODE_ADMIN_ONLY_INVOKE_COMMAND_SET.has(command);
}

/** Returns true for every versioned Browser node proxy command. */
export function isBrowserProxyNodeInvokeCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (NODE_BROWSER_PROXY_COMMANDS as readonly string[]).includes(command)
  );
}

export const NODE_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
export const NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS = NODE_MCP_TOOL_CALL_TIMEOUT_MS + 5_000;

export const NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS = 30_000;
// Leave the Gateway time to return the node's structured timeout and dispatch status.
export const NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS = NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS + 5_000;
