import {
  readModelRetryStatus,
  type ModelRetryStatus,
} from "../../../../packages/gateway-protocol/src/chat-retry.ts";
import type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { modelRetryLabel } from "./chat-retry.ts";

registerNewSessionSetupEnglish();

export type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type ChatRunStartupState =
  | { state: "status"; runId: string; phase: ChatRunStartupPhase; seq?: number; retry?: undefined }
  | {
      state: "status";
      runId: string;
      phase: "retrying";
      message: string;
      seq: number;
      retry?: ModelRetryStatus;
    }
  | { state: "activity"; runId: string; seq?: number; retry?: ModelRetryStatus };

export type ChatRunStartupStatus = Extract<ChatRunStartupState, { state: "status" }>;

/** Live status and history retain the same agent sequence; chat deltas have a separate counter. */
export function reconcileChatRunStartup(
  host: { chatRunId?: string | null; chatRunStartup?: ChatRunStartupState | null },
  next: ChatRunStartupState,
): void {
  if (host.chatRunId !== next.runId) {
    return;
  }
  const current = host.chatRunStartup;
  if (current?.runId === next.runId) {
    if (
      (next.state === "status" && next.phase !== "retrying" && current.state === "activity") ||
      (current.seq !== undefined &&
        (next.seq === undefined ? next.state === "status" : next.seq <= current.seq))
    ) {
      return;
    }
    // Chat deltas use a different sequence; retain the agent sequence so an
    // older reconnect snapshot cannot resurrect an already-cleared retry.
    if (next.state === "activity" && next.seq === undefined && current.seq !== undefined) {
      host.chatRunStartup = { ...next, seq: current.seq };
      return;
    }
  }
  host.chatRunStartup = next;
}

const STARTUP_LABEL_KEYS = {
  waiting_for_state: "chat.startupStatus.waitingForState",
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  naming_worktree: "chat.startupStatus.namingWorktree",
  creating_worktree: "chat.startupStatus.creatingWorktree",
  running_setup: "chat.startupStatus.runningSetup",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  memory_flushing: "chat.startupStatus.memoryFlushing",
  starting_model: "chat.startupStatus.startingModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;

export function isChatRunStartupPhase(value: unknown): value is ChatRunStartupPhase {
  return typeof value === "string" && Object.hasOwn(STARTUP_LABEL_KEYS, value);
}

export function chatStartupStatusLabel(
  run: ChatRunStartupStatus | null | undefined,
  placement: ApplicationPlacementStartupStatus | null | undefined,
): string | undefined {
  if (run) {
    return run.phase === "retrying"
      ? run.retry
        ? modelRetryLabel(run.retry)
        : run.message
      : t(STARTUP_LABEL_KEYS[run.phase]);
  }
  switch (placement?.phase) {
    case "reconnecting":
      return t("connection.reconnecting");
    case "pending":
    case "requested":
    case "provisioning":
      return t("chat.startupStatus.provisioningEnvironment");
    case "syncing":
      return t("chat.startupStatus.preparingWorkspace");
    case "starting":
      return t("newSession.starting");
    case "active":
    case "sending":
      return t("chat.composer.sendingMessage");
    default:
      return undefined;
  }
}

export function activeChatRunStartupStatus(
  startup: ChatRunStartupState | null | undefined,
): ChatRunStartupStatus | null {
  return startup?.state === "status" ? startup : null;
}

/** Both transports carry the same agent sequence and structured retry fact. */
export function reconcileChatModelRetry(
  host: Parameters<typeof reconcileChatRunStartup>[0],
  runId: string,
  value: unknown,
  seq: number,
): boolean {
  const retry = readModelRetryStatus(value);
  if (!retry) {
    return false;
  }
  reconcileChatRunStartup(
    host,
    retry.stage === "waiting" || retry.stage === "requesting"
      ? { state: "status", phase: "retrying", runId, seq, message: modelRetryLabel(retry), retry }
      : { state: "activity", runId, seq, retry },
  );
  return true;
}
