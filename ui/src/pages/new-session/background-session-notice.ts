import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sleepWithAbort } from "@openclaw/retry";
import type { AgentWaitResult } from "../../../../src/agents/run-wait.types.js";
import { formatRawAssistantErrorForUi } from "../../../../src/shared/assistant-error-format.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { captureSessionNoticeOwner } from "./session-notice-owner.ts";

const RETRY_DELAY_MS = 1_000;
// Native copy limits shared with DashboardBackgroundSessionCompletion in the Mac app.
const NOTIFICATION_TITLE_LIMIT = 120;
const NOTIFICATION_BODY_LIMIT = 240;

/**
 * Native notifications render one bounded line and the bridge rejects control
 * characters, so collapse whitespace and cap length before it leaves the UI.
 */
function clampNotificationText(value: string, limit: number): string {
  const collapsed = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return `${truncateUtf16Safe(collapsed, limit - 1).trimEnd()}…`;
}

/**
 * Native titles carry only explicit session metadata (`label`, then `displayName`),
 * never `derivedTitle` — the Gateway derives that from the first user message while
 * generated titles race the run, so it can repeat the prompt — and never a raw
 * session key, which tells a lock screen nothing. Anything else falls back to the
 * localized generic name.
 */
function nativeSessionTitle(
  sessionKey: string,
  row: Pick<GatewaySessionRow, "label" | "displayName" | "accountId"> | undefined,
): string {
  const explicit = {
    label: normalizeOptionalString(row?.label),
    displayName: normalizeOptionalString(row?.displayName),
    accountId: normalizeOptionalString(row?.accountId),
  };
  // Only explicit metadata may title the notice.
  const named = [explicit.label, explicit.displayName].some(
    (name) => name !== undefined && name !== sessionKey,
  );
  if (!named) {
    return t("sessionsView.sessionFallback");
  }
  const rawName = resolveSessionDisplayName(sessionKey, explicit);
  // Compare untouched resolver output: clamping must never admit a transformed raw key.
  const title =
    rawName === sessionKey ? "" : clampNotificationText(rawName, NOTIFICATION_TITLE_LIMIT);
  return title || t("sessionsView.sessionFallback");
}

function backgroundSessionBody(result: Partial<AgentWaitResult>): string {
  if (result.status === "ok") {
    return t("newSession.backgroundTaskCompleted");
  }
  if (result.status === "timeout") {
    return t("sessionsView.statusTimeout");
  }
  if (result.stopReason === "rpc") {
    return t("sessionsView.statusKilled");
  }
  const reason = clampNotificationText(
    redactToolDetail(formatRawAssistantErrorForUi(result.error)),
    NOTIFICATION_BODY_LIMIT,
  );
  return t("sessionsView.runFailedReason", { reason });
}

async function notifyWhenBackgroundSessionEnds(params: {
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
  key: string;
  runId: string;
  isCurrentOwner: () => boolean;
}): Promise<void> {
  let result: Partial<AgentWaitResult> | undefined;
  while (!result) {
    try {
      const observed = await params.client.request<Partial<AgentWaitResult>>(
        "agent.wait",
        { runId: params.runId, timeoutMs: 30_000 },
        { timeoutMs: null },
      );
      if (params.context.gateway.snapshot.client !== params.client) {
        return;
      }
      const observationalTimeout =
        observed.status === "timeout" &&
        observed.endedAt === undefined &&
        !observed.error &&
        !observed.stopReason &&
        observed.providerStarted !== true;
      if (observed.status === "pending" || observed.pendingError === true) {
        await sleepWithAbort(RETRY_DELAY_MS);
      } else if (observationalTimeout) {
        // Startup display errors can mean unconfirmed delivery, not a failed run.
        const initialTurn = params.context.placementStartup.get(params.key)?.initialTurn;
        if (initialTurn?.sendState === "failed" && initialTurn.sendRunId === params.runId) {
          result = { status: "error", error: initialTurn.sendError };
        } else {
          // A wait deadline is not a run outcome, even after startup custody retires.
          await sleepWithAbort(RETRY_DELAY_MS);
        }
      } else {
        result = observed;
      }
    } catch {
      const gateway = params.context.gateway.snapshot;
      const reconnecting =
        gateway.phase === "connecting" ||
        gateway.phase === "starting" ||
        gateway.phase === "reconnecting";
      if (gateway.client !== params.client || !reconnecting) {
        return;
      }
      await sleepWithAbort(RETRY_DELAY_MS);
    }
  }

  if (!params.isCurrentOwner()) {
    return;
  }
  const gateway = params.context.gateway.snapshot;
  if (uiSessionEventMatches(gateway, params.key, params.agentId)) {
    return;
  }
  const row = params.context.sessions.state.result?.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, params.key),
  );
  const status =
    result.status === "ok"
      ? t("sessionsView.statusDone")
      : result.status === "timeout"
        ? t("sessionsView.statusTimeout")
        : result.stopReason === "rpc"
          ? t("sessionsView.statusKilled")
          : t("sessionsView.statusFailed");
  const nativeTarget = sessionNavigationTarget({
    face: "chat",
    sessionKey: params.key,
    fallbackAgentId: params.agentId,
    exactKey: true,
  });
  const sessionName = resolveSessionDisplayName(params.key, row);
  params.context.nativeNotifications?.backgroundSessionCompleted({
    runId: params.runId,
    path: nativeTarget.options.pathname,
    ...(nativeTarget.options.search ? { search: nativeTarget.options.search } : {}),
    title: nativeSessionTitle(params.key, row),
    body: clampNotificationText(backgroundSessionBody(result), NOTIFICATION_BODY_LIMIT),
  });
  showToast({
    fifo: true,
    message: `${sessionName}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => {
      if (!params.isCurrentOwner()) {
        return;
      }
      selectApplicationSession({
        selection: params.context.agentSelection,
        gateway: params.context.gateway,
        sessionKey: params.key,
        agentId: params.agentId,
      });
      params.context.navigate(
        "chat",
        sessionNavigationTarget({
          context: params.context,
          face: "chat",
          sessionKey: params.key,
          agentId: params.agentId,
        }).options,
      );
    },
  });
}

export function prepareBackgroundSessionCompletion(params: {
  enabled: boolean;
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
}): (key: string, runId?: string) => boolean {
  const isCurrentOwner = captureSessionNoticeOwner(params.context);
  return (key, runId) => {
    const normalizedRunId = runId?.trim();
    if (!params.enabled) {
      return false;
    }
    // Creation disposition is independent of whether the Gateway returned a watchable run.
    if (!normalizedRunId) {
      return true;
    }
    void notifyWhenBackgroundSessionEnds({
      agentId: params.agentId,
      client: params.client,
      context: params.context,
      key,
      runId: normalizedRunId,
      isCurrentOwner,
    });
    return true;
  };
}

/** Keep notification permission on the original input event, before startup awaits. */
export function promptNewSessionNotifications(
  context: ApplicationContext,
  message: string,
  hasAttachments: boolean,
  direct: boolean,
) {
  if (
    shouldAutoPromptNotificationsOnSend({
      connected: context.gateway.snapshot.phase === "connected",
      directComposerSend: direct && hasActiveNotificationPromptGesture(),
      message,
      hasAttachments,
      isCommand: parseSlashCommand(message) !== null,
    })
  ) {
    autoPromptNotificationsOnSend(context);
  }
}
