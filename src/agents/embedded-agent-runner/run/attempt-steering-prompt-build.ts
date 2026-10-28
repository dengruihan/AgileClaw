import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { HookRunner } from "../../../plugins/hooks.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import type { AgentEvent } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import { getSteeringMessageIdentity } from "../../sessions/steering-message-identity.js";
import type { EmbeddedAgentQueueMessageOptions } from "../runs.js";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import { runEmbeddedAttemptAuthorizedPromptBuild } from "./attempt-authorized-prompt-build.js";
import {
  getAttemptTurnContextManager,
  rotateAttemptTurnContextForSteeringInput,
} from "./attempt-turn-context.js";
import {
  appendCurrentInboundContext,
  attachSteeringRuntimeContext,
  getSteeringRuntimeContext,
} from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PendingSteeringInput = {
  text: string;
  inputId?: string;
  assertCurrent?: () => void;
  admit: () => void;
  canceled: boolean;
  release: () => void;
};

/** Owns post-policy enrichment for exact accepted steering queue identities. */
export function createEmbeddedAttemptSteeringPromptBuild(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  hookRunner: HookRunner | null | undefined;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  runAbortSignal: AbortSignal;
  readCallableToolNames?: () => readonly string[];
  isCurrent: () => boolean;
}) {
  const { attempt, activeSession, hookRunner } = input;
  const pendingInputs = new Map<string, PendingSteeringInput>();
  let unsubscribe: (() => void) | undefined;
  const prepareConsumedInput = async (event: AgentEvent, signal: AbortSignal) => {
    if (
      (event.type !== "message_start" && event.type !== "message_end") ||
      event.message.role !== "user"
    ) {
      return;
    }
    const identity = getSteeringMessageIdentity(event.message);
    const pending = identity ? pendingInputs.get(identity) : undefined;
    if (!identity || !pending) {
      return;
    }
    if (event.type === "message_end") {
      pending.release();
      pendingInputs.delete(identity);
      return;
    }
    pending.admit();
    if (!pending.inputId || !hookRunner || !attempt.toolAuthorityFingerprint) {
      return;
    }
    const isSameInput = () => {
      const manager = getAttemptTurnContextManager(attempt.runId);
      return !manager || manager.currentInputId === pending.inputId;
    };
    if (pending.canceled || !isSameInput()) {
      return;
    }
    const assertRunActive = resolveAdmittedRunActiveAssertion(
      attempt.admittedRunContext,
      input.runAbortSignal,
    );
    const assertInputActive = () => {
      signal.throwIfAborted();
      input.runAbortSignal.throwIfAborted();
      pending.assertCurrent?.();
      assertRunActive?.();
      if (!input.isCurrent() || pending.canceled || !isSameInput()) {
        throw new Error("steering prompt preparation is no longer current");
      }
    };
    assertInputActive();
    const hookCtx = {
      ...buildEmbeddedAgentHookContext(
        { ...attempt, trigger: "user" },
        input.hookAgentId,
        freezeDiagnosticTraceContext(input.diagnosticTrace),
      ),
      activeProjectKeys: [...(attempt.preparedModelRuntime?.activeProjectKeys ?? [])],
      modelProviderId: attempt.model.provider,
      modelId: attempt.model.id,
    };
    const messages = activeSession.messages.includes(event.message)
      ? activeSession.messages
      : [...activeSession.messages, event.message];
    const result = await runEmbeddedAttemptAuthorizedPromptBuild({
      hookRunner,
      hookCtx,
      event: {
        prompt: pending.text,
        currentUserMessage: pending.text,
        currentUserMessageId: pending.inputId,
        messages,
      },
      activeSession,
      runId: attempt.runId,
      inputId: pending.inputId,
      toolAuthorityFingerprint: attempt.toolAuthorityFingerprint,
      activeToolNames: input.readCallableToolNames?.() ?? activeSession.getActiveToolNames(),
      readCallableToolNames: input.readCallableToolNames,
      assertHostActive: assertInputActive,
      runAbortSignal: input.runAbortSignal,
    }).catch((error: unknown) => {
      // Another accepted input may supersede B while its hook awaits. Retire B
      // enrichment and keep the core loop available to consume the successor.
      signal.throwIfAborted();
      input.runAbortSignal.throwIfAborted();
      assertRunActive?.();
      if (input.isCurrent() && (pending.canceled || !isSameInput())) {
        return undefined;
      }
      throw error;
    });
    if (pending.canceled || !isSameInput()) {
      return;
    }
    assertInputActive();
    const fragments = [result?.prependContext, result?.appendContext]
      .filter((text): text is string => Boolean(text?.trim()))
      .map((text) => ({ kind: "runtime-instruction" as const, text }));
    if (fragments.length > 0) {
      const existing = getSteeringRuntimeContext(event.message);
      // The steering context owner materializes this carrier beside B and
      // persists it before B at message_end, preserving accepted user bytes.
      attachSteeringRuntimeContext(
        event.message,
        appendCurrentInboundContext(
          existing ? { text: existing.content, fragments: existing.details.fragments } : undefined,
          fragments,
        ),
      );
    }
  };
  return {
    trackInput(
      text: string,
      options: EmbeddedAgentQueueMessageOptions | undefined,
      assertCurrent?: () => void,
    ) {
      const queueIdentity = options?.queueIdentity ?? crypto.randomUUID();
      const inputId = options?.userTurnTranscriptRecorder?.getAdmissionReceipt()?.logicalTurnId;
      const canPrepare = Boolean(inputId && hookRunner && attempt.toolAuthorityFingerprint);
      let admitted = false;
      const admit = () => {
        if (admitted) {
          return;
        }
        admitted = true;
        rotateAttemptTurnContextForSteeringInput(attempt.runId, inputId);
      };
      const pending: PendingSteeringInput = {
        text,
        inputId,
        assertCurrent,
        admit,
        canceled: false,
        release: () => options?.abortSignal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        pending.canceled = true;
        const manager = getAttemptTurnContextManager(attempt.runId);
        if (inputId && manager?.currentInputId === inputId) {
          manager.closeForSteeringInput();
        }
      };
      // Admission-only receipts transfer cancellation to the receiving run;
      // only a caller still waiting for B's commit retains its abort signal.
      if (canPrepare && options?.waitForTranscriptCommit === true) {
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (options.abortSignal?.aborted) {
          onAbort();
        }
      }
      if (canPrepare) {
        pendingInputs.set(queueIdentity, pending);
      }
      if (!unsubscribe && canPrepare) {
        // Core listeners are awaited after the session's message_start handler.
        // Preparation finishes before persistence, a tool launch or model call.
        unsubscribe = activeSession.agent.subscribe(prepareConsumedInput);
      }
      return {
        queueIdentity,
        steer: async (...args: Parameters<AgentSession["steer"]>) => {
          await activeSession.steer(...args);
          // Rejected steering and ask_user claims never reach this admission.
          admit();
        },
        releaseUnadmitted: () => {
          if (!admitted) {
            pending.release();
            pendingInputs.delete(queueIdentity);
          }
        },
      };
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const pending of pendingInputs.values()) {
        pending.release();
      }
      pendingInputs.clear();
    },
  };
}
