/** Connection-scoped node-host runtime: availability, worker supervisor, and invoke lifecycle. */
import type { OpenClawConfig } from "../config/config.js";
import type { DesktopHostConfig } from "../config/types.desktop.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { logDebug } from "../logger.js";
import type {
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandContext,
} from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";
import { startNodeHostMcpManager } from "./mcp.js";
import { buildNodeEventParams } from "./node-event-params.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { NodeWorkerContainerContextMismatchError } from "./node-worker-container-lifecycle.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import {
  hasRegisteredNodeHostCommandActiveWork,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
  type listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import {
  handleNodeHostInvokeInput,
  invokeNodeHostCommand,
  type ActiveNodeInvoke,
  type NodeHostGatewayConnection,
  type NodeHostInvokeState,
} from "./runtime-invoke.js";
import {
  createNodeHostInventory,
  sameNodeHostManifest,
  type NodeHostInventory,
  type NodeHostManifest,
} from "./runtime-manifest.js";
import type { NodeOccupancyRuntime } from "./runtime-occupancy.js";
import { SkillBinsCache } from "./runtime-skill-bins.js";
import { createNodeHostUpdatePause } from "./runtime-update-pause.js";

const WORKER_INITIALIZATION_RETRY_MS = 5_000;

type PluginNodeHostManifest = ReturnType<typeof listRegisteredNodeHostCapsAndCommands>;

export type ActiveNodeHostRuntime = {
  invoke(frame: NodeInvokeRequestPayload): Promise<void>;
  handleInput(invokeId: string, seq: number, payloadJSON: string): void;
  cancel(invokeId: string): void;
  cancelAll(): Promise<void>;
  tryPauseForUpdate(): Promise<boolean>;
  resumeAfterUpdate(): void;
  updateGatewayConnection(connection?: NodeHostGatewayConnection): void;
  close(): Promise<void>;
};

/** Mutable worker-hosting facts the prepared and active phases both observe. */
export type WorkerHostingHandoff = {
  cleanupIncomplete: boolean;
  publishCapacity?: (capacity: NodeWorkerCapacitySnapshot) => void;
};

export type ActiveNodeHostStartInput = {
  client: NodeHostClient;
  onInventoryChanged?: (inventory: NodeHostInventory) => void;
  onManifestChanged?: (manifest: NodeHostManifest) => void;
  onRunnerCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  onWorkerHostingDisabled?: (reason: string) => void;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  commandAllowlist: ReadonlySet<string> | undefined;
  skills: unknown[] | null;
  pathEnv: string;
  platform: NodeJS.Platform;
  duplexEnabled: boolean;
  installedAppsSharingEnabled: boolean;
  desktopHostConfig: DesktopHostConfig;
  claudePath: string | null;
  ephemeral: boolean;
  occupancyRuntime: NodeOccupancyRuntime | undefined;
  workerRunsEnabled: boolean;
  preparedWorkerWorkspace: NodeWorkerWorkspaceRuntime | undefined;
  preparedContainerSupervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
  preparedContainerCapacity: NodeWorkerCapacitySnapshot | undefined;
  preparedContainerInitialized: boolean;
  workerHosting: WorkerHostingHandoff;
  pluginNodeHost: PluginNodeHostManifest;
  manifest: NodeHostManifest;
  availabilityContext: OpenClawPluginNodeHostCommandAvailabilityContext;
  resolvePluginNodeHost: () => PluginNodeHostManifest;
  buildManifest: (pluginManifest: PluginNodeHostManifest) => NodeHostManifest;
};

async function settleNodeHostCleanup(owners: Array<Promise<unknown> | undefined>): Promise<void> {
  const results = await Promise.allSettled(owners.filter((owner) => owner !== undefined));
  const errors = [
    ...new Set(results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))),
  ];
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "node-host runtime cleanup failed");
  }
}

export function startActiveNodeHostRuntime(input: ActiveNodeHostStartInput): ActiveNodeHostRuntime {
  const {
    client,
    onInventoryChanged,
    onManifestChanged,
    onRunnerCapacityChanged,
    onWorkerHostingDisabled,
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
    ephemeral,
    occupancyRuntime,
    workerRunsEnabled,
    preparedWorkerWorkspace,
    preparedContainerSupervisor,
    preparedContainerCapacity,
    preparedContainerInitialized,
    workerHosting,
    availabilityContext,
    resolvePluginNodeHost,
    buildManifest,
  } = input;
  const mcpAbort = new AbortController();
  let closePromise: Promise<void> | undefined;
  let supervisorClose: Promise<void> | undefined;
  let mcpClose: Promise<void> | undefined;
  let initializationRetry: ReturnType<typeof setTimeout> | undefined;
  let pendingDisconnectCleanups = 0;
  let disconnectCleanupFailed = false;
  let currentPluginNodeHost = input.pluginNodeHost;
  let mcpStartupComplete = Boolean(commandAllowlist);
  const workerWorkspace = preparedWorkerWorkspace;
  const workerBundleInstaller = workerRunsEnabled
    ? new NodeWorkerBundleInstaller({ env })
    : undefined;
  const workerSupervisor =
    preparedContainerSupervisor ??
    (workerRunsEnabled
      ? createNodeWorkerSupervisor({
          env,
          capacity: config.nodeHost?.workerRuns?.capacity,
          onCapacityChanged: onRunnerCapacityChanged,
          workspace: workerWorkspace,
        })
      : undefined);
  const pluginCommandContext: OpenClawPluginNodeHostCommandContext = {
    sendNodeEvent: async (event, payload) =>
      await client.request("node.event", buildNodeEventParams(event, payload)),
    ...(workerWorkspace
      ? {
          acquireManagedWorkspaceAsync: (request) =>
            workerWorkspace.acquireManagedWorkspaceAsync(request),
          acquireManagedWorkspace: (request) => workerWorkspace.acquireManagedWorkspace(request),
        }
      : {}),
  };
  const state: NodeHostInvokeState = {
    client,
    commandAllowlist,
    duplexEnabled,
    claudePath,
    occupancyRuntime,
    desktopHostConfig,
    installedAppsSharingEnabled,
    platform,
    ephemeral,
    activeInvokes: new Map<string, ActiveNodeInvoke>(),
    inFlightInvokes: 0,
    connectionGeneration: 0,
    disconnectCleanup: Promise.resolve(),
    closing: false,
    currentManifest: input.manifest,
    skillBins: new SkillBinsCache(client, pathEnv),
    manager: undefined,
    gatewayConnection: undefined,
    pluginCommandContext,
    workerBundleInstaller,
    workerSupervisor,
    workerWorkspace,
    resolvePluginNodeHost,
  };
  if (preparedContainerSupervisor) {
    workerHosting.publishCapacity = onRunnerCapacityChanged;
    if (preparedContainerCapacity) {
      onRunnerCapacityChanged?.(preparedContainerCapacity);
    }
  }
  const initializeWorkerSupervisor = () => {
    const supervisor = state.workerSupervisor;
    if (!supervisor || state.closing) {
      return;
    }
    void supervisor.initialize().catch(async (error: unknown) => {
      logDebug(`node-host: worker capacity reconciliation failed: ${String(error)}`);
      if (state.closing || state.workerSupervisor !== supervisor) {
        return;
      }
      if (error instanceof NodeWorkerContainerContextMismatchError) {
        // Closing this supervisor cannot retire claims on a different daemon.
        workerHosting.cleanupIncomplete = true;
        state.workerSupervisor = undefined;
        onWorkerHostingDisabled?.(error.message);
        await supervisor.close().catch((closeError: unknown) => {
          logDebug(`node-host: worker supervisor cleanup failed: ${String(closeError)}`);
        });
        return;
      }
      initializationRetry = setTimeout(() => {
        initializationRetry = undefined;
        initializeWorkerSupervisor();
      }, WORKER_INITIALIZATION_RETRY_MS);
      initializationRetry.unref?.();
    });
  };
  if (state.workerSupervisor && !preparedContainerInitialized) {
    initializeWorkerSupervisor();
  }
  occupancyRuntime?.attachClient(client);
  const publishInventory = () =>
    onInventoryChanged?.(
      createNodeHostInventory(
        skills,
        currentPluginNodeHost.nodePluginTools,
        state.manager?.descriptors,
      ),
    );
  const startup = commandAllowlist
    ? Promise.resolve(undefined)
    : startNodeHostMcpManager(config.nodeHost?.mcp?.servers, {
        signal: mcpAbort.signal,
        onDescriptorsChanged: () => {
          if (!state.closing && state.manager) {
            publishInventory();
          }
        },
      }).then((resolved) => {
        state.manager = resolved;
        mcpStartupComplete = true;
        if (!state.closing) {
          publishInventory();
        }
        return resolved;
      });
  const refreshAvailability = () => {
    if (state.closing) {
      return;
    }
    const nextPluginNodeHost = resolvePluginNodeHost();
    const nextManifest = buildManifest(nextPluginNodeHost);
    currentPluginNodeHost = nextPluginNodeHost;
    if (!sameNodeHostManifest(state.currentManifest, nextManifest)) {
      state.currentManifest = nextManifest;
      onManifestChanged?.(nextManifest);
    }
    publishInventory();
  };
  const stopAvailabilityWatch = onManifestChanged
    ? watchRegisteredNodeHostCommandAvailability(
        availabilityContext,
        refreshAvailability,
        commandAllowlist,
      )
    : async () => {};
  // The watcher cannot replay a socket change between preparation and
  // registration. Resolve once after attachment to close that race.
  if (onManifestChanged) {
    refreshAvailability();
  }
  const updatePause = createNodeHostUpdatePause({
    hasLocalActiveWork: () =>
      state.closing ||
      !mcpStartupComplete ||
      state.inFlightInvokes > 0 ||
      pendingDisconnectCleanups > 0 ||
      disconnectCleanupFailed ||
      hasRegisteredNodeHostCommandActiveWork() ||
      workerHosting.cleanupIncomplete ||
      (occupancyRuntime?.hasActiveWork() ?? false),
    hasWorkerActiveWork: async () => {
      if (await state.workerSupervisor?.hasActiveWork()) {
        return true;
      }
      await state.workerSupervisor?.retireIdle();
      return false;
    },
  });
  const runtime: ActiveNodeHostRuntime = {
    invoke(frame) {
      return invokeNodeHostCommand(state, updatePause, frame);
    },
    handleInput(invokeId, seq, payloadJSON) {
      handleNodeHostInvokeInput(state, invokeId, seq, payloadJSON);
    },
    cancel(invokeId) {
      state.activeInvokes.get(invokeId)?.controller.abort();
    },
    cancelAll() {
      state.connectionGeneration += 1;
      // Retired refreshes may still finish; their cache must never serve the next connection.
      state.skillBins = new SkillBinsCache(client, pathEnv);
      // Close can reenter from an abort listener and must see this cleanup barrier.
      pendingDisconnectCleanups += 1;
      const idleCleanup = state.workerSupervisor?.retireIdle();
      // Disconnect kills holder-owned processes and clears occupancy unless
      // detached lease processes still keep it alive.
      const occupancyCleanup = occupancyRuntime?.handleDisconnect();
      const cleanup = settleNodeHostCleanup([
        state.disconnectCleanup.catch(() => {}).then(notifyRegisteredNodeHostCommandDisconnect),
        idleCleanup,
        occupancyCleanup,
      ]).finally(() => {
        pendingDisconnectCleanups -= 1;
      });
      state.disconnectCleanup = cleanup;
      // Logging observes the failure; invocation and shutdown retain the rejected result.
      void cleanup.then(
        () => {
          if (state.disconnectCleanup === cleanup) {
            disconnectCleanupFailed = false;
          }
        },
        (error: unknown) => {
          if (state.disconnectCleanup === cleanup) {
            disconnectCleanupFailed = true;
          }
          logDebug(`node-host: disconnect cleanup failed: ${String(error)}`);
        },
      );
      for (const active of state.activeInvokes.values()) {
        active.controller.abort();
      }
      state.activeInvokes.clear();
      return cleanup;
    },
    tryPauseForUpdate: updatePause.tryPauseForUpdate,
    resumeAfterUpdate: updatePause.resumeAfterUpdate,
    updateGatewayConnection(connection) {
      state.gatewayConnection = connection;
    },
    close() {
      if (closePromise) {
        return closePromise;
      }
      const wasClosing = state.closing;
      state.closing = true;
      // Install the shared completion before abort listeners or cleanup can reenter close.
      const completion = createDeferredCore();
      closePromise = completion.promise;
      const closeOwners = async () => {
        if (!wasClosing && initializationRetry) {
          clearTimeout(initializationRetry);
          initializationRetry = undefined;
        }
        if (!wasClosing || disconnectCleanupFailed) {
          // cancelAll publishes the cleanup barrier joined below.
          void runtime.cancelAll();
        }
        const watcherClose = stopAvailabilityWatch();
        // Startup observes this signal before either independent owner is joined.
        mcpAbort.abort();
        const disconnectClose = state.disconnectCleanup;
        supervisorClose ??= Promise.resolve()
          .then(() => state.workerSupervisor?.close())
          .catch((error: unknown) => {
            // The supervisor retains failed retirement records and an open journal for retry.
            supervisorClose = undefined;
            throw error;
          });
        // MCP close is terminal: another call after failure can return an empty success.
        mcpClose ??= startup.then((resolved) => resolved?.close());
        await settleNodeHostCleanup([watcherClose, disconnectClose, supervisorClose, mcpClose]);
      };
      void closeOwners().then(completion.resolve, (error: unknown) => {
        closePromise = undefined;
        completion.reject(error);
      });
      return completion.promise;
    },
  };
  return runtime;
}
