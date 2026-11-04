import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "../../../llm/types.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { Agent, AgentMessage } from "../../runtime/index.js";
import { buildSessionsYieldContextMessage } from "../../sessions-yield-context.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import {
  attachPromptCompactionRequestBudget,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import type { AgentSession } from "../../sessions/index.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { ackPendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import {
  declarePromptHistoryRewrite,
  recordAggregateTruncation,
} from "../prompt-cache-observability.js";
import { updateActiveEmbeddedRunSnapshot } from "../runs.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import { truncateOversizedToolResultsInMessages } from "../tool-result-truncation.js";
import { snapshotRecentMessages } from "./attempt-context-summary.js";
import {
  installModelPromptTransform,
  installRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "./attempt-llm-boundary.js";
import {
  isSessionsYieldAbortError,
  stripSessionsYieldArtifacts,
} from "./attempt-sessions-yield.js";
import { waitForEmbeddedAbortSettle } from "./attempt-subscription-cleanup.js";
import {
  admitBackgroundContextCarriers,
  recordBackgroundContextSubmission,
} from "./attempt-turn-context-carriers.js";
import {
  assertAttemptTurnContextCarriersCurrent,
  drainAttemptTurnContextContributionsForModelRequest,
  getAttemptTurnContextManager,
  installBackgroundContextCarriers,
  markAttemptTurnContextCarriers,
  type BackgroundContextCarrier,
} from "./attempt-turn-context.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptSubmissionSession = {
  messages: AgentMessage[];
  readonly isCompacting: boolean;
  [agentSessionQueuePromptContext]: AgentSession[typeof agentSessionQueuePromptContext];
  agent: {
    state: { messages: AgentMessage[] };
    streamFn: StreamFn;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    prepareNextTurn?: Agent["prepareNextTurn"];
    prepareNextTurnWithContext?: Agent["prepareNextTurnWithContext"];
    continue?: () => Promise<void>;
  };
};

type PromptActiveSession = (
  prompt: string,
  options?: Parameters<AgentSession["prompt"]>[1],
) => Promise<void>;

type SteeringLease = {
  leaseId: string;
  runIds: readonly string[];
  isCurrent: () => boolean;
};

type TrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;

export async function submitEmbeddedAttemptPrompt(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "promptCacheKey"
    | "sessionId"
    | "sessionKey"
    | "skipPreparedUserTurnMessage"
    | "userTurnTranscriptRecorder"
  >;
  activeSession: PromptSubmissionSession;
  appendOnlyRuntimeContext?: boolean;
  appendContext?: string;
  contextTokenBudget: number;
  compactionRequestBudget?: CompactionRequestBudget;
  images: ImageContent[];
  leasedSteering?: SteeringLease;
  modelPrompt: string;
  onFinalPromptText: (prompt: string) => void;
  assertHostActive?: () => void;
  /** Returns work only when a stale optional restriction must be withdrawn. */
  preparePrimaryModelRequest?: () =>
    | Promise<
        () => Pick<Parameters<StreamFn>[1], "tools" | "systemPrompt"> & {
          promptUpdate?: { update?: RuntimeContextCustomMessage; commit: () => void };
        }
      >
    | undefined;
  /** Observes only the first admitted foreground dispatch, not preflight/compaction. */
  onPrimaryModelRequest?: (tools: NonNullable<Parameters<StreamFn>[1]["tools"]>) => void;
  onSteeringAcknowledged: () => void;
  persistToolResultProjections: () => Promise<void>;
  prependContext?: string;
  promptActiveSession: PromptActiveSession;
  runtimeContextMessage?: RuntimeContextCustomMessage;
  /** Run identity for background turn-context contribution consumption. */
  turnContextRunId?: string;
  runtimeOnly: boolean;
  systemPrompt: string;
  toolResultAggregateMaxChars: number;
  toolResultMaxChars: number;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  trajectoryRecorder: TrajectoryRecorder | null;
  transcriptLeafId: string | null;
  transcriptPrompt: string;
}): Promise<void> {
  const { activeSession, attempt } = input;
  let pendingSteering = input.leasedSteering;
  const assertSteeringCurrent = () => {
    if (pendingSteering && !pendingSteering.isCurrent()) {
      throw new Error(
        "The queued child results lost authority before requester prompt submission.",
      );
    }
  };
  assertSteeringCurrent();
  const userTurnRecorder = attempt.userTurnTranscriptRecorder;
  const persistedUserIdempotencyKey =
    attempt.skipPreparedUserTurnMessage !== true && userTurnRecorder?.hasPersisted() === true
      ? (userTurnRecorder.getPersistedMessage?.() ?? userTurnRecorder.message)?.idempotencyKey
      : undefined;

  let primaryRequestObserved = false;
  const installProviderPromptHistoryTransform = (): (() => void) => {
    const baseStreamFn = activeSession.agent.streamFn;
    const basePrepareNextTurn = activeSession.agent.prepareNextTurnWithContext;
    const turnContextManager = getAttemptTurnContextManager(input.turnContextRunId);
    let latestRequest: {
      systemPrompt?: string;
      tools?: Parameters<typeof admitBackgroundContextCarriers>[0]["tools"];
    } = {};
    const admitCarriers = (
      carriers: readonly BackgroundContextCarrier[],
      messages: AgentMessage[],
    ) =>
      admitBackgroundContextCarriers({
        ...latestRequest,
        carriers,
        messages,
        tokenBudget: input.contextTokenBudget,
        contributionBudget: turnContextManager?.remainingContributionTokens() ?? 0,
      });
    const releaseTerminalAdmission = turnContextManager?.bindTerminalAdmission(async (carriers) => {
      const normalized = normalizeMessagesForLlmBoundary(activeSession.messages, {
        inHistorySystemUpdates: true,
        appendOnlyRuntimeContext: true,
        includeTimestamp: false,
      });
      const admission = admitCarriers(carriers, normalized);
      markAttemptTurnContextCarriers(
        input.turnContextRunId,
        admission.rejected,
        "dropped",
        "token-budget",
      );
      return admission.admitted;
    });
    // Runtime-context updates and background material carriers share one install
    // path: splice into the live loop context before the answer they governed.
    const lateUpdates: AgentMessage[] = [];
    const prepareNextTurn: NonNullable<Agent["prepareNextTurnWithContext"]> = async (
      turn,
      signal,
    ) => {
      const snapshot = basePrepareNextTurn
        ? await basePrepareNextTurn.call(activeSession.agent, turn, signal)
        : await activeSession.agent.prepareNextTurn?.(signal);
      if (lateUpdates.length === 0) {
        return snapshot;
      }
      const updates = lateUpdates.splice(0);
      const context = snapshot?.context ?? turn.context;
      // Dispatch saw the update after conversion; insert it before the answer it governed.
      const index = context.messages.indexOf(turn.message);
      if (index < 0) {
        return snapshot;
      }
      const newMessageIndex = turn.newMessages.indexOf(turn.message);
      if (newMessageIndex >= 0) {
        turn.newMessages.splice(
          newMessageIndex,
          0,
          ...updates.filter((update) => !turn.newMessages.includes(update)),
        );
      }
      const missing = updates.filter((update) => !context.messages.includes(update));
      return {
        ...snapshot,
        context: {
          ...context,
          messages: [
            ...context.messages.slice(0, index),
            ...missing,
            ...context.messages.slice(index),
          ],
        },
      };
    };
    activeSession.agent.prepareNextTurnWithContext = prepareNextTurn;
    const persistThenStream: StreamFn = async (model, context, options) => {
      // Runtime admission queues behind the user append; join it outside that write lane.
      await userTurnRecorder?.waitForRuntimePersistence();
      options?.signal?.throwIfAborted();
      assertSteeringCurrent();
      input.assertHostActive?.();
      await input.persistToolResultProjections();
      options?.signal?.throwIfAborted();
      assertSteeringCurrent();
      input.assertHostActive?.();
      let requestContext = context;
      const foregroundRequest = captureCurrentPromptForModel && !activeSession.isCompacting;
      const preparation = foregroundRequest ? input.preparePrimaryModelRequest?.() : undefined;
      if (preparation) {
        const readRestoredContext = await preparation;
        options?.signal?.throwIfAborted();
        assertSteeringCurrent();
        input.assertHostActive?.();
        // Read the live permitted surface only after all awaited preparation.
        // Do not reuse the tools snapshot captured before the restoration.
        const projection = readRestoredContext().promptUpdate;
        if (projection?.update) {
          await activeSession[agentSessionQueuePromptContext](projection.update, {
            delivery: "current-request",
          });
          lateUpdates.push(projection.update);
          requestContext = {
            ...context,
            messages: [
              ...context.messages,
              ...normalizeMessagesForLlmBoundary([projection.update], {
                inHistorySystemUpdates: true,
                appendOnlyRuntimeContext: true,
                includeTimestamp: false,
              }).filter((message) => message.role === "user"),
            ],
          };
        }
        options?.signal?.throwIfAborted();
        assertSteeringCurrent();
        input.assertHostActive?.();
        if (projection) {
          projection.commit();
          await input.persistToolResultProjections();
          options?.signal?.throwIfAborted();
          assertSteeringCurrent();
          input.assertHostActive?.();
        }
        const { tools, systemPrompt } = readRestoredContext();
        requestContext = { ...requestContext, tools, systemPrompt };
      }
      if (foregroundRequest && !primaryRequestObserved) {
        primaryRequestObserved = true;
        input.onPrimaryModelRequest?.(requestContext.tools ?? []);
      }
      // Real next model-call boundary: atomically install background material
      // after settled tool results, durable in the transcript, visible to this
      // dispatch and to the live loop context from the next turn on.
      latestRequest = { systemPrompt: requestContext.systemPrompt, tools: requestContext.tools };
      const turnContextCarriers =
        input.turnContextRunId && !activeSession.isCompacting
          ? drainAttemptTurnContextContributionsForModelRequest(input.turnContextRunId)
          : [];
      let submittedCarriers: readonly BackgroundContextCarrier[] = [];
      let contributionTokens = 0;
      if (turnContextCarriers.length > 0) {
        options?.signal?.throwIfAborted();
        assertSteeringCurrent();
        input.assertHostActive?.();
        // Token admission at the real append point: whole entries only, in
        // provider order, wrapping and hints included. History is never
        // truncated or compacted to make room; unfittable entries drop.
        const { admitted, rejected, tokens } = admitCarriers(
          turnContextCarriers,
          requestContext.messages,
        );
        markAttemptTurnContextCarriers(input.turnContextRunId, rejected, "dropped", "token-budget");
        if (admitted.length > 0) {
          if (!assertAttemptTurnContextCarriersCurrent(input.turnContextRunId, admitted)) {
            markAttemptTurnContextCarriers(
              input.turnContextRunId,
              admitted,
              "dropped",
              "authority-revoked",
            );
            return await baseStreamFn(model, requestContext, options);
          }
          const assertCurrent = () => {
            options?.signal?.throwIfAborted();
            assertSteeringCurrent();
            input.assertHostActive?.();
            if (!assertAttemptTurnContextCarriersCurrent(input.turnContextRunId, admitted)) {
              throw new Error("turn context source authority revoked");
            }
          };
          try {
            await installBackgroundContextCarriers({
              activeSession,
              carriers: admitted,
              assertCurrent,
            });
          } catch (error) {
            if (options?.signal?.aborted) {
              throw error;
            }
            markAttemptTurnContextCarriers(
              input.turnContextRunId,
              admitted,
              "dropped",
              "installation-failed-or-revoked",
            );
            return await baseStreamFn(model, requestContext, options);
          }
          // Re-assert after the install await: revoked material stays recorded in
          // the transcript but never joins the request or the live loop context.
          if (!assertAttemptTurnContextCarriersCurrent(input.turnContextRunId, admitted)) {
            markAttemptTurnContextCarriers(
              input.turnContextRunId,
              admitted,
              "dropped",
              "authority-revoked-after-install",
            );
            const stream = await baseStreamFn(model, requestContext, options);
            return stream;
          }
          markAttemptTurnContextCarriers(input.turnContextRunId, admitted, "installed");
          submittedCarriers = admitted;
          contributionTokens = tokens;
          // Terminal follow-ups already ride the loop context through their
          // session-queue delivery; re-splicing those would duplicate the block.
          for (const carrier of admitted) {
            if (!carrier.installed) {
              lateUpdates.push(carrier.message);
            }
          }
          // Mirror convertToLlm's custom→user projection so this dispatch sees the
          // same bytes the committed carrier produces on later calls; retention
          // drops the queued copy until its receipt rides the loop context.
          requestContext = {
            ...requestContext,
            messages: [
              ...requestContext.messages,
              ...admitted.map((carrier) => ({
                role: "user" as const,
                content:
                  typeof carrier.message.content === "string"
                    ? [{ type: "text" as const, text: carrier.message.content }]
                    : carrier.message.content,
                timestamp: carrier.message.timestamp,
              })),
            ],
          };
        }
      }
      let stream;
      try {
        stream = await baseStreamFn(model, requestContext, options);
      } catch (error) {
        markAttemptTurnContextCarriers(
          input.turnContextRunId,
          submittedCarriers,
          "uncertain",
          "provider-dispatch-failed",
        );
        throw error;
      }
      turnContextManager?.consumeContributionTokens(contributionTokens);
      // The dispatch handed the installed material to the provider request
      // owner; submitted proves submission, never model comprehension.
      markAttemptTurnContextCarriers(input.turnContextRunId, submittedCarriers, "submitted");
      const submissionReceipts = await recordBackgroundContextSubmission({
        activeSession,
        carriers: submittedCarriers,
      });
      // The receipt must ride the live loop context too: later dispatches drop
      // a persisted carrier as unsubmitted material until its receipt arrives.
      lateUpdates.push(...submissionReceipts);
      // Pre-prompt compaction has not consumed the deferred answer.
      if (foregroundRequest) {
        pendingSteering = undefined;
      }
      return stream;
    };
    const providerPromptStreamFn = wrapStreamFnWithMessageTransform(
      persistThenStream,
      (messages) => {
        const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(
          messages,
          input.contextTokenBudget,
          input.toolResultMaxChars,
          input.toolResultAggregateMaxChars,
          input.toolResultPromptProjectionState,
        );
        const providerMessages = providerPromptHistoryTruncation.messages;
        if (providerPromptHistoryTruncation.truncatedCount > 0) {
          declarePromptHistoryRewrite({ ...attempt, reason: "pruning" });
        }
        if (providerPromptHistoryTruncation.aggregateTruncatedCount > 0) {
          recordAggregateTruncation(attempt);
        }
        // Mark the current turn sent at provider dispatch so late media appends
        // instead of rewriting its prompt-cache slot (#99495).
        const recorder = attempt.userTurnTranscriptRecorder;
        const idempotencyKey = recorder?.message?.idempotencyKey;
        if (
          recorder &&
          (!idempotencyKey ||
            providerMessages.some(
              (message) =>
                message.role === "user" &&
                "idempotencyKey" in message &&
                message.idempotencyKey === idempotencyKey,
            ))
        ) {
          recorder.markSentToProvider?.();
        }
        return providerMessages;
      },
    );
    activeSession.agent.streamFn = providerPromptStreamFn;
    return () => {
      releaseTerminalAdmission?.();
      if (activeSession.agent.prepareNextTurnWithContext === prepareNextTurn) {
        activeSession.agent.prepareNextTurnWithContext = basePrepareNextTurn;
      }
      if (activeSession.agent.streamFn === providerPromptStreamFn) {
        activeSession.agent.streamFn = baseStreamFn;
      }
    };
  };

  input.onFinalPromptText(input.transcriptPrompt);
  input.trajectoryRecorder?.recordEvent("prompt.submitted", {
    prompt: input.modelPrompt,
    systemPrompt: input.systemPrompt,
    messages: activeSession.messages,
    imagesCount: input.images.length,
  });
  updateActiveEmbeddedRunSnapshot(attempt.sessionId, {
    transcriptLeafId: input.transcriptLeafId,
    messages: snapshotRecentMessages(activeSession.messages),
    inFlightPrompt: input.transcriptPrompt,
  });

  let captureCurrentPromptForModel = false;
  const cleanupModelPromptTransform = installModelPromptTransform({
    session: activeSession,
    transcriptPrompt: input.transcriptPrompt,
    modelPrompt: input.modelPrompt,
    prependContext: input.prependContext,
    appendContext: input.appendContext,
    shouldCapturePrompt: () => captureCurrentPromptForModel,
  });
  const armModelPromptTransform = (submitted: boolean) => {
    if (submitted) {
      captureCurrentPromptForModel = true;
    }
  };
  const promptOptions = {
    ...(!input.runtimeOnly && input.images.length > 0 ? { images: input.images } : {}),
    ...(persistedUserIdempotencyKey ? { persistedUserIdempotencyKey } : {}),
    preflightResult: armModelPromptTransform,
  };
  attachPromptCompactionRequestBudget(promptOptions, input.compactionRequestBudget);
  const cleanupProviderPromptHistoryTransform = installProviderPromptHistoryTransform();
  try {
    // Persist after the user (or synthetic runtime prompt), retiring unconsumed
    // context when preflight handles or rejects the prompt before the loop starts.
    const cleanupRuntimeContextMessage =
      input.appendOnlyRuntimeContext && input.runtimeContextMessage
        ? activeSession[agentSessionQueuePromptContext](input.runtimeContextMessage)
        : installRuntimeContextMessageForPrompt({
            session: activeSession,
            message: input.runtimeContextMessage,
            persistedUserIdempotencyKey,
          });
    try {
      await input.promptActiveSession(input.transcriptPrompt, promptOptions);
    } finally {
      cleanupRuntimeContextMessage();
    }
    if (input.leasedSteering) {
      await ackPendingAgentSteeringItems(input.leasedSteering);
      input.onSteeringAcknowledged();
    }
  } finally {
    cleanupProviderPromptHistoryTransform();
    cleanupModelPromptTransform();
  }
}

type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";

/** Classifies prompt submissions that have no visible current-turn content. */
export function resolvePromptSubmissionSkipReason(params: {
  prompt: string;
  messages: readonly unknown[];
  imageCount: number;
}): PromptSubmissionSkipReason | null {
  if (params.prompt.trim().length > 0 || params.imageCount > 0) {
    return null;
  }
  return params.messages.some(hasVisiblePromptHistory)
    ? "blank_user_prompt"
    : "empty_prompt_history_images";
}

function hasVisiblePromptHistory(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return false;
  }
  return hasNonEmptyContent(record.content);
}

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(hasNonEmptyContent);
  }
  if (!content || typeof content !== "object") {
    return false;
  }
  const record = content as { text?: unknown; content?: unknown };
  return hasNonEmptyContent(record.text) || hasNonEmptyContent(record.content);
}

/** Classifies prompt failures and performs yield or mid-turn recovery. */
type PromptErrorAttempt = Pick<EmbeddedRunAttemptParams, "runId" | "sessionId" | "abortSignal">;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type EmbeddedAttemptPromptErrorOutcome = {
  promptFailure?: {
    error: unknown;
    source: "prompt";
  };
};

export async function handleEmbeddedAttemptPromptError(input: {
  activeSession: AgentSession;
  attempt: PromptErrorAttempt;
  error: unknown;
  handleMidTurnPrecheckRequest: (request: MidTurnPrecheckRequest) => Promise<void>;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void | Promise<void>;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
}): Promise<EmbeddedAttemptPromptErrorOutcome> {
  const yieldAborted = input.yieldDetected && isSessionsYieldAbortError(input.error);
  if (yieldAborted) {
    // Publish terminal state before fallible recovery so outer cleanup still recognizes the yield.
    input.markYieldAborted();
  }
  await input.releaseLeasedSteering(input.error);
  if (yieldAborted) {
    await waitForEmbeddedAbortSettle({
      promise: input.yieldAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
      reason: "sessions_yield",
    });
    await input.withOwnedTranscriptWrite(async () => {
      const transcriptRewritten = await withSessionManagerWrite(
        input.activeSession.sessionManager,
        () => stripSessionsYieldArtifacts(input.activeSession),
      );
      if (input.yieldMessage) {
        await input.activeSession.sendCustomMessage(
          buildSessionsYieldContextMessage(input.yieldMessage),
          { triggerTurn: false },
        );
      }
      const target = transcriptRewritten && input.activeSession.sessionManager.getSessionTarget();
      if (target) {
        // Yield cleanup owns this rewrite; settle its projection before handing off the lane.
        // The caller signal stays live during a deliberate sessions_yield provider abort.
        const { waitForSessionTranscriptProjection } =
          await import("../../../config/sessions/session-transcript-reconcile.js");
        await waitForSessionTranscriptProjection(target, input.attempt.abortSignal);
      }
    });
    return {};
  }

  if (isMidTurnPrecheckSignal(input.error)) {
    const request = input.error.request;
    await input.withOwnedTranscriptWrite(() =>
      withSessionManagerWrite(input.activeSession.sessionManager, () =>
        input.handleMidTurnPrecheckRequest(request),
      ),
    );
    return {};
  }

  return {
    promptFailure: {
      error: input.error,
      source: "prompt",
    },
  };
}
