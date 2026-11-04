import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export const MODEL_RETRY_RECORD_TYPE = "openclaw.model-retry";
export const MODEL_RETRY_ERROR_MAX_CHARS = 4_000;
export const MODEL_RETRY_STAGES = [
  "waiting",
  "requesting",
  "recovered",
  "failed",
  "aborted",
] as const;
export type ModelRetryStatus = {
  id: string;
  number: number;
  stage: (typeof MODEL_RETRY_STAGES)[number];
  reason: string;
  errorMessage: string;
  at: number;
  code?: string;
  status?: number;
  stopReason?: "non_retryable" | "exhausted";
  persistenceError?: string;
};

/** Projects only bounded display facts; arbitrary persisted details never reach clients. */
export function readModelRetryStatus(value: unknown): ModelRetryStatus | undefined {
  const source = asOptionalRecord(value);
  if (!source) {
    return undefined;
  }
  const text = (entry: unknown, max: number, nonempty = false): entry is string =>
    typeof entry === "string" && entry.length <= max && (!nonempty || entry.length > 0);
  const stage = MODEL_RETRY_STAGES.find((candidate) => candidate === source.stage);
  if (
    !text(source.id, 256, true) ||
    !Number.isSafeInteger(source.number) ||
    typeof source.number !== "number" ||
    source.number < 0 ||
    !stage ||
    !text(source.reason, 64, true) ||
    !text(source.errorMessage, MODEL_RETRY_ERROR_MAX_CHARS) ||
    typeof source.at !== "number" ||
    !Number.isFinite(source.at) ||
    source.at < 0 ||
    (source.code !== undefined && !text(source.code, 128)) ||
    (source.status !== undefined &&
      (typeof source.status !== "number" ||
        !Number.isInteger(source.status) ||
        source.status < 100 ||
        source.status > 599)) ||
    (source.stopReason !== undefined &&
      source.stopReason !== "non_retryable" &&
      source.stopReason !== "exhausted") ||
    (source.persistenceError !== undefined && !text(source.persistenceError, 300))
  ) {
    return undefined;
  }
  return {
    id: source.id,
    number: source.number,
    stage,
    reason: source.reason,
    errorMessage: source.errorMessage,
    at: source.at,
    ...(source.code !== undefined ? { code: source.code } : {}),
    ...(source.status !== undefined ? { status: source.status } : {}),
    ...(source.stopReason !== undefined ? { stopReason: source.stopReason } : {}),
    ...(source.persistenceError !== undefined ? { persistenceError: source.persistenceError } : {}),
  };
}
