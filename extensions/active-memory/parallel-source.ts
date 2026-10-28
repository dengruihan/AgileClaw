import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  MemoryCallerAuthority,
  MemoryCallerContext,
} from "openclaw/plugin-sdk/memory-host-search";
import type {
  TurnContextContributionsHost,
  TurnContextSource,
  TurnContextSourceScope,
} from "openclaw/plugin-sdk/plugin-entry";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  EXTRACTOR_ASSISTANT_TAIL_CHARS,
  EXTRACTOR_PREVIOUS_QUERIES,
  buildFallbackExtractorQuery,
  createExtractorWorkSignal,
  prepareParallelExtractor,
  runExtractorCompletion,
  type ExtractorSnapshot,
  type ParsedExtractorOutput,
  type PreparedExtractorSuccess,
} from "./parallel-query.js";
import { createParallelRecallBudget, runParallelSearch } from "./parallel-recall.js";
import type { ActiveMemoryParallelConfig } from "./types.js";

/**
 * Scheduling window for the parallel memory sidecar: bounded output observation,
 * single-concurrency extraction cycles, and one bounded final flush. The main
 * agent never waits on anything here; publishes land in the host queue.
 */

export const PARALLEL_TEXT_TRIGGER_CHARS = 160;
export const PARALLEL_TEXT_TRIGGER_INTERVAL_MS = 750;
export const PARALLEL_SPARSE_TIMER_MS = 1_000;
export const PARALLEL_MAX_EXTRACTIONS = 4;
export const PARALLEL_MAX_SEARCHES = 4;

type ParallelSourceDeps = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir?: string;
  context: MemoryCallerContext;
  activeProjectKeys: readonly string[];
  parallel: ActiveMemoryParallelConfig;
  userRequest: string;
  recentContext?: string;
  debug?: (message: string) => void;
  info?: (message: string) => void;
};

/**
 * Creates the sidecar source. The host calls the factory with the bound scope;
 * the initial extraction cycle starts asynchronously from the first call.
 */
export function createActiveMemoryParallelSource(
  scope: TurnContextSourceScope,
  deps: ParallelSourceDeps,
): TurnContextSource {
  const budget = createParallelRecallBudget();
  const controller = new AbortController();
  const signal = AbortSignal.any([scope.signal, controller.signal]);
  const assertCurrent = () => {
    signal.throwIfAborted();
    scope.assertCurrent();
  };
  let assistantTail = "";
  let newCharsSinceCycle = 0;
  /** Bumped on every observed text event; cycles capture the value they searched. */
  let observedVersion = 0;
  let searchedVersion = 0;
  let extractionsUsed = 0;
  let sequence = 0;
  let running = false;
  let stopped = false;
  let flushing = false;
  let lastCycleStartedAt = 0;
  let sparseTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let preparedExtractor: PreparedExtractorSuccess | undefined;
  let extractorUnavailable = false;
  const previousQueries: string[] = [];

  const clearSparseTimer = () => {
    if (sparseTimer) {
      clearTimeout(sparseTimer);
      sparseTimer = undefined;
    }
  };

  const stop = () => {
    stopped = true;
    clearSparseTimer();
    scope.signal.removeEventListener("abort", stop);
    controller.abort(new Error("active-memory parallel source stopped"));
  };
  scope.signal.addEventListener("abort", stop, { once: true });

  const publishContribution = (id: string, text: string): boolean => {
    assertCurrent();
    const outcome = scope.publish({ id, text });
    if (outcome.status === "queued") {
      return true;
    }
    if (outcome.status === "closed") {
      stop();
    }
    return false;
  };

  const runCycle = async (): Promise<void> => {
    if (stopped || running || extractorUnavailable || extractionsUsed >= PARALLEL_MAX_EXTRACTIONS) {
      return;
    }
    running = true;
    lastCycleStartedAt = Date.now();
    searchedVersion = observedVersion;
    newCharsSinceCycle = 0;
    extractionsUsed += 1;
    const snapshot: ExtractorSnapshot = {
      userRequest: deps.userRequest,
      ...(deps.recentContext ? { recentContext: deps.recentContext } : {}),
      ...(assistantTail ? { assistantTail } : {}),
      previousQueries: [...previousQueries],
    };
    // Preparation and completion share one work deadline; neither can outwait it.
    const workSignal = createExtractorWorkSignal(signal);
    try {
      assertCurrent();
      if (!preparedExtractor) {
        const prepared = await prepareParallelExtractor({
          cfg: deps.cfg,
          agentId: deps.agentId,
          ...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
          parallel: deps.parallel,
          signal: workSignal,
        });
        workSignal.throwIfAborted();
        if ("error" in prepared) {
          extractorUnavailable = true;
          stop();
          deps.info?.(
            `active-memory: parallel recall skipped reason=extractor-model-unavailable (${prepared.error})`,
          );
          return;
        }
        preparedExtractor = prepared;
      }
      assertCurrent();
      const output: ParsedExtractorOutput | undefined = await runExtractorCompletion({
        prepared: preparedExtractor,
        cfg: deps.cfg,
        snapshot,
        assertCurrent,
        signal: workSignal,
      });
      assertCurrent();
      workSignal.throwIfAborted();
      // Three states: a legal empty query skips this cycle outright; only an
      // unparseable result earns one deterministic fallback query. Call
      // failures propagate through the catch below, never become invalid.
      let query: string | undefined;
      if (output?.state === "parsed") {
        query = output.query.trim() ? output.query : undefined;
      } else if (output?.state === "invalid" || output === undefined) {
        query = buildFallbackExtractorQuery({
          userRequest: snapshot.userRequest,
          ...(snapshot.recentContext ? { recentContext: snapshot.recentContext } : {}),
          ...(snapshot.assistantTail ? { assistantTail: snapshot.assistantTail } : {}),
          previousQueries: snapshot.previousQueries,
        });
      }
      if (!query || !query.trim()) {
        return;
      }
      if (budget.searchesUsed >= PARALLEL_MAX_SEARCHES) {
        return;
      }
      previousQueries.push(query);
      if (previousQueries.length > EXTRACTOR_PREVIOUS_QUERIES) {
        previousQueries.shift();
      }
      sequence += 1;
      const outcome = await runParallelSearch({
        cfg: deps.cfg,
        agentId: deps.agentId,
        context: {
          ...deps.context,
          signal,
          assertCurrent() {
            assertCurrent();
            deps.context.assertCurrent();
          },
        },
        query,
        budget,
        activeProjectKeys: deps.activeProjectKeys,
        sequence,
        signal,
        debug: deps.debug,
      });
      assertCurrent();
      if (outcome.status === "contribution" && publishContribution(outcome.id, outcome.text)) {
        outcome.commitQueued();
        deps.info?.(
          `active-memory: parallel recall queued ${String(outcome.matchedCount)} hit(s) ` +
            `(extraction ${String(extractionsUsed)}/${String(PARALLEL_MAX_EXTRACTIONS)}, ` +
            `search ${String(budget.searchesUsed)}/${String(PARALLEL_MAX_SEARCHES)})`,
        );
      }
    } catch (error) {
      if (signal.aborted) {
        stop();
        return;
      }
      deps.debug?.(`active-memory: parallel recall cycle failed: ${String(error)}`);
    } finally {
      running = false;
      // Text that arrived while this cycle ran must be re-scheduled by the
      // settlement itself; waiting for the next output event would strand it.
      if (!stopped && !flushing && observedVersion !== searchedVersion) {
        scheduleCycle();
      }
    }
  };

  const launchCycle = () => {
    const cycle = runCycle();
    inFlight = cycle;
    void cycle.catch(() => undefined);
  };

  const scheduleCycle = () => {
    if (stopped || running || flushing || extractorUnavailable) {
      return;
    }
    if (extractionsUsed >= PARALLEL_MAX_EXTRACTIONS) {
      return;
    }
    if (
      lastCycleStartedAt === 0 ||
      Date.now() - lastCycleStartedAt >= PARALLEL_TEXT_TRIGGER_INTERVAL_MS
    ) {
      launchCycle();
      return;
    }
    if (!sparseTimer) {
      sparseTimer = setTimeout(() => {
        sparseTimer = undefined;
        if (!stopped && !running && !flushing && observedVersion !== searchedVersion) {
          launchCycle();
        }
      }, PARALLEL_SPARSE_TIMER_MS);
    }
  };

  const onAssistantText = (event: { text: string; kind: "append" | "replace" }) => {
    if (stopped) {
      return;
    }
    if (event.kind === "replace") {
      // A replace snapshot re-bases the window on its latest tail.
      const tail = sliceUtf16Safe(event.text, -EXTRACTOR_ASSISTANT_TAIL_CHARS);
      if (tail === assistantTail) {
        return;
      }
      assistantTail = tail;
      newCharsSinceCycle += tail.length;
    } else {
      if (!event.text) {
        return;
      }
      assistantTail = sliceUtf16Safe(assistantTail + event.text, -EXTRACTOR_ASSISTANT_TAIL_CHARS);
      newCharsSinceCycle += event.text.length;
    }
    observedVersion += 1;
    if (newCharsSinceCycle >= PARALLEL_TEXT_TRIGGER_CHARS) {
      scheduleCycle();
      return;
    }
    // Sparse text keeps one cancellable timer so short fragments still get searched.
    if (!sparseTimer && !running && !flushing) {
      sparseTimer = setTimeout(() => {
        sparseTimer = undefined;
        if (!stopped && !running && !flushing && observedVersion !== searchedVersion) {
          scheduleCycle();
        }
      }, PARALLEL_SPARSE_TIMER_MS);
    }
  };

  // The initial cycle starts immediately; the host never awaits it here.
  launchCycle();

  return {
    onAssistantText,
    async flush(deadlineAtMs) {
      if (stopped) {
        return;
      }
      flushing = true;
      clearSparseTimer();
      try {
        if (inFlight) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve(inFlight).catch(() => undefined),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now()));
              }),
            ]);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
        }
        // One last cycle for an unsearched window inside the budget; the final
        // cycle stays on the same tracked execution chain, never a second one.
        const windowChanged = observedVersion !== searchedVersion;
        if (
          !running &&
          !stopped &&
          !extractorUnavailable &&
          extractionsUsed < PARALLEL_MAX_EXTRACTIONS &&
          windowChanged &&
          Date.now() < deadlineAtMs
        ) {
          const cycle = runCycle();
          inFlight = cycle;
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              cycle,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now()));
              }),
            ]);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
        }
      } finally {
        stop();
      }
    },
    async dispose() {
      stop();
      // The host may bound its wait, but this promise represents actual task
      // settlement so late provider/model cleanup stays lifecycle-owned.
      await inFlight;
    },
  };
}

export type ParallelAttachOutcome =
  | { status: "attached" }
  | { status: "declined"; reason: string }
  | { status: "not-requested" };

/**
 * Prepared once per input from the slot owner's declared read surface. Native
 * providers declare their recall tool set; legacy runtimes keep their
 * deterministic recall tool — both are admissible through the neutral provider
 * facade, which selects the existing adapter.
 */
export type ParallelMemoryReadContract =
  | { kind: "native"; recallToolNames: readonly string[] }
  | { kind: "legacy"; deterministicRecallToolName: string };

export type ParallelMemoryReadAdmission =
  | { contract: ParallelMemoryReadContract }
  | { reason: "no-read-contract" | "policy-disabled" };

export function resolveParallelMemoryReadAdmission(params: {
  providerRuntime: boolean;
  recallToolNames?: readonly string[];
  deterministicRecallToolName?: string;
  toolAllows: (toolName: string) => boolean;
}): ParallelMemoryReadAdmission {
  if (params.providerRuntime) {
    const recallToolNames = params.recallToolNames ?? [];
    if (recallToolNames.length === 0) {
      return { reason: "no-read-contract" };
    }
    if (!recallToolNames.every((toolName) => params.toolAllows(toolName))) {
      return { reason: "policy-disabled" };
    }
    return { contract: { kind: "native", recallToolNames } };
  }
  const deterministicRecallToolName = params.deterministicRecallToolName;
  if (!deterministicRecallToolName) {
    return { reason: "no-read-contract" };
  }
  if (!params.toolAllows(deterministicRecallToolName)) {
    return { reason: "policy-disabled" };
  }
  return { contract: { kind: "legacy", deterministicRecallToolName } };
}

export type ParallelAttachParams = {
  execution: "blocking" | "parallel";
  mode: "escalate" | "always" | "off";
  enabled: boolean;
  activeMemoryConfigured: boolean;
  privateDestination: boolean;
  chatIdAllowed: boolean;
  turnContextContributions?: TurnContextContributionsHost;
  memoryReadAdmission: ParallelMemoryReadAdmission;
  protectedTranscriptRecallNeeded: boolean;
  sessionKey: string | undefined;
  agentId: string | undefined;
  liveConfig: OpenClawConfig;
  parallel: ActiveMemoryParallelConfig;
  userRequest: string;
  recentContext?: string;
  sessionId?: string;
  sandboxed: boolean;
  memoryAudience?: Extract<MemoryCallerAuthority, { kind: "session" }>["audience"];
  activeProjectKeys: readonly string[];
  debug?: (message: string) => void;
  info?: (message: string) => void;
};

/**
 * Strategy entry: decides between the parallel sidecar and the blocking path
 * for this input and, when eligible, attaches the sidecar source. The caller
 * keeps the blocking path for every non-attached outcome.
 */
export function maybeAttachParallelMemorySource(
  params: ParallelAttachParams,
): ParallelAttachOutcome {
  if (params.execution !== "parallel" || params.mode === "off") {
    return { status: "not-requested" };
  }
  const declined = (reason: string): ParallelAttachOutcome => ({
    status: "declined",
    reason,
  });
  if (!params.activeMemoryConfigured || !params.agentId || !params.sessionKey) {
    return declined("not-configured");
  }
  if (!params.privateDestination || !params.chatIdAllowed) {
    return declined("destination-not-allowed");
  }
  if (!params.turnContextContributions) {
    return declined("unsupported-harness");
  }
  if ("reason" in params.memoryReadAdmission) {
    return declined(params.memoryReadAdmission.reason);
  }
  if (params.protectedTranscriptRecallNeeded) {
    return declined("protected-transcript-recall");
  }
  const agentId = params.agentId;
  const sessionKey = params.sessionKey;
  const outcome = params.turnContextContributions.attach(
    {
      key: "active-memory",
      requiredTools:
        params.memoryReadAdmission.contract.kind === "native"
          ? params.memoryReadAdmission.contract.recallToolNames
          : [params.memoryReadAdmission.contract.deterministicRecallToolName],
      terminalWaitMs: params.parallel.terminalWaitMs,
      maxFinalContinuations: 1,
    },
    (scope) =>
      createActiveMemoryParallelSource(scope, {
        cfg: params.liveConfig,
        agentId,
        agentDir: resolveAgentDir(params.liveConfig, agentId),
        workspaceDir: resolveAgentWorkspaceDir(params.liveConfig, agentId),
        context: {
          authority: {
            kind: "session",
            sessionKey,
            ...(params.sessionId ? { sessionId: params.sessionId } : {}),
            sandboxed: params.sandboxed,
            ...(params.memoryAudience ? { audience: params.memoryAudience } : {}),
          },
          signal: scope.signal,
          assertCurrent() {
            scope.assertCurrent();
          },
        },
        activeProjectKeys: [...params.activeProjectKeys],
        parallel: params.parallel,
        userRequest: params.userRequest,
        ...(params.recentContext ? { recentContext: params.recentContext } : {}),
        debug: params.debug,
        info: params.info,
      }),
  );
  if (outcome.status !== "attached" && outcome.status !== "already-attached") {
    return declined(`attach-${outcome.status}`);
  }
  // Same-input re-entry keeps the established parallel decision; the caller
  // must not fall back to also running the blocking lanes.
  return { status: "attached" };
}

/** Bounded recent-turn view for the extractor: resolves "it"/"continue" references. */
export function buildParallelRecentContext(
  recentTurns: {
    role: "user" | "assistant";
    text: string;
  }[],
): string | undefined {
  const tail = recentTurns.slice(-2);
  if (tail.length === 0) {
    return undefined;
  }
  const text = tail.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
  return sliceUtf16Safe(text, -1_000);
}
