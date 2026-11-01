import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MODEL_RETRY_RECORD_TYPE,
  readModelRetryStatus,
  type ModelRetryStatus,
} from "../../../../packages/gateway-protocol/src/chat-retry.ts";
import { t } from "../../i18n/index.ts";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";

const REASON_KEYS = new Map(
  Object.entries({
    rate_limit: "rateLimit",
    overloaded: "unavailable",
    server_error: "unavailable",
    tls_certificate: "tls",
    context_overflow: "contextLength",
    session_expired: "sessionExpired",
    empty_response: "incompleteResponse",
    timeout: "timeout",
    network: "network",
    auth: "auth",
    auth_permanent: "auth",
    billing: "billing",
    format: "format",
    model_not_found: "modelNotFound",
    context_length: "contextLength",
    output_limit: "outputLimit",
    incomplete_response: "incompleteResponse",
    harness_error: "harnessError",
  }),
);

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

export function modelRetrySummary(status: ModelRetryStatus): string {
  const key =
    status.status !== undefined && status.status >= 500
      ? "unavailable"
      : status.code && NETWORK_ERROR_CODES.has(status.code.toUpperCase())
        ? "network"
        : REASON_KEYS.get(status.reason);
  const reason = key ? t(`chat.modelRetry.reasons.${key}`) : status.errorMessage;
  const code = status.status ? `HTTP ${status.status}` : status.code;
  return code ? `${reason} (${code})` : reason;
}

export function modelRetryStageLabel(status: ModelRetryStatus): string {
  if (status.stage === "failed" && status.stopReason) {
    return t(`chat.modelRetry.${status.stopReason}`);
  }
  return t(`chat.modelRetry.${status.stage}`);
}

export function modelRetryLabel(status: ModelRetryStatus): string {
  const attempt =
    status.number > 0 ? t("chat.modelRetry.attempt", { count: String(status.number) }) : "";
  return [modelRetrySummary(status), attempt, modelRetryStageLabel(status)]
    .filter(Boolean)
    .join(" · ");
}

const retryMessageStatuses = new WeakMap<object, ModelRetryStatus | undefined>();

export function readRetryMessage(message: unknown): ModelRetryStatus | undefined {
  const record = asNullableRecord(message);
  if (!record || record.role !== "custom" || record.customType !== MODEL_RETRY_RECORD_TYPE) {
    return undefined;
  }
  if (retryMessageStatuses.has(record)) {
    return retryMessageStatuses.get(record);
  }
  const status = readModelRetryStatus(record.details);
  retryMessageStatuses.set(record, status);
  return status;
}

/** The transcript remains authoritative; this is a per-render, per-run projection. */
export function projectRetryNotices(
  messages: unknown[],
): Map<string, Extract<ChatItem, { kind: "notice" }>> {
  const runs = new Map<string, ModelRetryStatus[]>();
  for (const message of messages) {
    const status = readRetryMessage(message);
    const marker = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
    if (!status || typeof marker?.runId !== "string") {
      continue;
    }
    const records = runs.get(marker.runId) ?? [];
    const duplicate = records.findIndex(
      (entry) => entry.id === status.id && entry.at === status.at && entry.stage === status.stage,
    );
    if (duplicate < 0) {
      records.push(status);
    } else if (status.persistenceError) {
      records[duplicate] = status;
    }
    runs.set(marker.runId, records);
  }
  return new Map(
    [...runs].map(([runId, records]) => {
      records.sort((a, b) => a.number - b.number || a.at - b.at);
      return [
        runId,
        {
          kind: "notice" as const,
          key: `model-retry:${runId}`,
          text: "",
          label: t("chat.modelRetry.history", {
            count: String(Math.max(...records.map((record) => record.number))),
          }),
          timestamp: records[0]!.at,
          retryHistory: records,
        },
      ];
    }),
  );
}

export function latestRetryFailure(
  messages: readonly unknown[],
  runId: string | undefined,
): ModelRetryStatus | undefined {
  if (!runId) {
    return undefined;
  }
  let latest: ModelRetryStatus | undefined;
  for (const message of messages) {
    if (asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.runId !== runId) {
      continue;
    }
    const status = readRetryMessage(message);
    if (
      status &&
      (!latest ||
        status.number > latest.number ||
        (status.number === latest.number && status.at >= latest.at))
    ) {
      latest = status;
    }
  }
  return latest?.stage === "failed" && latest.stopReason ? latest : undefined;
}

export function modelRetryErrorDetails(status: ModelRetryStatus): string {
  return [status.code, status.errorMessage].filter(Boolean).join("\n\n");
}

export function modelRetryFailureMessage(status: ModelRetryStatus): string {
  const summary = `${modelRetrySummary(status)} · ${modelRetryStageLabel(status)}`;
  const persistence = status.persistenceError
    ? t("chat.modelRetry.persistenceError", { error: status.persistenceError })
    : "";
  return [summary, modelRetryErrorDetails(status), persistence].filter(Boolean).join("\n\n");
}

/** Failed persistence stays visibly unsaved in the existing session projection. */
export function retainUnsavedModelRetry(
  host: Parameters<typeof publishChatSessionProjectionMessages>[0],
  runId: string,
  status: ModelRetryStatus,
): void {
  if (
    !status.persistenceError ||
    host.chatMessages.some((message) => {
      const existing = readRetryMessage(message);
      return (
        existing?.id === status.id &&
        existing.at === status.at &&
        existing.stage === status.stage &&
        asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.runId === runId
      );
    })
  ) {
    return;
  }
  publishChatSessionProjectionMessages(host, [
    ...host.chatMessages,
    {
      role: "custom",
      customType: MODEL_RETRY_RECORD_TYPE,
      display: true,
      excludeFromContext: true,
      details: status,
      timestamp: status.at,
      content: modelRetrySummary(status),
      __openclaw: { runId, id: `unsaved-retry:${runId}:${status.id}:${status.at}:${status.stage}` },
    },
  ]);
}
