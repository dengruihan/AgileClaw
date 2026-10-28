import type {
  TurnContextSource,
  TurnContextSourceScope,
} from "../../../plugins/hook-agent-context.types.js";
import type { CustomMessage } from "../../sessions/messages.js";
import { log } from "../logger.js";
import {
  MAX_INPUT_CONTRIBUTION_TOKENS,
  buildCarrierMessage,
  type BackgroundContextCarrier,
} from "./attempt-turn-context-carriers.js";
/**
 * Host owner for per-input background material contributions.
 *
 * Sources attach during the authorized prompt-build phase and publish bounded
 * material. The host installs accepted material at the real next model-call
 * boundary (provider dispatch), and at the natural-end gate may request one
 * same-turn continuation for material no model call has consumed yet. Core
 * stays generic: it only knows contributions, budgets, boundaries, cleanup.
 */
import {
  TURN_CONTEXT_RECEIPT_STATUSES,
  createTurnContextReceiptLedger,
  type TurnContextReceiptLedger,
  type TurnContextReceiptStatus,
} from "./attempt-turn-context-receipts.js";

/** Hard per-contribution cap; sources enforce their own finer budgets upstream. */
export const MAX_TURN_CONTEXT_CONTRIBUTION_CHARS = 4_000;
/** Queued-but-unconsumed contributions kept per source; excess is rejected. */
const MAX_QUEUED_PER_SOURCE = 8;
/** Total contributions accepted per source per input. */
const MAX_CONTRIBUTIONS_PER_SOURCE = 16;
export const MAX_TURN_CONTEXT_TERMINAL_WAIT_MS = 10_000;
export const MAX_TURN_CONTEXT_FINAL_CONTINUATIONS = 1;
/** Sources get a bounded window to settle their own disposal. */
const DISPOSE_SETTLE_MS = 500;

type QueuedContribution = { id: string; text: string };

type AttachedSource = {
  key: string;
  /** Input this source was admitted for; a rotated input closes it. */
  inputId: string;
  source: TurnContextSource;
  controller: AbortController;
  assertAuthority: () => void;
  terminalWaitMs: number;
  maxFinalContinuations: number;
  finalContinuationsUsed: number;
  /** Accepted here and not yet consumed by a model-request boundary. */
  queued: Map<string, QueuedContribution>;
  receipts: TurnContextReceiptLedger;
  installed: Map<string, BackgroundContextCarrier>;
  acceptedIds: Set<string>;
  acceptedCount: number;
  /** Continuation consumed or terminal gate completed; no further extraction input. */
  stopped: boolean;
};

type TerminalOutcome = "continue" | "finalize";

export type TurnContextManager = {
  readonly runId: string;
  /** Identity of the admitted input this manager currently serves. */
  readonly currentInputId: string;
  attach(
    options: {
      key: string;
      /** Admitted-input identity the attach belongs to; mismatch rejects. */
      inputId?: string;
      terminalWaitMs?: number;
      maxFinalContinuations?: number;
      assertAuthority: () => void;
      signal?: AbortSignal;
    },
    factory: (scope: TurnContextSourceScope) => TurnContextSource,
  ): { status: "attached" | "already-attached" | "unsupported" };
  observeAssistantText(event: { text: string; kind: "append" | "replace" }): void;
  /** Atomically takes one batch for a provider dispatch; marks it consumed. */
  drainForModelRequest(): BackgroundContextCarrier[];
  /** Post-await re-check for an installed batch before it joins a request. */
  assertSourcesCurrent(carriers: readonly { pluginKey: string; inputId: string }[]): boolean;
  remainingContributionTokens(): number;
  consumeContributionTokens(tokens: number): void;
  bindTerminalAdmission(
    admit: (carriers: BackgroundContextCarrier[]) => Promise<BackgroundContextCarrier[]>,
  ): () => void;
  /** A newly admitted steering input closes the previous input's sources. */
  closeForSteeringInput(): void;
  /** Rotates to a newly admitted input identity; the old input closes. */
  rotateInput(inputId: string): void;
  /** Records a delivery transition for drained carriers of live sources. */
  markCarriers(
    carriers: readonly { pluginKey: string; contributionId: string; inputId: string }[],
    status: TurnContextReceiptStatus,
    reason?: string,
  ): void;
  /** Drops revoked carriers and stops their sources before a follow-up is consumed. */
  revokeCarriers(
    carriers: readonly { pluginKey: string; contributionId: string; inputId: string }[],
  ): void;
  /** Per-status receipt counts for diagnostics; stale entries excluded. */
  receiptCounts(): Record<TurnContextReceiptStatus, number>;
  /** Natural-end gate: bounded flush, then continuation decision. Runs at most once. */
  resolveTerminalContinuation(guards: {
    canContinue: () => boolean;
    sendFollowUp: (messages: CustomMessage[]) => Promise<void>;
  }): Promise<TerminalOutcome>;
  dispose(reason: string): Promise<void>;
};

const settleWithTimeout = async (work: Promise<void>, label: string, timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    log.debug(`turn-context: ${label} failed during settlement: ${String(error)}`);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export function createTurnContextManager(
  runId: string,
  initialInputId: string,
): TurnContextManager {
  const sources = new Map<string, AttachedSource>();
  let disposed = false;
  let terminalResolved = false;
  /** Identity of the admitted input this manager currently serves. */
  let currentInputId = initialInputId;
  let contributionTokensUsed = 0;
  const retiredCounts: Record<TurnContextReceiptStatus, number> = {
    queued: 0,
    leased: 0,
    installed: 0,
    submitted: 0,
    uncertain: 0,
    dropped: 0,
  };
  const pendingDisposals = new Set<Promise<void>>();
  let terminalAdmission:
    | ((carriers: BackgroundContextCarrier[]) => Promise<BackgroundContextCarrier[]>)
    | undefined;
  const assertOpen = () => {
    if (disposed) {
      throw new Error("turn context contributions are closed for this input");
    }
  };
  const stopSource = (attached: AttachedSource, publishClosed: boolean) => {
    attached.stopped = true;
    if (publishClosed && !attached.controller.signal.aborted) {
      // Closing the scope signal stops timers and in-flight reads; later
      // publishes must observe `closed`, which the abort also proves.
      attached.controller.abort(new Error("turn context source stopped"));
    }
  };
  const disposeSource = (attached: AttachedSource) => {
    stopSource(attached, true);
    const work = (async () => {
      await attached.source.dispose();
    })().catch((error: unknown) => {
      log.debug(`turn-context: source disposal failed key=${attached.key}: ${String(error)}`);
    });
    pendingDisposals.add(work);
    void work.finally(() => pendingDisposals.delete(work));
    return work;
  };
  const retireSources = () => {
    for (const attached of sources.values()) {
      attached.receipts.dropPending("input-closed");
      attached.queued.clear();
      attached.installed.clear();
      const counts = attached.receipts.counts();
      for (const status of TURN_CONTEXT_RECEIPT_STATUSES) {
        retiredCounts[status] += counts[status];
      }
      void disposeSource(attached);
    }
    sources.clear();
  };
  const manager: TurnContextManager = {
    runId,
    get currentInputId() {
      return currentInputId;
    },
    remainingContributionTokens: () =>
      Math.max(0, MAX_INPUT_CONTRIBUTION_TOKENS - contributionTokensUsed),
    consumeContributionTokens(tokens) {
      contributionTokensUsed += tokens;
    },
    bindTerminalAdmission(admit) {
      terminalAdmission = admit;
      return () => {
        if (terminalAdmission === admit) {
          terminalAdmission = undefined;
        }
      };
    },
    attach(options, factory) {
      if (disposed || terminalResolved) {
        return { status: "unsupported" };
      }
      const key = options.key.trim();
      if (!key) {
        return { status: "unsupported" };
      }
      if (options.inputId !== undefined && options.inputId !== currentInputId) {
        // A rotated-away input cannot attach into or re-enable on the current one.
        return { status: "unsupported" };
      }
      const existing = sources.get(key);
      if (existing && existing.inputId === currentInputId) {
        return { status: "already-attached" };
      }
      if (existing) {
        return { status: "unsupported" };
      }
      let source: TurnContextSource;
      const attached: AttachedSource = {
        key,
        inputId: currentInputId,
        get source() {
          return source;
        },
        controller: new AbortController(),
        assertAuthority: options.assertAuthority,
        terminalWaitMs: Math.min(
          Math.max(Math.floor(options.terminalWaitMs ?? 2_000), 0),
          MAX_TURN_CONTEXT_TERMINAL_WAIT_MS,
        ),
        maxFinalContinuations: Math.min(
          Math.max(Math.floor(options.maxFinalContinuations ?? 1), 0),
          MAX_TURN_CONTEXT_FINAL_CONTINUATIONS,
        ),
        finalContinuationsUsed: 0,
        queued: new Map(),
        receipts: createTurnContextReceiptLedger(),
        installed: new Map(),
        acceptedIds: new Set(),
        acceptedCount: 0,
        stopped: false,
      };
      const scope: TurnContextSourceScope = {
        signal: attached.controller.signal,
        assertCurrent() {
          assertOpen();
          attached.controller.signal.throwIfAborted();
          if (attached.inputId !== currentInputId) {
            throw new Error("turn context source no longer belongs to the current input");
          }
          options.assertAuthority();
        },
        publish(contribution: { id: string; text: string }) {
          // Closure is a status, not an error: late callbacks observe it and stop.
          if (
            disposed ||
            terminalResolved ||
            attached.stopped ||
            attached.inputId !== currentInputId
          ) {
            return { status: "closed" as const };
          }
          options.assertAuthority();
          const id = contribution.id.trim();
          const text = contribution.text;
          if (!id || !text.trim()) {
            return { status: "budget-exceeded" as const };
          }
          if (attached.acceptedIds.has(id)) {
            return { status: "duplicate" as const };
          }
          if (
            attached.acceptedCount >= MAX_CONTRIBUTIONS_PER_SOURCE ||
            text.length > MAX_TURN_CONTEXT_CONTRIBUTION_CHARS
          ) {
            return { status: "budget-exceeded" as const };
          }
          // The boundary consumes a whole batch; cap what can wait at once.
          if (attached.queued.size >= MAX_QUEUED_PER_SOURCE) {
            return { status: "budget-exceeded" as const };
          }
          attached.acceptedIds.add(id);
          attached.acceptedCount += 1;
          attached.queued.set(id, { id, text });
          attached.receipts.recordQueued(id);
          return { status: "queued" as const, id };
        },
      };
      try {
        source = factory(scope);
      } catch (error) {
        log.warn(`turn-context: source factory failed key=${key} runId=${runId}: ${String(error)}`);
        attached.controller.abort(new Error("turn context source factory failed"));
        return { status: "unsupported" };
      }
      sources.set(key, attached);
      if (options.signal) {
        const close = () => {
          attached.receipts.dropPending("source-closed");
          attached.queued.clear();
          attached.installed.clear();
          void disposeSource(attached);
        };
        options.signal.addEventListener("abort", close, { once: true });
        attached.controller.signal.addEventListener(
          "abort",
          () => options.signal?.removeEventListener("abort", close),
          { once: true },
        );
        if (options.signal.aborted) {
          close();
        }
      }
      return { status: "attached" };
    },
    observeAssistantText(event) {
      if (disposed) {
        return;
      }
      for (const attached of sources.values()) {
        if (attached.stopped || !attached.source.onAssistantText) {
          continue;
        }
        try {
          attached.source.onAssistantText(event);
        } catch (error) {
          log.debug(
            `turn-context: onAssistantText failed key=${attached.key} runId=${runId}: ${String(error)}`,
          );
        }
      }
    },
    drainForModelRequest() {
      if (disposed) {
        return [];
      }
      const carriers: BackgroundContextCarrier[] = [];
      for (const attached of sources.values()) {
        carriers.push(...attached.installed.values());
        attached.installed.clear();
      }
      for (const attached of sources.values()) {
        if (attached.queued.size === 0) {
          continue;
        }
        try {
          // The batch is a lease on live authority: revoked material never
          // reaches the model-request boundary.
          attached.assertAuthority();
        } catch (error) {
          attached.receipts.dropPending("authority-revoked");
          attached.queued.clear();
          stopSource(attached, true);
          log.debug(
            `turn-context: dropped revoked batch key=${attached.key} runId=${runId}: ${String(error)}`,
          );
          continue;
        }
        const batch = [...attached.queued.values()];
        attached.queued.clear();
        for (const contribution of batch) {
          attached.receipts.transition(contribution.id, "leased");
          carriers.push({
            message: buildCarrierMessage(attached.key, attached.inputId, contribution, false),
            inputId: attached.inputId,
            pluginKey: attached.key,
            contributionId: contribution.id,
          });
        }
      }
      return carriers;
    },
    /** Post-await re-check for an installed batch before it joins a request. */
    assertSourcesCurrent(carriers: readonly { pluginKey: string; inputId: string }[]): boolean {
      if (disposed) {
        return false;
      }
      for (const carrier of carriers) {
        const attached = sources.get(carrier.pluginKey);
        if (
          !attached ||
          attached.inputId !== carrier.inputId ||
          attached.inputId !== currentInputId
        ) {
          return false;
        }
        try {
          attached.assertAuthority();
        } catch {
          return false;
        }
      }
      return true;
    },
    /** A newly admitted steering input closes the previous input's sources. */
    closeForSteeringInput() {
      if (disposed) {
        return;
      }
      retireSources();
      // The steered input has no authorized prompt-build attach point; the
      // previous input's state must not leak into it.
      terminalResolved = true;
    },
    /** Rotates to a newly admitted input identity; the old input closes. */
    rotateInput(inputId: string) {
      if (disposed || inputId === currentInputId) {
        return;
      }
      retireSources();
      currentInputId = inputId;
      contributionTokensUsed = 0;
      terminalResolved = false;
    },
    markCarriers(carriers, status, reason) {
      for (const carrier of carriers) {
        const attached = sources.get(carrier.pluginKey);
        if (attached && attached.inputId === carrier.inputId) {
          attached.receipts.transition(carrier.contributionId, status, reason);
        }
      }
    },
    revokeCarriers(carriers) {
      for (const carrier of carriers) {
        const attached = sources.get(carrier.pluginKey);
        if (!attached || attached.inputId !== carrier.inputId) {
          continue;
        }
        attached.receipts.transition(carrier.contributionId, "dropped", "authority-revoked");
        attached.queued.delete(carrier.contributionId);
        attached.installed.delete(carrier.contributionId);
        stopSource(attached, true);
      }
    },
    receiptCounts() {
      const counts = { ...retiredCounts };
      for (const attached of sources.values()) {
        const sourceCounts = attached.receipts.counts();
        for (const status of TURN_CONTEXT_RECEIPT_STATUSES) {
          counts[status] += sourceCounts[status];
        }
      }
      return counts;
    },
    async resolveTerminalContinuation(guards) {
      if (disposed || terminalResolved) {
        return "finalize";
      }
      // The gate owns the single serialization point: flush first, then decide
      // on whatever is queued, so a late publish during flush is still counted.
      const decidingInput = currentInputId;
      const flushable = [...sources.values()].filter(
        (attached) => attached.maxFinalContinuations > attached.finalContinuationsUsed,
      );
      const deadlineAt =
        Date.now() + Math.max(0, ...flushable.map((attached) => attached.terminalWaitMs), 0);
      if (flushable.length > 0) {
        await Promise.all(
          flushable.map(async (attached) => {
            try {
              await settleWithTimeout(
                Promise.resolve(attached.source.flush(deadlineAt)),
                `flush key=${attached.key}`,
                Math.max(0, deadlineAt - Date.now()),
              );
            } catch (error) {
              log.debug(
                `turn-context: flush failed key=${attached.key} runId=${runId}: ${String(error)}`,
              );
            }
          }),
        );
      }
      if (disposed || currentInputId !== decidingInput || terminalResolved) {
        return "finalize";
      }
      // After the decision, no late callback may inject into a later input:
      // stop every source and drop material that no continuation will deliver.
      terminalResolved = true;
      const closeAll = () => {
        for (const attached of sources.values()) {
          for (const contributionId of attached.queued.keys()) {
            attached.receipts.transition(contributionId, "dropped", "terminal-closed");
          }
          attached.queued.clear();
          stopSource(attached, true);
        }
      };
      const pending: Array<{
        attached: AttachedSource;
        contribution: QueuedContribution;
      }> = [];
      for (const attached of sources.values()) {
        if (
          attached.queued.size === 0 ||
          attached.maxFinalContinuations <= attached.finalContinuationsUsed
        ) {
          continue;
        }
        for (const contribution of attached.queued.values()) {
          pending.push({ attached, contribution });
        }
      }
      if (pending.length === 0) {
        closeAll();
        return "finalize";
      }
      if (!guards.canContinue()) {
        closeAll();
        return "finalize";
      }
      // Re-assert every contributing source's live authority right before the
      // follow-up installs; a revoked source's material must not wake the turn.
      const livePending = pending.filter(({ attached }) => {
        try {
          attached.assertAuthority();
          return true;
        } catch {
          return false;
        }
      });
      if (livePending.length === 0) {
        closeAll();
        return "finalize";
      }
      const candidates = livePending.map(({ attached, contribution }, index) => ({
        message: buildCarrierMessage(
          attached.key,
          attached.inputId,
          contribution,
          index === livePending.length - 1,
        ),
        pluginKey: attached.key,
        inputId: attached.inputId,
        contributionId: contribution.id,
      }));
      const admitted = terminalAdmission ? await terminalAdmission(candidates) : candidates;
      if (disposed || currentInputId !== decidingInput) {
        return "finalize";
      }
      if (
        admitted.length === 0 ||
        !guards.canContinue() ||
        !manager.assertSourcesCurrent(admitted)
      ) {
        closeAll();
        return "finalize";
      }
      try {
        await guards.sendFollowUp(admitted.map((carrier) => carrier.message));
      } catch (error) {
        log.warn(`turn-context: continuation follow-up failed runId=${runId}: ${String(error)}`);
        closeAll();
        return "finalize";
      }
      for (const carrier of admitted) {
        const attached = sources.get(carrier.pluginKey);
        if (!attached || attached.inputId !== decidingInput) {
          continue;
        }
        attached.queued.delete(carrier.contributionId);
        attached.receipts.transition(carrier.contributionId, "installed", "terminal-continuation");
        attached.installed.set(carrier.contributionId, { ...carrier, installed: true });
      }
      const consumers = new Set(livePending.map(({ attached }) => attached));
      for (const attached of consumers) {
        attached.finalContinuationsUsed += 1;
      }
      closeAll();
      return "continue";
    },
    async dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      const attachedSources = [...sources.values()];
      for (const attached of attachedSources) {
        attached.receipts.dropPending("run-settled");
      }
      const counts = manager.receiptCounts();
      sources.clear();
      const continuations = attachedSources.reduce(
        (total, attached) => total + attached.finalContinuationsUsed,
        0,
      );
      for (const attached of attachedSources) {
        void disposeSource(attached);
      }
      await settleWithTimeout(
        Promise.all(pendingDisposals).then(() => {}),
        "dispose all",
        DISPOSE_SETTLE_MS,
      );
      log.debug(
        `turn-context: disposed runId=${runId} reason=${reason} ` +
          `contributions queued=${String(counts.queued)} leased=${String(counts.leased)} ` +
          `installed=${String(counts.installed)} submitted=${String(counts.submitted)} ` +
          `uncertain=${String(counts.uncertain)} dropped=${String(counts.dropped)} continuations=${String(continuations)}`,
      );
    },
  };
  return manager;
}
