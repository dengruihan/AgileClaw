/** The node-local command surface owns both advertised commands and their capabilities. */
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import { NODE_CLAUDE_SKILLS_CAPABILITY } from "../infra/node-claude-skill-protocol.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_EXECUTOR_PROFILE,
  NODE_EXECUTOR_PROFILE_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_OCCUPANCY_CAP,
  NODE_OCCUPANCY_COMMANDS,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_TERMINAL_UPLOAD_COMMAND,
  type NodeExecutorProfile,
} from "../infra/node-commands.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { listRegisteredNodeHostCapsAndCommands } from "./plugin-node-host.js";

export const preferMacAppExecHost =
  process.platform === "darwin" &&
  process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app";

export type NodeHostManifest = {
  caps: string[];
  commands: string[];
  computerUse?: ComputerUseCapabilityDescriptor;
  pathEnv?: string;
};

export function buildNodeHostManifest(params: {
  pluginManifest: ReturnType<typeof listRegisteredNodeHostCapsAndCommands>;
  commandAllowlist?: ReadonlySet<string>;
  claudeEnabled: boolean;
  installedAppsSharingEnabled: boolean;
  desktopStreamingEnabled: boolean;
  ephemeral: boolean;
  pathEnv: string;
  occupancyEnabled?: boolean;
}): NodeHostManifest {
  const { pluginManifest, commandAllowlist } = params;
  const builtins: Array<[string, readonly string[]]> = [
    [SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY, preferMacAppExecHost ? [] : ["system.run"]],
    [
      "system",
      [
        ...NODE_SYSTEM_RUN_COMMANDS,
        ...NODE_EXEC_APPROVALS_COMMANDS,
        NODE_FS_LIST_DIR_COMMAND,
        NODE_TERMINAL_UPLOAD_COMMAND,
      ],
    ],
    ["mcp", [NODE_MCP_TOOLS_CALL_COMMAND]],
    ["device", params.installedAppsSharingEnabled ? [NODE_DEVICE_APPS_COMMAND] : []],
    [
      NODE_CLAUDE_SKILLS_CAPABILITY,
      params.claudeEnabled ? [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND] : [],
    ],
    ["screen", params.desktopStreamingEnabled ? [NODE_DESKTOP_STREAM_COMMAND] : []],
    [NODE_OCCUPANCY_CAP, params.occupancyEnabled ? NODE_OCCUPANCY_COMMANDS : []],
  ];
  const commands = [
    ...new Set([
      ...builtins.flatMap(([, ids]) => ids),
      ...pluginManifest.commands.filter(
        (command) =>
          !params.ephemeral || (command !== "screen.snapshot" && command !== "computer.act"),
      ),
    ]),
  ]
    .filter((command) => !commandAllowlist || commandAllowlist.has(command))
    .toSorted();
  // Plugin capabilities are already filtered at their registry owner, where the
  // command-to-capability relation is authoritative.
  const caps = [
    ...new Set([
      ...builtins
        .filter(([cap, ids]) =>
          commandAllowlist
            ? ids.some((id) => commands.includes(id))
            : cap !== "screen" && ids.length > 0,
        )
        .map(([cap]) => cap),
      ...pluginManifest.caps.filter(
        (cap) => !params.ephemeral || (cap !== "computer" && cap !== "screen"),
      ),
    ]),
  ].toSorted();
  return {
    caps,
    commands,
    ...(!commandAllowlist && !params.ephemeral && pluginManifest.computerUse
      ? { computerUse: pluginManifest.computerUse }
      : {}),
    ...(!commandAllowlist ? { pathEnv: params.pathEnv } : {}),
  };
}

export type NodeHostInventory = {
  skills: unknown[] | null;
  pluginTools: NodePluginToolDescriptor[];
};

/**
 * Resolve the requested command surface: the executor profile supplies the
 * default command set, and an explicit list always wins.
 */
export function resolveNodeCommandSurface(params?: {
  profile?: NodeExecutorProfile;
  commands?: readonly string[];
}): { executorProfile: boolean; commandAllowlist: Set<string> | undefined } {
  const executorProfile = params?.profile === NODE_EXECUTOR_PROFILE;
  const commandSource =
    executorProfile && params?.commands === undefined
      ? NODE_EXECUTOR_PROFILE_COMMANDS
      : params?.commands;
  return {
    executorProfile,
    commandAllowlist: commandSource === undefined ? undefined : new Set(commandSource),
  };
}

/** A restricted surface that retained no command would advertise an empty node. */
export function assertNodeHostManifestUsable(
  manifest: NodeHostManifest,
  commandAllowlist: ReadonlySet<string> | undefined,
): void {
  if (!commandAllowlist || manifest.commands.length > 0) {
    return;
  }
  const requested = [...commandAllowlist].toSorted().join(", ") || "(empty allowlist)";
  throw new Error(
    `Node command allowlist retained no available commands. Unknown or unavailable ids: ${requested}. Check --commands and enable the plugin that provides each command.`,
  );
}

export function createNodeHostInventory(
  skills: unknown[] | null,
  pluginTools: readonly NodePluginToolDescriptor[],
  mcpDescriptors: readonly NodePluginToolDescriptor[] = [],
): NodeHostInventory {
  const sortedPluginTools = [...pluginTools, ...mcpDescriptors].toSorted((left, right) => {
    return left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name);
  });
  return { skills, pluginTools: sortedPluginTools };
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameNodeHostManifest(left: NodeHostManifest, right: NodeHostManifest): boolean {
  return (
    left.pathEnv === right.pathEnv &&
    sameStringList(left.caps, right.caps) &&
    sameStringList(left.commands, right.commands) &&
    JSON.stringify(left.computerUse) === JSON.stringify(right.computerUse)
  );
}
