/**
 * Device scope vocabulary shared by the use_device tool and the placement-tool
 * routing layer.
 *
 * Scope decides where *placement* tools (exec, files, browser/computer control)
 * run. Gateway-kind tools always run on the Gateway and never consult this
 * module. The routing layer resolves the scope from the session entry at call
 * time, so a switch applies to the next call instead of rebuilding the tool
 * catalog.
 */

/** Placement families the routing layer can distinguish. */
export type DevicePlacementToolKind = "exec" | "file" | "control";

const EXEC_PLACEMENT_TOOLS = new Set(["exec", "process"]);
const FILE_PLACEMENT_TOOLS = new Set(["read", "write", "edit", "apply_patch", "ls"]);
const CONTROL_PLACEMENT_TOOLS = new Set(["browser", "computer", "screen", "mobile_ui", "canvas"]);

/** Classify one catalog tool name; unknown placement tools route nowhere. */
export function resolveDevicePlacementToolKind(
  toolName: string,
): DevicePlacementToolKind | undefined {
  const name = toolName.trim();
  if (EXEC_PLACEMENT_TOOLS.has(name)) {
    return "exec";
  }
  if (FILE_PLACEMENT_TOOLS.has(name)) {
    return "file";
  }
  if (CONTROL_PLACEMENT_TOOLS.has(name)) {
    return "control";
  }
  return undefined;
}

/** Reserved `use_device` targets that return the session to Gateway execution. */
const GATEWAY_SCOPE_TOKENS = new Set(["gateway", "host", "local", "reset", "none", "off"]);

export type UseDeviceTarget = { kind: "gateway" } | { kind: "device"; deviceId: string };

/** Parse the model-facing target; unknown tokens are device ids, never a fallback. */
export function parseUseDeviceTarget(raw: string): UseDeviceTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("use_device requires a device id, name, or 'gateway'");
  }
  return GATEWAY_SCOPE_TOKENS.has(trimmed.toLowerCase())
    ? { kind: "gateway" }
    : { kind: "device", deviceId: trimmed };
}

/** True when the placement call may proceed: a switch in this step owns the turn. */
export function deviceScopeSwitchPendingMessage(): string {
  return "use_device is switching this session's device scope. It must be the only placement-affecting call in its step; retry this placement tool in the next step.";
}

/** A switch applies to later calls; the tool result repeats the boundary rule. */
export function deviceScopeSwitchGuidance(): string {
  return "Scope changes apply to subsequent tool calls at the next step boundary. Do not combine use_device with other placement-affecting calls in the same step.";
}

export function unsupportedDeviceToolMessage(toolName: string, deviceId: string): string {
  const kind = resolveDevicePlacementToolKind(toolName);
  if (toolName === "process") {
    return "device-scoped exec is foreground, so the process tool has no background work to control on the device. Switch back with use_device device='gateway' to manage Gateway background processes.";
  }
  if (kind === "control") {
    return `tool ${toolName} has no device-routed transport yet; interactive browser/desktop control runs through its plugin transport on the Gateway. Switch back with use_device device='gateway' to use it.`;
  }
  if (kind === "file") {
    return `tool ${toolName} has no device-routed file adapter; device file tools support read, write, and ls. Switch back with use_device device='gateway' to use it on the Gateway.`;
  }
  return `tool ${toolName} has no device-routed adapter for device ${deviceId}; it runs only on the Gateway. Switch back with use_device device='gateway' to use it.`;
}
