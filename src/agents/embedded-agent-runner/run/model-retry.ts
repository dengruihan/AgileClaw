import type { AssistantMessage } from "../../../llm/types.js";
import {
  createModelRetryReporter,
  settleModelRetryState,
  type ModelRetryReporterState,
} from "../../../sessions/model-retry.js";
import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { describeFailoverError } from "../../failover-error.js";
import type { FailoverReason } from "../../failover/signal.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { EmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

/** Adapts embedded recovery and its terminal owner to the shared retry display contract. */
export function createEmbeddedRunModelRetry(input: {
  params: RunEmbeddedAgentInternalParams;
  session: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  admittedRunContext: AdmittedRunContext;
  assertCurrent: (() => void) | undefined;
  abortSignal?: AbortSignal;
  isTransientRetryExhausted: () => boolean;
  canStartNextAttempt: () => boolean;
  terminalRetryState: EmbeddedRunTerminalRetryState;
  getEmptyErrorRetries: () => number;
  finish: (result: EmbeddedAgentRunResult) => EmbeddedAgentRunResult;
}) {
  const { params, session: sessionPromptState, abortSignal } = input;
  const assertCurrent = () => {
    if (!input.assertCurrent) {
      throw new Error("Retry reporting requires an active admitted run");
    }
    input.assertCurrent();
  };
  const modelRetryState: ModelRetryReporterState = params.modelRetryState ?? { count: 0 };
  const retryReporter = createModelRetryReporter({
    runId: params.runId,
    sessionKey: params.sessionKey,
    state: modelRetryState,
    assertCurrent,
    assertTerminalCurrent: resolveAdmittedRunActiveAssertion(input.admittedRunContext),
    getTarget: () => {
      const target = sessionPromptState.sessionTarget;
      return params.sessionPersistence !== "detached" && target
        ? {
            ...target,
            ...sessionPromptState.sessionWriterFence,
            sessionId: sessionPromptState.sessionId,
          }
        : undefined;
    },
    withWriter: sessionPromptState.withSessionWriterContext,
    onAgentEvent: params.onAgentEvent,
  });
  modelRetryState.finish = retryReporter.finish;
  let retryRefusedByBudget = false;
  const failureDetails = (error: unknown, exhausted = false) => {
    const described = describeFailoverError(error);
    return {
      reason: described.reason ?? "unknown",
      error,
      code: described.code,
      status: described.status,
      stopReason: exhausted ? ("exhausted" as const) : ("non_retryable" as const),
    };
  };
  const reportRetry = async (failure: Parameters<typeof retryReporter.retry>[0]): Promise<void> => {
    if (!input.canStartNextAttempt()) {
      assertCurrent();
      retryRefusedByBudget = true;
      // Inner recovery can accept after the logical run's dispatch budget is spent.
      // Retain that failure for its terminal owner without counting an unstarted retry.
      const described = failureDetails(failure.error, true);
      modelRetryState.pendingFailure = {
        ...described,
        reason: failure.reason,
        code: failure.code ?? described.code,
        status: failure.status ?? described.status,
      };
      return;
    }
    await retryReporter.retry(failure);
  };
  const finishResult = async (result: EmbeddedAgentRunResult) => {
    const error =
      result.meta.error?.message ?? result.payloads?.find((payload) => payload.isError)?.text;
    const failed = Boolean(
      error || result.meta.modelFallbackStopReason === "agent_run_terminal_timeout",
    );
    if (failed) {
      const exhausted =
        result.meta.error?.kind === "retry_limit" ||
        input.isTransientRetryExhausted() ||
        (result.meta.error?.kind === "incomplete_turn" &&
          (input.getEmptyErrorRetries() > 0 ||
            input.terminalRetryState.reasoningOnlyAttempts > 0 ||
            input.terminalRetryState.emptyResponseAttempts > 0 ||
            input.terminalRetryState.missingAssistantAttempts > 0));
      const lastRetry = modelRetryState.latest;
      const pendingFailure = modelRetryState.pendingFailure;
      modelRetryState.pendingFailure =
        result.meta.error?.kind === "retry_limit" && pendingFailure
          ? { ...pendingFailure, stopReason: "exhausted" }
          : result.meta.error?.kind === "retry_limit" && lastRetry
            ? {
                reason: lastRetry.reason,
                error: lastRetry.errorMessage,
                code: lastRetry.code,
                status: lastRetry.status,
                stopReason: "exhausted",
              }
            : failureDetails(error ?? "Model request timed out", exhausted);
    }
    if (!params.modelRetryState) {
      await settleModelRetryState(
        modelRetryState,
        result.meta.aborted || abortSignal?.aborted ? "aborted" : failed ? "failed" : "recovered",
        modelRetryState.pendingFailure?.error ?? error,
        modelRetryState.pendingFailure?.stopReason,
      );
    }
    return input.finish(result);
  };
  return {
    state: modelRetryState,
    reporter: { retry: reportRetry, requesting: retryReporter.requesting },
    finishResult,
    retryFailure: (error: unknown) => reportRetry(failureDetails(error)),
    async retryAssistant(assistant: AssistantMessage | undefined, reason: FailoverReason | null) {
      const signal = assistant ? buildAssistantFailoverSignal(assistant) : undefined;
      await reportRetry({
        reason: reason ?? "unknown",
        error: assistant?.errorMessage,
        code: signal?.code,
        status: signal?.status,
      });
    },
    async retryIncompleteResponse(
      beforeFinalizeRevisions: number,
      compactionContinuations: number,
    ) {
      if (
        input.terminalRetryState.beforeFinalizeRevisionAttempts === beforeFinalizeRevisions &&
        input.terminalRetryState.compactionContinuationAttempts === compactionContinuations
      ) {
        await reportRetry({
          reason: "incomplete_response",
          error: "The model response ended without a complete visible answer.",
        });
      }
    },
    async fail(error: unknown): Promise<void> {
      if (!abortSignal?.aborted && !retryRefusedByBudget) {
        modelRetryState.pendingFailure = failureDetails(error, input.isTransientRetryExhausted());
      }
      if (!params.modelRetryState) {
        await settleModelRetryState(
          modelRetryState,
          abortSignal?.aborted ? "aborted" : "failed",
          modelRetryState.pendingFailure?.error ?? error,
          modelRetryState.pendingFailure?.stopReason,
        );
      }
    },
  };
}
