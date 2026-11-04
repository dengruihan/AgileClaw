import type {
  TurnContextAttachOptions,
  TurnContextContributionsHost,
  TurnContextSource,
  TurnContextSourceScope,
} from "../../../plugins/hook-agent-context.types.js";
import type { AgentEvent } from "../../runtime/index.js";
import type { CustomMessage } from "../../sessions/messages.js";
import { TURN_CONTEXT_CUSTOM_TYPE } from "./attempt-turn-context-carriers.js";
import type { BackgroundContextCarrier } from "./attempt-turn-context-carriers.js";
import {
  createTurnContextManager,
  type TurnContextManager,
} from "./attempt-turn-context-manager.js";
import type { TurnContextReceiptStatus } from "./attempt-turn-context-receipts.js";
export {
  TURN_CONTEXT_CUSTOM_TYPE,
  type BackgroundContextCarrier,
  installBackgroundContextCarriers,
} from "./attempt-turn-context-carriers.js";
export { MAX_TURN_CONTEXT_CONTRIBUTION_CHARS } from "./attempt-turn-context-manager.js";
const managerRegistry = new Map<string, TurnContextManager>();

export function getAttemptTurnContextManager(
  runId: string | undefined,
): TurnContextManager | undefined {
  if (!runId) {
    return undefined;
  }
  return managerRegistry.get(runId);
}

/**
 * Consumption-side authority guard for follow-up delivered material. When the
 * loop is about to consume a background-context carrier whose source authority
 * died after the terminal decision sent it, the guard drops the carrier and
 * cancels the still-queued follow-up: the loop's post-message-start
 * cancellation checkpoint then ends the turn without a wasted model call.
 * Session-level message_start handlers settle before this agent-level listener.
 */
export function observeAttemptTurnContextCarrierConsumption(params: {
  runId: string | undefined;
  agent: {
    subscribe?(listener: (event: AgentEvent) => Promise<void> | void): () => void;
    cancelFollowUpMessage?(predicate: (message: unknown) => boolean): unknown;
  };
}): () => void {
  // Harness sessions without the full agent surface never queue follow-ups.
  if (!params.runId || typeof params.agent.subscribe !== "function") {
    return () => {};
  }
  const runId = params.runId;
  return params.agent.subscribe((event) => {
    if (event.type !== "message_start") {
      return;
    }
    const message = event.message as {
      role?: unknown;
      customType?: unknown;
      details?: unknown;
    };
    if (message.role !== "custom" || message.customType !== TURN_CONTEXT_CUSTOM_TYPE) {
      return;
    }
    const details =
      message.details && typeof message.details === "object"
        ? (message.details as Record<string, unknown>)
        : undefined;
    const pluginKey = details?.pluginKey;
    const contributionId = details?.contributionId;
    const inputId = details?.inputId;
    if (
      typeof pluginKey !== "string" ||
      typeof contributionId !== "string" ||
      typeof inputId !== "string"
    ) {
      return;
    }
    const manager = getAttemptTurnContextManager(runId);
    if (!manager) {
      return;
    }
    const carrier = { pluginKey, contributionId, inputId };
    if (manager.assertSourcesCurrent([carrier])) {
      return;
    }
    manager.revokeCarriers([carrier]);
    params.agent.cancelFollowUpMessage?.((pending) => pending === message);
  });
}

/**
 * Returns the run's contribution owner, rotating to the admitted input identity.
 * Retries of the same input reuse their state and budgets; a new identity
 * closes the previous input. No capacity eviction: active owners are released
 * only by run settlement or run abort.
 */
export function ensureAttemptTurnContextManager(
  runId: string | undefined,
  inputId: string | undefined,
  runAbortSignal?: AbortSignal,
): TurnContextManager | undefined {
  if (!runId || !inputId) {
    return undefined;
  }
  const existing = managerRegistry.get(runId);
  if (existing) {
    existing.rotateInput(inputId);
    return existing;
  }
  const manager = createTurnContextManager(runId, inputId);
  managerRegistry.set(runId, manager);
  if (runAbortSignal) {
    const onAbort = () => {
      // Compare-and-release: a successor's registration survives this handler.
      if (managerRegistry.get(runId) === manager) {
        managerRegistry.delete(runId);
      }
      void manager.dispose("run-abort");
    };
    if (runAbortSignal.aborted) {
      onAbort();
      return undefined;
    }
    runAbortSignal.addEventListener("abort", onAbort, { once: true });
  }
  return manager;
}

/** Final release at run settlement; retries of the same run keep their manager until here. */
export async function forgetAttemptTurnContextManager(runId: string | undefined): Promise<void> {
  if (!runId) {
    return;
  }
  const manager = managerRegistry.get(runId);
  managerRegistry.delete(runId);
  await manager?.dispose("run-settled");
}

export function hasAttemptTurnContextSources(runId: string | undefined): boolean {
  if (!runId) {
    return false;
  }
  return managerRegistry.has(runId);
}

/** Boundary consumption for one provider dispatch; a batch is taken exactly once. */
export function drainAttemptTurnContextContributionsForModelRequest(
  runId: string | undefined,
): BackgroundContextCarrier[] {
  return getAttemptTurnContextManager(runId)?.drainForModelRequest() ?? [];
}

/** Post-await authority re-check for a drained batch before it joins a request. */
export function assertAttemptTurnContextCarriersCurrent(
  runId: string | undefined,
  carriers: readonly BackgroundContextCarrier[],
): boolean {
  if (carriers.length === 0) {
    return true;
  }
  const manager = getAttemptTurnContextManager(runId);
  if (!manager) {
    return false;
  }
  return manager.assertSourcesCurrent(carriers);
}

/** A steering admission closes the run's previous input sidecar state. */
export function closeAttemptTurnContextForSteeringInput(runId: string | undefined): void {
  getAttemptTurnContextManager(runId)?.closeForSteeringInput();
}

/**
 * A steering admission with a real input identity rotates the run's sidecar to
 * that input: the previous input's sources close, and the steered input's own
 * preparation boundary may attach a fresh source. Without an identity the
 * previous input simply closes; no guessed identity is created.
 */
export function rotateAttemptTurnContextForSteeringInput(
  runId: string | undefined,
  inputId: string | undefined,
): void {
  const manager = getAttemptTurnContextManager(runId);
  if (!manager) {
    if (inputId) {
      ensureAttemptTurnContextManager(runId, inputId);
    }
    return;
  }
  if (inputId && inputId !== manager.currentInputId) {
    manager.rotateInput(inputId);
    return;
  }
  if (!inputId) {
    manager.closeForSteeringInput();
  }
}

/** Records a delivery transition for drained carriers of the run's live sources. */
export function markAttemptTurnContextCarriers(
  runId: string | undefined,
  carriers: readonly BackgroundContextCarrier[],
  status: "installed" | "submitted" | "uncertain" | "dropped",
  reason?: string,
): void {
  if (carriers.length === 0) {
    return;
  }
  getAttemptTurnContextManager(runId)?.markCarriers(carriers, status, reason);
}

/** Per-status receipt counts for the run; missing managers report zeros. */
export function readAttemptTurnContextReceiptCounts(
  runId: string | undefined,
): Record<TurnContextReceiptStatus, number> {
  return (
    getAttemptTurnContextManager(runId)?.receiptCounts() ?? {
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 0,
      uncertain: 0,
      dropped: 0,
    }
  );
}

/** Natural-end gate used by the stream terminal owner; at most one decision per input. */
export async function resolveAttemptTurnContextTerminalContinuation(params: {
  runId: string | undefined;
  canContinue: () => boolean;
  sendFollowUp: (messages: CustomMessage[]) => Promise<void>;
}): Promise<"continue" | "finalize"> {
  const manager = getAttemptTurnContextManager(params.runId);
  if (!manager) {
    return "finalize";
  }
  return await manager.resolveTerminalContinuation({
    canContinue: params.canContinue,
    sendFollowUp: params.sendFollowUp,
  });
}

/** Text observation wired from the assistant stream chokepoint. */
export function observeAttemptTurnContextAssistantText(
  runId: string | undefined,
  event: { text: string; kind: "append" | "replace" },
): void {
  getAttemptTurnContextManager(runId)?.observeAssistantText(event);
}

/**
 * Builds the plugin-facing attach capability for the authorized prompt-build
 * phase. Authority binds to the admitted run: abort signal, admitted-run
 * assertion, and the turn's memory audience check.
 */
export function createAttemptTurnContextContributionsCapability(params: {
  eligible: boolean;
  runId: string | undefined;
  /** Admitted-input identity from the turn admission receipt, not a guess. */
  inputId: string | undefined;
  runAbortSignal?: AbortSignal;
  assertHostActive?: () => void;
  assertMemoryAudienceCurrent?: () => void;
  allowsTool?: (name: string) => boolean;
}): TurnContextContributionsHost | undefined {
  if (!params.eligible || !params.inputId) {
    return undefined;
  }
  const boundInputId = params.inputId;
  const manager = params.runId
    ? (managerRegistry.get(params.runId) ??
      ensureAttemptTurnContextManager(params.runId, boundInputId, params.runAbortSignal))
    : undefined;
  if (!manager) {
    return undefined;
  }
  const assertAuthority = () => {
    params.runAbortSignal?.throwIfAborted();
    params.assertHostActive?.();
    params.assertMemoryAudienceCurrent?.();
  };
  return {
    attach: (
      options: TurnContextAttachOptions,
      factory: (scope: TurnContextSourceScope) => TurnContextSource,
    ) =>
      manager.attach(
        {
          key: options.key,
          inputId: boundInputId,
          terminalWaitMs: options.terminalWaitMs,
          maxFinalContinuations: options.maxFinalContinuations,
          signal: options.signal,
          assertAuthority: () => {
            assertAuthority();
            options.signal?.throwIfAborted();
            options.assertCurrent?.();
            if (options.requiredTools?.some((name) => !params.allowsTool?.(name))) {
              throw new Error("turn context source requires tools no longer available");
            }
          },
        },
        factory,
      ),
  };
}

/**
 * Natural-end continuation decision for the stream terminal owner. Live guard
 * probes are re-evaluated after the flush; the follow-up sender is called once
 * with the full carrier batch.
 */
export async function decideAttemptTurnContextContinuation(params: {
  runId: string | undefined;
  isAborted: () => boolean;
  isProviderRefusal: () => boolean;
  lastAssistantStopReason: () => string | undefined;
  hasPendingContinuation: boolean;
  isAdmissionClosed: () => boolean;
  hasQueuedInput: () => boolean;
  isCurrentRun: () => boolean;
  sendCustomFollowUp: (message: CustomMessage) => Promise<void>;
}): Promise<"continue" | "finalize"> {
  if (!hasAttemptTurnContextSources(params.runId)) {
    return "finalize";
  }
  const decision = await resolveAttemptTurnContextTerminalContinuation({
    runId: params.runId,
    canContinue: () =>
      params.lastAssistantStopReason() === "stop" &&
      !params.isProviderRefusal() &&
      !params.hasPendingContinuation &&
      !params.isAborted() &&
      !params.isAdmissionClosed() &&
      !params.hasQueuedInput() &&
      params.isCurrentRun(),
    sendFollowUp: async (messages) => {
      for (const message of messages) {
        await params.sendCustomFollowUp(message);
      }
    },
  });
  return decision;
}
