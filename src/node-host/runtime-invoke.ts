/** One node-host invoke's execution pipeline: admission, input framing, progress, and dispatch. */
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { DesktopHostConfig } from "../config/types.desktop.js";
import { NODE_CLAUDE_SKILLS_MESSAGE_BYTES } from "../infra/node-claude-skill-protocol.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
  NODE_SYSTEM_RUN_COMMAND,
} from "../infra/node-commands.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { logDebug } from "../logger.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { BoundedBuffer } from "../shared/bounded-buffer.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { createNodeInvokeResponder, type NodeHostClient } from "./client.js";
import { requestsClaudeNodeSkillRuntime } from "./invoke-agent-cli-claude-params.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "./invoke.js";
import type { NodeHostMcpManager } from "./mcp.js";
import {
  dispatchNodeInvokeInput,
  registerNodeInvokeInputHandler,
  type NodeInvokeInputTarget,
} from "./node-invoke-input.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import {
  isRegisteredNodeHostCommandDuplex,
  type listRegisteredNodeHostCapsAndCommands,
} from "./plugin-node-host.js";
import type { NodeHostManifest } from "./runtime-manifest.js";
import type { NodeOccupancyGrant, NodeOccupancyRuntime } from "./runtime-occupancy.js";
import { SkillBinsCache } from "./runtime-skill-bins.js";
import type { createNodeHostUpdatePause } from "./runtime-update-pause.js";

const MAX_PENDING_INVOKE_INPUT_BYTES = 64 * 1024;

export type ActiveNodeInvoke = {
  controller: AbortController;
  framedFailure?: Error;
  input?: NodeInvokeInputTarget;
};

export type NodeHostGatewayConnection = {
  url: string;
  tlsFingerprint?: string;
  cloudflareAccess?: CloudflareAccessCredentials;
};

/**
 * Live connection-scoped state the invoke pipeline reads and mutates. The active
 * runtime owns this record: admission counters and the active-invoke map stay
 * here so disconnect cleanup and update pausing observe one authority.
 */
export type NodeHostInvokeState = {
  client: NodeHostClient;
  commandAllowlist: ReadonlySet<string> | undefined;
  duplexEnabled: boolean;
  claudePath: string | null;
  occupancyRuntime: NodeOccupancyRuntime | undefined;
  desktopHostConfig: DesktopHostConfig;
  installedAppsSharingEnabled: boolean;
  platform: NodeJS.Platform;
  ephemeral: boolean;
  activeInvokes: Map<string, ActiveNodeInvoke>;
  inFlightInvokes: number;
  connectionGeneration: number;
  disconnectCleanup: Promise<void>;
  closing: boolean;
  currentManifest: NodeHostManifest;
  skillBins: SkillBinsCache;
  manager: NodeHostMcpManager | undefined;
  gatewayConnection: NodeHostGatewayConnection | undefined;
  pluginCommandContext: OpenClawPluginNodeHostCommandContext;
  workerBundleInstaller: NodeWorkerBundleInstaller | undefined;
  workerSupervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
  workerWorkspace: NodeWorkerWorkspaceRuntime | undefined;
  resolvePluginNodeHost: () => ReturnType<typeof listRegisteredNodeHostCapsAndCommands>;
};

export async function invokeNodeHostCommand(
  state: NodeHostInvokeState,
  updatePause: ReturnType<typeof createNodeHostUpdatePause>,
  frame: NodeInvokeRequestPayload,
): Promise<void> {
  if (updatePause.isPaused) {
    await createNodeInvokeResponder(state.client, frame).error(
      "UNAVAILABLE",
      "node host is updating; retry shortly",
    );
    return;
  }
  // Admission precedes the first await; disconnects and duplicate IDs do
  // not release update ownership before the original command settles.
  state.inFlightInvokes += 1;
  try {
    const generation = state.connectionGeneration;
    try {
      await state.disconnectCleanup;
    } catch {
      if (!state.closing && generation === state.connectionGeneration) {
        await createNodeInvokeResponder(state.client, frame).error(
          "UNAVAILABLE",
          "Node disconnect cleanup failed. Reconnect the node to retry cleanup.",
        );
      }
      return;
    }
    if (state.closing || generation !== state.connectionGeneration) {
      return;
    }
    // Enforce the declaration locally too: a paired Gateway cannot widen
    // an operator-restricted surface by sending a hidden command directly.
    if (state.commandAllowlist && !state.currentManifest.commands.includes(frame.command)) {
      await createNodeInvokeResponder(state.client, frame).error(
        "UNAVAILABLE",
        "command not advertised by this node",
      );
      return;
    }
    let leaseAdmission: NodeOccupancyGrant | undefined;
    if (state.occupancyRuntime) {
      // Lifecycle commands answer here; every other command passes
      // admission except the operator approval policy, which governs
      // the device rather than a turn.
      const outcome = await state.occupancyRuntime.beginInvoke(
        frame,
        createNodeInvokeResponder(state.client, frame),
      );
      if (outcome.handoff === "answered") {
        return;
      }
      leaseAdmission = outcome.admission;
    }
    const claudeSkills =
      frame.command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND &&
      requestsClaudeNodeSkillRuntime(frame.paramsJSON);
    const duplexCommand =
      state.duplexEnabled && (claudeSkills || isRegisteredNodeHostCommandDuplex(frame.command));
    const streamableInvoke = duplexCommand || frame.command === NODE_DESKTOP_STREAM_COMMAND;
    // system.run streams only when its params request it; the writer
    // stays inert for invokes that never write a chunk.
    const progressEnabled = streamableInvoke || frame.command === NODE_SYSTEM_RUN_COMMAND;
    const controller = new AbortController();
    // Every command must remain cancellable after dispatch; only duplex
    // commands own ordered input and its pre-spawn buffer.
    const input: NodeInvokeInputTarget | undefined = duplexCommand
      ? {
          nextInputSeq: 0,
          pendingInput: new BoundedBuffer<string>(
            MAX_PENDING_INVOKE_INPUT_BYTES,
            {
              mode: "fail-closed",
              onOverflow: () =>
                controller.abort(new Error("terminal input exceeded the 64 KiB pre-spawn buffer")),
            },
            (payload) => Buffer.byteLength(payload, "utf8"),
          ),
          inputFailed: false,
        }
      : undefined;
    const active: ActiveNodeInvoke = { controller, ...(input ? { input } : {}) };
    // Redelivered IDs must not orphan the original command's process or
    // let its cleanup unregister the replacement invocation.
    state.activeInvokes.get(frame.id)?.controller.abort();
    state.activeInvokes.set(frame.id, active);
    const progress = progressEnabled
      ? createNodeInvokeProgressWriter({
          client: state.client,
          frame,
          idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
          onError: () => controller.abort(),
        })
      : undefined;
    if (duplexCommand) {
      progress?.startHeartbeats();
    }
    const framedIo =
      input && progress
        ? createNodeDuplexEndpoint({
            ...(claudeSkills ? { maxMessageBytes: NODE_CLAUDE_SKILLS_MESSAGE_BYTES } : {}),
            sendFrame: async (payload) => await progress.write(JSON.stringify(payload)),
            onError: (error) => {
              active.framedFailure = error;
              controller.abort(error);
            },
          })
        : undefined;
    if (framedIo) {
      controller.signal.addEventListener("abort", () => framedIo.close(), { once: true });
    }
    let framedInputRegistered = false;
    const pluginCommandIo: OpenClawPluginNodeHostCommandIo | undefined =
      input && progress && framedIo
        ? {
            signal: controller.signal,
            emitChunk: async (chunk) => await progress.write(chunk),
            onInput: (callback) => {
              if (state.activeInvokes.get(frame.id) === active) {
                registerNodeInvokeInputHandler(input, callback);
              }
            },
            frames: {
              send: async (message) => await framedIo.send(message),
              onMessage: (callback) => {
                const unsubscribe = framedIo.onMessage(callback);
                if (!framedInputRegistered) {
                  framedInputRegistered = true;
                  registerNodeInvokeInputHandler(input, (payloadJSON) => {
                    try {
                      framedIo.receive(payloadJSON);
                    } catch (error) {
                      controller.abort(error);
                    }
                  });
                  void framedIo.sendReady().catch(controller.abort.bind(controller));
                }
                return unsubscribe;
              },
            },
          }
        : undefined;
    // A lease-tagged exec keeps occupancy until its process tree is
    // extinct; revoke and disconnect tree-kill through this handle.
    const settleLeaseProcess = state.occupancyRuntime?.registerLeaseProcessForInvoke({
      command: frame.command,
      admission: leaseAdmission,
      abort: () => controller.abort(),
    });
    const dispatch = async () => {
      try {
        await handleInvoke(frame, state.client, state.skillBins, state.manager, {
          ...(state.claudePath ? { claudePath: state.claudePath } : {}),
          signal: controller.signal,
          pluginCommandIo,
          flushPluginCommandIo: framedIo?.drain,
          canReportAbortedFailure: (error) =>
            controller.signal.aborted &&
            error === active.framedFailure &&
            error === controller.signal.reason &&
            state.activeInvokes.get(frame.id) === active,
          ...(state.gatewayConnection?.url ? { gatewayUrl: state.gatewayConnection.url } : {}),
          ...(state.gatewayConnection?.tlsFingerprint
            ? { gatewayTlsFingerprint: state.gatewayConnection.tlsFingerprint }
            : {}),
          ...(state.gatewayConnection?.cloudflareAccess
            ? { gatewayCloudflareAccess: state.gatewayConnection.cloudflareAccess }
            : {}),
          desktopHostConfig: state.desktopHostConfig,
          ...(progress ? { emitProgress: (text: string) => progress.write(text) } : {}),
          installedAppsSharingEnabled: state.installedAppsSharingEnabled,
          installedAppsPlatform: state.platform,
          pluginCommandContext: state.pluginCommandContext,
          ...(state.ephemeral && !state.commandAllowlist
            ? {
                workerComputer: { capabilities: () => state.resolvePluginNodeHost().computerUse },
              }
            : {}),
          ...(state.workerBundleInstaller
            ? { workerBundleInstaller: state.workerBundleInstaller }
            : {}),
          ...(state.workerSupervisor ? { workerSupervisor: state.workerSupervisor } : {}),
          ...(state.workerWorkspace ? { workerWorkspace: state.workerWorkspace } : {}),
        });
      } finally {
        framedIo?.close();
        progress?.stop();
        await progress?.flush();
        if (state.activeInvokes.get(frame.id) === active) {
          state.activeInvokes.delete(frame.id);
        }
      }
    };
    try {
      // Interactive control surfaces share one device resource; the gate
      // serializes them while exec and file commands stay parallel.
      if (state.occupancyRuntime?.shouldSerializeControl(frame.command)) {
        await state.occupancyRuntime.runControl(dispatch);
      } else {
        await dispatch();
      }
    } finally {
      settleLeaseProcess?.();
    }
  } finally {
    state.inFlightInvokes -= 1;
  }
}

export function handleNodeHostInvokeInput(
  state: NodeHostInvokeState,
  invokeId: string,
  seq: number,
  payloadJSON: string,
): void {
  const input = state.activeInvokes.get(invokeId)?.input;
  if (!dispatchNodeInvokeInput(input, seq, payloadJSON)) {
    logDebug(`node-host: dropped inactive or duplicate input for invoke ${invokeId}`);
  }
}
