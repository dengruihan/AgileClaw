/** Transport-independent CLI node-host runtime shared by Gateway and app workers. */
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { NodeExecutorProfile } from "../infra/node-commands.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { ensureTerminalUploadCleanup } from "../infra/terminal-file-upload.js";
import { logDebug } from "../logger.js";
import type { NodeHostClient } from "./client.js";
import { resolveNodeDesktopHostConfig } from "./desktop-stream-command.js";
import type { NodeOccupancyOwner } from "./node-occupancy.js";
import { resolveNodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import { NodeWorkerContainerContextMismatchError } from "./node-worker-container-lifecycle.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import {
  ensureNodeHostPluginRegistry,
  listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import {
  startActiveNodeHostRuntime,
  type ActiveNodeHostRuntime,
  type WorkerHostingHandoff,
} from "./runtime-active.js";
import {
  assertNodeHostManifestUsable,
  buildNodeHostManifest,
  createNodeHostInventory,
  resolveNodeCommandSurface,
  type NodeHostInventory,
  type NodeHostManifest,
} from "./runtime-manifest.js";
import { createNodeOccupancyRuntime } from "./runtime-occupancy.js";
import { resolveExecutableTrustPathFromEnv } from "./runtime-skill-bins.js";
import { scanNodeHostedSkills } from "./skills.js";
export type { NodeHostInventory } from "./runtime-manifest.js";

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type PreparedNodeHostRuntime = {
  manifest: NodeHostManifest;
  workerHostingEnabled: boolean;
  preparedWorkspacesEnabled: boolean;
  restrictedSurface?: true;
  workerHostingDisabledReason?: string;
  initialInventory: NodeHostInventory;
  /** Node-side occupancy lease authority; present on the executor profile. */
  occupancy: NodeOccupancyOwner | undefined;
  start(params: {
    client: NodeHostClient;
    onInventoryChanged?: (inventory: NodeHostInventory) => void;
    onManifestChanged?: (manifest: NodeHostManifest) => void;
    onRunnerCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
    onWorkerHostingDisabled?: (reason: string) => void;
  }): ActiveNodeHostRuntime;
};

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

export async function prepareNodeHostRuntime(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** The embedded app worker never advertises native agent runs. */
  enableAgentRuns?: boolean;
  /** The embedded app worker never advertises full worker session hosting. */
  enableWorkerRuns?: boolean;
  /** Process-scoped worker hosting for environment-managed disposable nodes. */
  forceWorkerRuns?: boolean;
  /** Disposable cloud nodes expose computer control only through the private carrier. */
  ephemeral?: boolean;
  /** Embedded workers may still host long-lived plugin commands over the app-owned socket. */
  enableDuplexPluginCommands?: boolean;
  installedAppsSharingEnabled?: boolean;
  desktopSharingEnabled?: boolean;
  commands?: readonly string[];
  platform?: NodeJS.Platform;
  /** Restricted executor profile: tool execution only, node-authoritative occupancy. */
  profile?: NodeExecutorProfile;
  /** Node-side occupancy admission without the full executor command set. */
  enableOccupancy?: boolean;
}): Promise<PreparedNodeHostRuntime> {
  const { executorProfile, commandAllowlist } = resolveNodeCommandSurface(params);
  if (!commandAllowlist) {
    void ensureTerminalUploadCleanup();
  }
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  await ensureNodeHostPluginRegistry({ config, env, commandAllowlist });
  const pathEnv = ensureNodePathEnv();
  env.PATH = pathEnv;
  const duplexEnabled =
    params?.enableAgentRuns === true || params?.enableDuplexPluginCommands === true;
  const platform = params?.platform ?? process.platform;
  const installedAppsSharingEnabled =
    platform === "darwin" && params?.installedAppsSharingEnabled === true;
  const desktopHostConfig = resolveNodeDesktopHostConfig({
    config: config.desktop?.host,
    desktopSharingEnabled: params?.desktopSharingEnabled,
    platform,
    ephemeral: params?.ephemeral,
  });
  // The executor profile is the default command set; a custom allowlist that
  // advertises occupancy commands opts into the same lease admission.
  const occupancyRuntime = createNodeOccupancyRuntime({
    profile: executorProfile,
    enabled: params?.enableOccupancy,
    commandAllowlist,
    env,
  });
  const availabilityContext = { config, env };
  const resolvePluginNodeHost = () =>
    listRegisteredNodeHostCapsAndCommands(availabilityContext, {
      includeDuplex: duplexEnabled,
      ...(commandAllowlist ? { commandAllowlist } : {}),
    });
  const pluginNodeHost = resolvePluginNodeHost();
  // Opt-in and binary resolution are node-local enforcement points. A Gateway
  // cannot advertise or enable this command on the host's behalf.
  const claudePath =
    params?.enableAgentRuns === true && config.nodeHost?.agentRuns?.claude?.enabled === true
      ? resolveExecutableTrustPathFromEnv("claude", pathEnv)
      : null;
  let workerRunsEnabled =
    !commandAllowlist &&
    params?.enableWorkerRuns === true &&
    (params.forceWorkerRuns === true || config.nodeHost?.workerRuns?.enabled === true);
  const workspaceOptions = { env, ephemeral: params?.ephemeral };
  let preparedWorkerWorkspace: NodeWorkerWorkspaceRuntime | undefined;
  let preparedContainerSupervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
  let preparedContainerCapacity: NodeWorkerCapacitySnapshot | undefined;
  let preparedContainerInitialized = false;
  const workerHosting: WorkerHostingHandoff = { cleanupIncomplete: false };
  let workerHostingDisabledReason: string | undefined;
  const disablePreparedWorkerHosting = async (error: unknown) => {
    let failure = error;
    workerHosting.cleanupIncomplete ||= error instanceof NodeWorkerContainerContextMismatchError;
    try {
      await preparedContainerSupervisor?.close();
    } catch (closeError) {
      workerHosting.cleanupIncomplete = true;
      if (closeError !== error) {
        failure = new Error(`${String(error)}; supervisor cleanup failed: ${String(closeError)}`);
      }
    }
    workerRunsEnabled = false;
    preparedWorkerWorkspace = undefined;
    preparedContainerSupervisor = undefined;
    preparedContainerCapacity = undefined;
    workerHostingDisabledReason = failure instanceof Error ? failure.message : String(failure);
  };
  if (workerRunsEnabled) {
    try {
      preparedWorkerWorkspace = new NodeWorkerWorkspaceRuntime(workspaceOptions);
      await preparedWorkerWorkspace.checkAdmission();
    } catch (error) {
      await disablePreparedWorkerHosting(error);
    }
  }
  if (workerRunsEnabled && config.nodeHost?.workerRuns?.isolation === "container") {
    try {
      if (platform === "win32") {
        throw new Error(
          'Container-isolated node workers are unsupported on Windows because native paths cannot be mounted at their container paths; run the node host on Linux or macOS, or set isolation to "none".',
        );
      }
      const containerEngine = await resolveNodeWorkerContainerEngine({ env });
      preparedContainerSupervisor = createNodeWorkerSupervisor({
        env,
        capacity: config.nodeHost?.workerRuns?.capacity,
        workspace: preparedWorkerWorkspace,
        containerEngine,
        ...(config.nodeHost?.workerRuns?.containerImage
          ? { containerImage: config.nodeHost.workerRuns.containerImage }
          : {}),
        onCapacityChanged: (capacity) => {
          preparedContainerCapacity = capacity;
          workerHosting.publishCapacity?.(capacity);
        },
      });
      try {
        // Container ownership and orphan cleanup must precede positive capacity publication.
        await preparedContainerSupervisor.initialize();
        preparedContainerInitialized = true;
      } catch (error) {
        if (error instanceof NodeWorkerContainerContextMismatchError) {
          await disablePreparedWorkerHosting(error);
        } else {
          logDebug(`node-host: worker capacity reconciliation failed: ${String(error)}`);
        }
      }
    } catch (error) {
      await disablePreparedWorkerHosting(error);
    }
  }
  const skills =
    commandAllowlist || config.nodeHost?.skills?.enabled === false ? null : scanNodeHostedSkills();
  const buildManifest = (pluginManifest: typeof pluginNodeHost) =>
    buildNodeHostManifest({
      pluginManifest,
      commandAllowlist,
      claudeEnabled: Boolean(claudePath),
      installedAppsSharingEnabled,
      desktopStreamingEnabled: desktopHostConfig.enabled,
      ephemeral: params?.ephemeral === true,
      pathEnv,
      occupancyEnabled: occupancyRuntime !== undefined,
    });
  const manifest = buildManifest(pluginNodeHost);
  assertNodeHostManifestUsable(manifest, commandAllowlist);
  const initialInventory = createNodeHostInventory(skills, pluginNodeHost.nodePluginTools);

  return {
    manifest,
    workerHostingEnabled: workerRunsEnabled,
    preparedWorkspacesEnabled: workerRunsEnabled && params?.ephemeral === true,
    ...(commandAllowlist ? { restrictedSurface: true as const } : {}),
    ...(workerHostingDisabledReason ? { workerHostingDisabledReason } : {}),
    initialInventory,
    occupancy: occupancyRuntime?.owner,
    start(startParams) {
      return startActiveNodeHostRuntime({
        ...startParams,
        env,
        config,
        commandAllowlist,
        skills,
        pathEnv,
        platform,
        duplexEnabled,
        installedAppsSharingEnabled,
        desktopHostConfig,
        claudePath,
        ephemeral: params?.ephemeral === true,
        occupancyRuntime,
        workerRunsEnabled,
        preparedWorkerWorkspace,
        preparedContainerSupervisor,
        preparedContainerCapacity,
        preparedContainerInitialized,
        workerHosting,
        pluginNodeHost,
        manifest,
        availabilityContext,
        resolvePluginNodeHost,
        buildManifest,
      });
    },
  };
}
