import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  MODEL_RETRY_ERROR_MAX_CHARS,
  MODEL_RETRY_RECORD_TYPE,
  type ModelRetryStatus,
} from "../../packages/gateway-protocol/src/chat-retry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import type { SessionTranscriptWriteScope } from "../config/sessions/session-accessor.types.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";

function safeError(error: unknown, maxChars = MODEL_RETRY_ERROR_MAX_CHARS): string {
  const rawError = asOptionalRecord(error)?.rawError;
  return truncateUtf16Safe(
    redactSensitiveText(
      formatErrorMessage(typeof rawError === "string" && rawError.trim() ? rawError : error),
      { mode: "tools" },
    ),
    maxChars,
  );
}

export type ModelRetryReporterState = {
  count: number;
  latest?: ModelRetryStatus;
  pendingFailure?: {
    reason: string;
    error: unknown;
    code?: string;
    status?: number;
    stopReason?: "non_retryable" | "exhausted";
  };
  finish?: (
    outcome: "recovered" | "failed" | "aborted",
    error?: unknown,
    stopReason?: "non_retryable" | "exhausted",
  ) => Promise<void>;
};

class ModelRetryOwnerRefusedError extends Error {
  constructor(cause: unknown) {
    super("Retry history run owner is no longer current", { cause });
    this.name = "ModelRetryOwnerRefusedError";
  }
}

function assertModelRetryOwnerCurrent(assertCurrent: () => void): void {
  try {
    assertCurrent();
  } catch (error) {
    throw new ModelRetryOwnerRefusedError(error);
  }
}

/** Settlement preserves the established result when its exact run authority has retired. */
export async function settleModelRetryState(
  state: ModelRetryReporterState | undefined,
  outcome: "recovered" | "failed" | "aborted",
  error?: unknown,
  stopReason?: "non_retryable" | "exhausted",
): Promise<boolean> {
  try {
    await state?.finish?.(outcome, error, stopReason);
    return true;
  } catch (failure) {
    if (failure instanceof ModelRetryOwnerRefusedError) {
      return false;
    }
    throw failure;
  }
}

/** Owns retry display facts; retry policy and dispatch authority stay with the runner. */
export function createModelRetryReporter(params: {
  runId: string;
  state?: ModelRetryReporterState;
  sessionKey?: string;
  getTarget?: () => (SessionTranscriptWriteScope & { sessionId: string }) | undefined;
  withWriter?: <T>(operation: () => Promise<T>) => Promise<T>;
  assertCurrent: () => void;
  assertTerminalCurrent?: () => void;
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => unknown;
}) {
  const state = params.state ?? { count: 0 };
  const assertActive = params.assertCurrent;
  const assertTerminalActive = () =>
    assertModelRetryOwnerCurrent(params.assertTerminalCurrent ?? params.assertCurrent);
  let attempt: number | undefined;
  let maxAttempts: number | undefined;
  const timestamp = () => Math.max(Date.now(), (state.latest?.at ?? 0) + 1);

  function emit(status: ModelRetryStatus, assertCurrent: () => void): void {
    assertCurrent();
    const event = {
      stream: "run_status",
      data: {
        phase:
          status.stage === "waiting" || status.stage === "requesting"
            ? "retrying"
            : "starting_model",
        retry: status,
        ...(attempt !== undefined ? { attempt } : {}),
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        reason: status.reason,
      },
    };
    emitAgentEvent({ ...event, runId: params.runId, sessionKey: params.sessionKey });
    try {
      // Optional observers cannot delay or fail model execution.
      void Promise.resolve(params.onAgentEvent?.(event)).catch(() => {});
    } catch {
      // Match the best-effort global event listener contract.
    }
  }

  async function publish(
    inputStatus: ModelRetryStatus,
    assertCurrent: () => void = assertActive,
  ): Promise<void> {
    assertCurrent();
    const { persistenceError: _previousPersistenceError, ...nextStatus } = inputStatus;
    let status: ModelRetryStatus = nextStatus;
    state.latest = status;
    emit(status, assertCurrent);
    const target = params.getTarget?.();
    if (target) {
      try {
        const write = () =>
          withSessionTranscriptWriteAssertion(target, assertCurrent, async () => {
            const result = await persistSessionTranscriptTurn(target, {
              expectedSessionId: target.sessionId,
              assertCurrent,
              runId: params.runId,
              updateMode: "inline",
              messages: [
                {
                  now: status.at,
                  message: {
                    role: "custom",
                    customType: MODEL_RETRY_RECORD_TYPE,
                    display: true,
                    excludeFromContext: true,
                    idempotencyKey: `${status.id}:${status.stage}:${status.at}`,
                    timestamp: status.at,
                    content: `Model request status: ${status.stage} (retry count: ${status.number})`,
                    details: status,
                    __openclaw: { runId: params.runId },
                  },
                },
              ],
            });
            assertCurrent();
            if (result.rejectedReason) {
              throw new Error(`Retry record rejected: ${result.rejectedReason}`);
            }
          });
        await (params.withWriter ? params.withWriter(write) : write());
      } catch (error) {
        // A revoked owner must not turn its failed write into a new public event.
        assertCurrent();
        status = {
          ...status,
          at: timestamp(),
          persistenceError: safeError(error, 300) || "Retry history could not be saved",
        };
        state.latest = status;
        emit(status, assertCurrent);
      }
    } else if (params.sessionKey) {
      status = {
        ...status,
        at: timestamp(),
        persistenceError: "Retry history cannot be saved for this session",
      };
      state.latest = status;
      emit(status, assertCurrent);
    }
  }

  return {
    async retry(
      this: void,
      input: {
        reason: string;
        error?: unknown;
        code?: string;
        status?: number;
        delayMs?: number;
        attempt?: number;
        maxAttempts?: number;
      },
    ): Promise<void> {
      assertActive();
      state.count++;
      state.pendingFailure = undefined;
      attempt = input.attempt;
      maxAttempts = input.maxAttempts;
      const error = asOptionalRecord(input.error);
      const code = input.code ?? error?.code;
      const status = input.status ?? error?.status ?? error?.statusCode;
      await publish({
        id: `${params.runId.slice(0, 200)}:retry:${state.count}`,
        number: state.count,
        stage: (input.delayMs ?? 0) > 0 ? "waiting" : "requesting",
        reason: safeError(input.reason, 64) || "unknown",
        errorMessage: input.error === undefined ? "" : safeError(input.error),
        at: timestamp(),
        ...(typeof code === "string" ? { code: safeError(code, 128) } : {}),
        ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
          ? { status }
          : {}),
      });
    },
    async requesting(this: void): Promise<void> {
      if (state.latest?.stage === "waiting") {
        await publish({ ...state.latest, stage: "requesting", at: timestamp() });
      }
    },
    async finish(
      this: void,
      outcome: "recovered" | "failed" | "aborted",
      error?: unknown,
      stopReason?: "non_retryable" | "exhausted",
    ): Promise<void> {
      if (!state.latest && outcome !== "failed") {
        return;
      }
      const failure = outcome === "failed" ? state.pendingFailure : undefined;
      const finalError = error ?? failure?.error;
      const errorRecord = asOptionalRecord(finalError);
      const code = failure?.code ?? errorRecord?.code;
      const status = failure?.status ?? errorRecord?.status ?? errorRecord?.statusCode;
      const previous = { ...state.latest };
      delete previous.stopReason;
      if (finalError !== undefined) {
        delete previous.code;
        delete previous.status;
      }
      const terminalStopReason =
        outcome === "failed" ? (stopReason ?? failure?.stopReason) : undefined;
      const finalStatus: ModelRetryStatus = {
        ...previous,
        ...(typeof code === "string" ? { code: safeError(code, 128) } : {}),
        ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
          ? { status }
          : {}),
        id: state.latest?.id ?? `${params.runId.slice(0, 200)}:retry:0`,
        number: state.count,
        reason: failure?.reason ?? state.latest?.reason ?? "unknown",
        errorMessage:
          finalError === undefined ? (state.latest?.errorMessage ?? "") : safeError(finalError),
        stage: outcome,
        at: timestamp(),
        ...(terminalStopReason ? { stopReason: terminalStopReason } : {}),
      };
      if (
        state.latest?.stage === outcome &&
        state.latest.number === finalStatus.number &&
        state.latest.errorMessage === finalStatus.errorMessage &&
        state.latest.reason === finalStatus.reason &&
        state.latest.code === finalStatus.code &&
        state.latest.status === finalStatus.status &&
        state.latest.stopReason === finalStatus.stopReason
      ) {
        return;
      }
      await publish(finalStatus, assertTerminalActive);
    },
  };
}
