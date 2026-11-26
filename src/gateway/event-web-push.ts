import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { lookupCronRunExecSource } from "../infra/cron-run-exec-source.js";
import { sanitizeExecApprovalDisplayText } from "../infra/exec-approval-text-sanitize.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { formatRawAssistantErrorForUi } from "../shared/assistant-error-format.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { deriveSessionTitle } from "./session-utils-core.js";
import {
  listCurrentWebPushTargets,
  withCurrentWebPushAuthority,
  webPushTargetClient,
  webPushSessionAccess,
  type WebPushAuthority,
} from "./web-push-authority.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
const AGENT_FAILURE_REASON_MAX_UTF16 = 160;
const defaultLog = createSubsystemLogger("gateway/web-push");

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
  path?: string;
  /** A failed run uses failure liveness (cron dedupe, high urgency) while keeping its category. */
  failed?: true;
};

type FocusedSessionViewers = {
  isFocusedForIdentity: (
    identity: { userProfileId: string | null; deviceId: string },
    sessionKeys: ReadonlySet<string>,
  ) => boolean;
};

export type HumanMentionWebPush = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  prepare: () => Promise<void>;
  isCurrent: () => boolean;
};

/** Mirrors the canonical viewer declarations so focused keys compare with completion scope. */
function canonicalFocusedSessionKey(sessionKey: string, agentId: string | undefined): string {
  return parseAgentSessionKey(sessionKey) || !agentId
    ? sessionKey
    : `agent:${normalizeAgentId(agentId)}:${sessionKey}`;
}

/**
 * Resolves the one canonical title shared by the completion's prepared facts. A completion
 * address can carry several store keys for the same row, so uniqueness is by physical row,
 * not by key count; ambiguous completions keep the generic title instead of guessing.
 */
function resolveCompletedSessionTitle(authority: WebPushAuthority): string | undefined {
  const entries = new Map<string, SessionEntry>();
  for (const facts of authority.sessions.values()) {
    const { target } = facts;
    if (target) {
      entries.set(`${target.storePath}\u0000${target.storeKey}`, target.entry);
    }
  }
  if (entries.size !== 1) {
    return undefined;
  }
  const [entry] = [...entries.values()];
  // Title metadata is already the persisted canonical title; only display bounding remains.
  const title = deriveSessionTitle(entry)
    ?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalizeWebPushDisplayLabel(title);
}

function formatAgentFailureReason(errorMessage: string): string {
  // Reuse the UI's error formatter (HTML/provider payloads become user copy), then redact and
  // bound before the text reaches a lock screen. Nothing raw survives this path.
  const formatted = formatRawAssistantErrorForUi(errorMessage).replace(/\s+/gu, " ").trim();
  return truncateUtf16Safe(
    sanitizeExecApprovalDisplayText(formatted).replace(/\s+/gu, " ").trim(),
    AGENT_FAILURE_REASON_MAX_UTF16,
  ).trim();
}

function resolveCompletedSessionKeys(
  payload: unknown,
  opts: GatewayBroadcastOpts | undefined,
  agentId: string | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const key of opts?.sessionKeys ?? []) {
    const trimmed = key.trim();
    if (trimmed) {
      keys.add(canonicalFocusedSessionKey(trimmed, agentId));
    }
  }
  const payloadSessionKey = isRecord(payload)
    ? normalizeOptionalString(payload.sessionKey)
    : undefined;
  if (payloadSessionKey) {
    keys.add(canonicalFocusedSessionKey(payloadSessionKey, agentId));
  }
  return keys;
}

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    const questionId = normalizeOptionalString(value.id);
    return {
      category: "agent-question",
      title: "AgileClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
      ...(questionId ? { path: `ask/${encodeURIComponent(questionId)}` } : {}),
    };
  }
  if (event === "chat" && value.state === "error") {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "failed";
    const errorMessage = normalizeOptionalString(value.errorMessage);
    const reason = errorMessage ? formatAgentFailureReason(errorMessage) : "";
    return {
      category: "agent-finished",
      failed: true,
      title: "AgileClaw agent failed",
      body: "An agent run failed.",
      identifiedBody: reason ? `Task failed: ${reason}` : "Task failed.",
      tag: `openclaw-agent-failed-${runId}`,
    };
  }
  if (
    event === "chat" &&
    value.state === "final" &&
    value.yielded !== true &&
    !isTranscriptOnlyOpenClawAssistantMessage(value.message)
  ) {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      title: "AgileClaw agent finished",
      body: "An agent completed its response.",
      identifiedBody: "Task completed.",
      tag: `openclaw-agent-finished-${runId}`,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = isRecord(value.job) ? value.job : null;
    const jobId = normalizeOptionalString(value.jobId);
    const jobTag = normalizeWebPushDisplayLabel(jobId) ?? "failed";
    const jobName = normalizeWebPushDisplayLabel(job?.name);
    const query = new URLSearchParams();
    if (jobId) {
      query.set("job", jobId);
      const runId =
        normalizeOptionalString(value.runId) ??
        (typeof value.runAtMs === "number" &&
        Number.isSafeInteger(value.runAtMs) &&
        value.runAtMs >= 0
          ? createCronExecutionId(jobId, value.runAtMs)
          : undefined);
      if (runId) {
        query.set("run", runId);
      }
    }
    return {
      category: "scheduled-task-failed",
      title: "AgileClaw scheduled task failed",
      body: "A scheduled task needs attention.",
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobTag}`,
      path: `automations${query.size ? `?${query}` : ""}`,
    };
  }
  return null;
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: Pick<SubsystemLogger, "warn">;
  stateDir?: string;
  /** Current per-connection focus declarations; undefined before Gateway live state exists. */
  getFocusedSessionViewers?: () => FocusedSessionViewers | undefined;
}) {
  const log = params.log ?? defaultLog;
  const deliver = (
    notification: EventNotification,
    event: string,
    payload?: unknown,
    opts?: GatewayBroadcastOpts,
    mention?: HumanMentionWebPush,
    /** Captured while the completion event is produced, before the run source clears. */
    notifyOnComplete = true,
  ): void => {
    if (!notifyOnComplete) {
      return;
    }
    const deliveryAgentId = normalizeOptionalString(
      opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
    );
    const completedSessionKeys =
      notification.category === "agent-finished"
        ? resolveCompletedSessionKeys(payload, opts, deliveryAgentId)
        : undefined;
    void (async () => {
      if (!(await hasBoundWebPushSubscriptions(params.stateDir))) {
        return;
      }
      const sender = await prepareWebPushNotificationSender(params.stateDir);
      const agentId = deliveryAgentId;
      const sessionKeys = opts?.sessionKeys ?? [];
      const groupedResults = await withCurrentWebPushAuthority(
        { ...params, sessionKeys, agentId, preparePublication: mention?.prepare },
        (authority) => {
          const { cfg } = authority;
          const recipientProfileId =
            mention &&
            authority.profile?.readCurrentIdentity(mention.recipientProfileId)?.profileId;
          if (mention && !recipientProfileId) {
            return undefined;
          }
          const sessionKey = mention?.sessionKey ?? sessionKeys[0];
          const sessionPath = sessionKey
            ? buildControlUiSessionPath({
                namespace: "chat",
                sessionKey,
                fallbackAgentId: agentId,
                mainKey: cfg.session?.mainKey,
                exactKey: true,
              })
            : undefined;
          if (mention && !sessionPath) {
            return undefined;
          }
          const path = notification.path ?? sessionPath?.slice(1) ?? "sessions";
          const url = resolveControlUiWebPushUrl(cfg, path);
          const targets = listCurrentWebPushTargets({
            ...authority,
            requiredScopes:
              notification.category === "agent-question"
                ? [READ_SCOPE, QUESTIONS_SCOPE]
                : [READ_SCOPE],
            ...(mention ? { visibilityScopes: [ADMIN_SCOPE] } : {}),
          });
          const sessionTitle =
            notification.category === "agent-finished"
              ? resolveCompletedSessionTitle(authority)
              : undefined;
          const agentLabel = normalizeWebPushDisplayLabel(agentId);
          const groups = new Map<
            string,
            { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
          >();
          for (const target of targets) {
            if (mention && target.userProfileId !== recipientProfileId) {
              continue;
            }
            if (
              completedSessionKeys &&
              params.getFocusedSessionViewers?.()?.isFocusedForIdentity(
                {
                  userProfileId: target.userProfileId,
                  deviceId: target.subscription.deviceId,
                },
                completedSessionKeys,
              )
            ) {
              // This recipient is already rendering the completed session in a focused
              // window. Only the completion push is suppressed; unread state is untouched.
              continue;
            }
            const { preferences } = target;
            if (
              !webPushCategoryEnabled(preferences, notification.category) ||
              isWebPushQuietHours(preferences) ||
              !webPushAgentAllowed(preferences, agentId)
            ) {
              continue;
            }
            const client = webPushTargetClient(target);
            if (
              sessionKeys.length > 0 &&
              !canReceiveSessionEvent({
                cfg,
                client,
                prepared: webPushSessionAccess(authority, client),
                sessionKeys,
                ...(agentId ? { agentId } : {}),
                event,
                payload,
              })
            ) {
              continue;
            }
            if (cfg.gateway?.roles && sessionKeys.length === 0) {
              // Multi-user events without an authoritative session owner are not broadcast offline.
              continue;
            }
            const prefix = preferences.label ? `${preferences.label} · ` : "";
            // Only names-level detail may show the session title; private keeps generic copy.
            const title = `${prefix}${
              sessionTitle && preferences.detailLevel !== "private"
                ? sessionTitle
                : notification.title
            }`;
            const body =
              preferences.detailLevel === "private"
                ? notification.body
                : (notification.identifiedBody ??
                  (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
            const key = JSON.stringify({ title, body });
            const group = groups.get(key) ?? { title, body, subscriptions: [] };
            group.subscriptions.push(target.subscription);
            groups.set(key, group);
          }
          // The mention owner fences dismissal, expiry, session replacement and Gateway
          // teardown after preparation. No awaited work may separate it from the send.
          if (mention && !mention.isCurrent()) {
            return undefined;
          }
          const topic = createHash("sha256")
            .update(notification.tag)
            .digest("base64url")
            .slice(0, 32);
          return {
            start: () =>
              Promise.all(
                [...groups.values()].map((group) =>
                  sender({
                    subscriptions: group.subscriptions,
                    payload: {
                      title: group.title,
                      body: group.body,
                      tag: notification.tag,
                      renotify: false,
                      url,
                    },
                    deliveryOptions: {
                      TTL: EVENT_PUSH_TTL_SECONDS,
                      urgency:
                        notification.failed || notification.category.includes("failed")
                          ? "high"
                          : "normal",
                      topic,
                    },
                  }),
                ),
              ),
          };
        },
      );
      if (!groupedResults) {
        return;
      }
      const results = groupedResults.flat();
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) {
        log.warn("event Web Push delivery failed", {
          category: notification.category,
          attempted: results.length,
          failed,
        });
      }
    })().catch(() => {
      // Transport failures can contain endpoints and payload bytes; log only the closed category.
      log.warn("event Web Push delivery could not complete", { category: notification.category });
    });
  };

  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (notification) {
        // Capture the cron run fact synchronously; the run clears its exec source at settle.
        const runId =
          notification.category === "agent-finished" && isRecord(payload)
            ? normalizeOptionalString(payload.runId)
            : undefined;
        const cronSource = runId ? lookupCronRunExecSource(runId) : undefined;
        if (notification.failed && cronSource) {
          // The cron event already notifies this run's failure through scheduled-task-failed.
          return;
        }
        deliver(
          notification,
          event,
          payload,
          opts,
          undefined,
          cronSource?.notifyOnComplete !== false,
        );
      }
    },
    deliverMention(this: void, mention: HumanMentionWebPush): void {
      const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
      const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
      const id = createHash("sha256").update(mention.id).digest("base64url");
      deliver(
        {
          category: "human-mentioned",
          title: "AgileClaw mention",
          body: "Someone mentioned you in a conversation.",
          identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
          tag: `openclaw-mention-${id}`,
        },
        "human-mentioned",
        undefined,
        { agentId: mention.agentId, sessionKeys: [mention.sessionKey] },
        mention,
      );
    },
  };
}
