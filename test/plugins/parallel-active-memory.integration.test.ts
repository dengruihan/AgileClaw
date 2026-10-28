import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import activeMemory from "../../extensions/active-memory/index.js";
import { getMemorySearchManager, memoryRuntime } from "../../extensions/memory-core/runtime-api.js";
import { createManagerIndexFixture } from "../../extensions/memory-core/src/memory/manager-index.test-support.js";
import { prepareSystemAgentRunAdmission } from "../../src/agents/admitted-run-context.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../src/agents/embedded-agent-runner/run-state.js";
import { normalizeMessagesForLlmBoundary } from "../../src/agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "../../src/agents/embedded-agent-runner/run/attempt-prompt-submit.js";
import { createBaseInput } from "../../src/agents/embedded-agent-runner/run/attempt-prompt-submit.test-support.js";
import { prepareCatalogExecutor } from "../../src/agents/embedded-agent-runner/run/attempt-stream-prepare.test-support.js";
import {
  createAttemptTurnContextContributionsCapability,
  forgetAttemptTurnContextManager,
  readAttemptTurnContextReceiptCounts,
} from "../../src/agents/embedded-agent-runner/run/attempt-turn-context.js";
import { buildEmbeddedRunPayloads } from "../../src/agents/embedded-agent-runner/run/payloads.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../src/agents/sessions/agent-session-loop-correctness.test-support.js";
import type { Context } from "../../src/llm/types.js";
import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookHandlerMap,
  PluginHookAgentContext,
} from "../../src/plugins/hook-types.js";
import { createHookRunner } from "../../src/plugins/hooks.js";
import { registerMemoryCapability } from "../../src/plugins/memory-state.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createRuntimeAgent } from "../../src/plugins/runtime/runtime-agent.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const extractor = vi.hoisted(() => ({ complete: vi.fn() }));
// mock-isolation: Only extractor transport is synthetic; memory and host owners stay real.
vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: async () => ({ model: {}, auth: {}, selection: {} }),
  completeWithPreparedSimpleCompletionModel: extractor.complete,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

registerAgentSessionLoopTestLifecycle();

describe("parallel active-memory production composition", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers: memoryRuntime.closeAllMemorySearchManagers,
  });
  const runId = "parallel-integration-run";
  const inputId = "parallel-input-a";
  const sessionKey = "agent:main:main";
  const marker = "Alpha deployment uses the cobalt database.";

  const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];

  afterEach(async () => {
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
    await forgetAttemptTurnContextManager(runId);
    extractor.complete.mockReset();
  });

  async function setup(
    options: {
      emptyQuery?: boolean;
      tool?: boolean;
      toolTurns?: number;
      continuationTool?: boolean;
      revoke?: "queued" | "install";
      revokeOnCarrierStart?: boolean;
      query?: string;
      extractorQueries?: string[];
      secondMarker?: boolean;
      memoryFacts?: string[];
      steerBeforeRun?: { text: string; inputId: string };
      continuationText?: string;
      cancel?: boolean;
      tokenBudget?: number;
      streamReplies?: boolean;
      holdExtraction?: boolean;
      terminalWaitMs?: number;
      reenter?: boolean;
      dispatchFailure?: boolean;
    } = {},
  ) {
    const betaMarker = "Beta rollout ships the amber dashboard.";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      options.memoryFacts
        ? options.memoryFacts.join("\n\n")
        : options.secondMarker
          ? `${marker}\n\n${betaMarker}`
          : marker,
    );
    const config = fixture.createConfig({ provider: "openai", vectorEnabled: true, minScore: 0.1 });
    const pluginConfig = {
      enabled: true,
      agents: ["main"],
      mode: "always",
      execution: "parallel",
      parallel: { terminalWaitMs: options.terminalWaitMs ?? 5000 },
    };
    config.plugins = {
      slots: { memory: "memory-core" },
      entries: { "active-memory": { enabled: true, config: pluginConfig } },
    };
    const manager = await fixture.getFreshManager(config, "cli");
    await manager.sync({ reason: "cli", force: true });
    await manager.close();
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    registerMemoryCapability("memory-core", {
      runtime: memoryRuntime,
      deterministicRecallToolName: "memory_search",
      recallToolNames: ["memory_search", "memory_get"],
      supportsPrivateTranscriptRecall: true,
    });
    const authority = { current: true };
    const assertCurrent = () => {
      if (!authority.current) {
        throw new Error("synthetic audience revoked");
      }
    };
    const controller = new AbortController();
    const admission = prepareSystemAgentRunAdmission(config, runId, "main", "parallel-integration");
    admissions.push(admission);
    const admittedRunContext = await admission.admit("embedded");
    const queued = deferred<void>();
    const sourceSignals: AbortSignal[] = [];
    const terminalFlushStarted = deferred<void>();
    const wrapWithSpy = (
      host: NonNullable<PluginHookAgentContext["turnContextContributions"]>,
    ): NonNullable<PluginHookAgentContext["turnContextContributions"]> => ({
      attach: (params, factory) =>
        host.attach(params, (scope) => {
          sourceSignals.push(scope.signal);
          const source = factory({
            ...scope,
            publish: (contribution) => {
              const outcome = scope.publish(contribution);
              if (outcome.status === "queued") {
                queued.resolve();
              }
              return outcome;
            },
          });
          return {
            ...source,
            flush: async (deadlineAtMs) => {
              terminalFlushStarted.resolve();
              await source.flush(deadlineAtMs);
            },
          };
        }),
    });
    const attachParallelForInput = async (attachInputId: string, prompt: string) => {
      const hostForInput = createAttemptTurnContextContributionsCapability({
        eligible: true,
        runId,
        inputId: attachInputId,
        runAbortSignal: controller.signal,
        assertHostActive: assertCurrent,
        assertMemoryAudienceCurrent: assertCurrent,
        allowsTool: (name) => session.agent.state.tools.some((tool) => tool.name === name),
      });
      if (!hostForInput) {
        throw new Error("Missing input contribution capability");
      }
      const attachEvent = {
        messages: [],
        prompt,
        currentUserMessage: prompt,
        currentUserMessageId: attachInputId,
      } satisfies PluginHookBeforePromptBuildEvent;
      const attachContext = {
        trigger: "user",
        messageProvider: "webchat",
        agentId: "main",
        sessionKey,
        sessionId: "parallel-session",
        runId,
        turnContextContributions: wrapWithSpy(hostForInput),
        assertMemoryAudienceCurrent: assertCurrent,
      } satisfies PluginHookAgentContext;
      await hookRunner.runAuthorizedPromptBuild(attachEvent, attachContext, {
        toolAuthorityFingerprint: "parallel-test-authority",
        activeToolNames: session.getActiveToolNames(),
        assertHostActive: assertCurrent,
      });
    };
    const logs: string[] = [];
    const api = {
      config,
      pluginConfig,
      logger: {
        info: (value: string) => logs.push(value),
        debug: (value: string) => logs.push(value),
        warn: (value: string) => logs.push(value),
      },
      runtime: {
        config: { current: () => config },
        agent: createRuntimeAgent(),
        state: { openKeyedStore: () => ({ lookup: async () => undefined }) },
      },
      registerCommand: () => {},
      on: (
        name: string,
        handler: PluginHookHandlerMap["before_prompt_build"],
        opts?: { requiresToolAuthority?: true },
      ) => {
        if (name === "before_prompt_build") {
          registry.typedHooks.push({
            pluginId: "active-memory",
            hookName: "before_prompt_build",
            handler,
            source: "synthetic-plugin",
            ...opts,
          });
        }
      },
    } as unknown as OpenClawPluginApi;
    activeMemory.register(api);
    const hookRunner = createHookRunner(registry, { catchErrors: false });
    const ready = deferred<void>();
    const release = deferred<void>();
    const extractorQueries = [
      ...(options.extractorQueries ?? [
        options.emptyQuery ? "" : (options.query ?? "Alpha deployment"),
      ]),
    ];
    extractor.complete.mockImplementation(async () => {
      ready.resolve();
      await release.promise;
      const query = extractorQueries.length > 1 ? extractorQueries.shift() : extractorQueries[0];
      return createAssistant(testModel, [
        { type: "text", text: JSON.stringify({ keywords: ["Alpha"], query: query ?? "" }) },
      ]);
    });
    const promptEvent = {
      messages: [],
      prompt: "Help with the Alpha deployment",
      currentUserMessage: "Help with the Alpha deployment",
      currentUserMessageId: inputId,
    } satisfies PluginHookBeforePromptBuildEvent;
    let toolEffects = 0;
    const { session, sessionManager } = await createTestSession({
      customTools: [
        ...["memory_search", "memory_get"].map((name) => ({
          name,
          label: name,
          description:
            "Synthetic callable memory surface; parallel retrieval uses the real backend.",
          parameters: Type.Object({}),
          execute: async () => {
            throw new Error("Parallel recall must not invoke a blocking recall tool");
          },
        })),
        ...(options.tool || options.continuationTool
          ? [
              {
                name: "deploy",
                label: "Deploy",
                description: "Record one completed synthetic operation",
                parameters: Type.Object({}),
                execute: async () => {
                  ++toolEffects;
                  release.resolve();
                  await queued.promise;
                  if (options.revoke === "queued") {
                    authority.current = false;
                  }
                  return {
                    content: [{ type: "text", text: "Synthetic operation completed." }],
                    details: {},
                  };
                },
              },
            ]
          : []),
      ],
    });
    await attachParallelForInput(inputId, "Help with the Alpha deployment");
    expect(logs.join("\n")).toContain("requested=parallel effective=parallel");
    await ready.promise;
    if (options.reenter) {
      await attachParallelForInput(inputId, promptEvent.currentUserMessage);
      expect(extractor.complete).toHaveBeenCalledTimes(1);
      expect(sourceSignals).toHaveLength(1);
      expect(logs.join("\n")).not.toContain("effective=blocking");
    }
    if (options.revoke === "install") {
      const append = sessionManager.appendCustomMessageEntryAsync.bind(sessionManager);
      vi.spyOn(sessionManager, "appendCustomMessageEntryAsync").mockImplementation(
        async (...args) => {
          const id = await append(...args);
          if (args[0] === "openclaw.background-context") {
            authority.current = false;
          }
          return id;
        },
      );
    }
    const convert = session.agent.convertToLlm;
    session.agent.convertToLlm = (messages) =>
      convert(
        normalizeMessagesForLlmBoundary(messages, {
          inHistorySystemUpdates: true,
          appendOnlyRuntimeContext: true,
          includeTimestamp: false,
        }),
      );
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((model, request: Context) => {
      // Tool schemas carry execute functions; clone only the plain request data.
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        })),
      });
      if (requests.length === 2) {
        deliveredBeforeContinuation = delivered.length;
        if (options.dispatchFailure) {
          throw new Error("Synthetic continuation transport failed");
        }
      }
      const tool =
        (options.tool && requests.length <= (options.toolTurns ?? 1)) ||
        (options.continuationTool && requests.length === 2);
      return createAssistantResultStream(
        createAssistant(
          model,
          tool
            ? [{ type: "toolCall", id: `deploy-${requests.length}`, name: "deploy", arguments: {} }]
            : [
                {
                  type: "text",
                  text:
                    requests.length === 1
                      ? "Original answer."
                      : (options.continuationText ?? "Additional memory considered."),
                },
              ],
          tool ? "toolUse" : "stop",
        ),
      );
    });
    const firstAnswer = deferred<void>();
    let deliveredBeforeContinuation = 0;
    let terminal = 0;
    const terminalPhases: string[] = [];
    let assistantTurns = 0;
    let receiptsAtEnd: ReturnType<typeof readAttemptTurnContextReceiptCounts> | undefined;
    const delivered: string[] = [];
    session.subscribe((entry) => {
      if (
        options.revokeOnCarrierStart &&
        entry.type === "message_start" &&
        (entry.message as { customType?: string }).customType === "openclaw.background-context"
      ) {
        // Revoke lands after the terminal decision sent the follow-up but
        // before the loop consumes it.
        authority.current = false;
      }
      if (entry.type === "message_end" && entry.message.role === "assistant") {
        // Snapshot after each turn settles: the last write is the final ledger.
        receiptsAtEnd = readAttemptTurnContextReceiptCounts(runId);
      }
      if (
        entry.type === "message_end" &&
        entry.message.role === "assistant" &&
        ++assistantTurns === 1 &&
        !options.tool
      ) {
        if (options.cancel) {
          controller.abort(new Error("Synthetic input cancellation"));
        }
        if (!options.holdExtraction) {
          release.resolve();
        }
        firstAnswer.resolve();
      }
    });
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      hookRunner,
      runAbortController: controller,
      attempt: {
        runId,
        sessionId: "parallel-session",
        sessionKey,
        model: testModel,
        messageProvider: "webchat",
        toolAuthorityFingerprint: "parallel-test-authority",
        admittedRunContext,
      },
      streamReplies: options.streamReplies,
      onBlockReply: async (payload) => {
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      onAgentEvent: (event) => {
        if (
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error")
        ) {
          ++terminal;
          terminalPhases.push(event.data.phase);
          receiptsAtEnd = readAttemptTurnContextReceiptCounts(runId);
        }
      },
    });
    if (options.steerBeforeRun) {
      const steerText = options.steerBeforeRun.text;
      // Real-shape recorder fixture: the steering admission path reads the
      // admission receipt for input identity and resolveMessage() on enqueue.
      const steerRecorder = {
        getAdmissionReceipt: () => ({ logicalTurnId: options.steerBeforeRun!.inputId }),
        resolveMessage: async () => ({ role: "user", content: steerText, timestamp: Date.now() }),
      } as unknown as NonNullable<EmbeddedAgentQueueMessageOptions["userTurnTranscriptRecorder"]>;
      await prepared.queueHandle.queueMessage(steerText, {
        userTurnTranscriptRecorder: steerRecorder,
      });
    }
    const execute = () =>
      submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        attempt: { sessionId: "parallel-session", sessionKey },
        activeSession: session,
        contextTokenBudget: options.tokenBudget ?? 8000,
        turnContextRunId: runId,
        prependContext: undefined,
        appendContext: undefined,
        transcriptPrompt: promptEvent.currentUserMessage,
        modelPrompt: promptEvent.currentUserMessage,
        promptActiveSession: (prompt, opts) => session.prompt(prompt, opts),
      });
    return {
      execute: async () => {
        try {
          await execute();
          await prepared.subscription.waitForPendingEvents();
          if (options.streamReplies === false) {
            const lastAssistant = session.messages.findLast(
              (message) => message.role === "assistant",
            );
            const payloads = buildEmbeddedRunPayloads({
              assistantTexts: prepared.subscription.assistantTexts,
              answerSegments: prepared.subscription.answerSegments,
              lastAssistant: lastAssistant?.role === "assistant" ? lastAssistant : undefined,
              currentAssistant: lastAssistant?.role === "assistant" ? lastAssistant : undefined,
              sessionKey,
              runId,
            });
            delivered.push(...payloads.flatMap((payload) => (payload.text ? [payload.text] : [])));
          }
          const failed = session.messages.find(
            (message) => message.role === "assistant" && message.stopReason === "error",
          );
          if (failed?.role === "assistant") {
            throw new Error(failed.errorMessage ?? "Synthetic main request failed");
          }
        } finally {
          prepared.subscription.unsubscribe();
          prepared.stopAcceptingSteerMessages();
          await forgetAttemptTurnContextManager(runId);
          admission.close();
        }
      },
      requests,
      session,
      sessionManager,
      authority,
      release,
      firstAnswer: firstAnswer.promise,
      terminalFlushStarted: terminalFlushStarted.promise,
      logs,
      delivered,
      sourceSignals,
      terminalPhases,
      betaMarker,
      get deliveredBeforeContinuation() {
        return deliveredBeforeContinuation;
      },
      get receipts() {
        return receiptsAtEnd;
      },
      get continuations() {
        return Math.max(0, requests.length - 1);
      },
      get terminal() {
        return terminal;
      },
      get toolEffects() {
        return toolEffects;
      },
    };
  }

  it("runs the foreground answer before extraction, then retrieves default-backend vector memory into one same-turn follow-up", async () => {
    const test = await setup();
    await test.execute();
    expect(test.requests).toHaveLength(2);
    expect(JSON.stringify(test.requests[0])).not.toContain(marker);
    expect(JSON.stringify(test.requests[1])).toContain(marker);
    expect(fixture.provider.embeddedQueryTexts).toContain("Alpha deployment");
    expect(test.continuations).toBe(1);
    expect(test.terminal).toBe(1);
    expect(test.receipts).toEqual({
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 1,
      uncertain: 0,
      dropped: 0,
    });
    expect(test.sourceSignals.every((signal) => signal.aborted)).toBe(true);
    expect(test.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "openclaw.background-context",
        display: false,
        content: expect.stringContaining(marker),
      }),
    );
  });

  it("honors an explicit empty extractor query without search or forced continuation", async () => {
    const test = await setup({ emptyQuery: true });
    await test.execute();
    expect(test.requests).toHaveLength(1);
    expect(fixture.provider.embedQueryCalls).toBe(0);
    expect(test.continuations).toBe(0);
    expect(test.terminal).toBe(1);
  });
  it("installs recalled memory after a completed tool pair without repeating its side effect", async () => {
    const test = await setup({ tool: true });
    await test.execute();
    expect(test.requests).toHaveLength(2);
    expect(test.toolEffects).toBe(1);
    const messages = test.requests[1]!.messages;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain(marker);
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(messages.findIndex((message) => message.role === "toolResult")).toBeLessThan(
      messages.findIndex((message) => JSON.stringify(message).includes(marker)),
    );
    expect(test.terminal).toBe(1);
  });

  it("keeps terminal memory once when its continuation performs a tool and dispatches again", async () => {
    const test = await setup({ continuationTool: true });
    await test.execute();
    expect(test.requests).toHaveLength(3);
    expect(test.toolEffects).toBe(1);
    expect(
      test.requests[2]!.messages.filter(
        (message) => message.role === "user" && JSON.stringify(message).includes(marker),
      ),
    ).toHaveLength(1);
    expect(test.terminal).toBe(1);
  });

  it.each(["queued", "install"] as const)(
    "withholds revoked memory at the real dispatch after %s",
    async (revoke) => {
      const toolTurns = revoke === "install" ? 2 : 1;
      const test = await setup({ tool: true, revoke, toolTurns });
      await test.execute();
      expect(test.requests).toHaveLength(toolTurns + 1);
      expect(JSON.stringify(test.requests)).not.toContain(marker);
      expect(test.toolEffects).toBe(toolTurns);
      expect(test.terminal).toBe(1);
    },
  );

  it("cancels the continuation follow-up when authority revokes before it is consumed", async () => {
    const test = await setup({ revokeOnCarrierStart: true });
    await test.execute();
    // The revoked material must not wake a second model call: the loop drops
    // the cancelled follow-up, the delivered answer stands, and the carrier
    // records an authority-revoked drop instead of a wasted continuation.
    expect(test.requests).toHaveLength(1);
    expect(test.terminal).toBe(1);
    expect(test.delivered.filter((text) => text.includes("Original answer."))).toHaveLength(1);
    expect(test.receipts).toMatchObject({ dropped: expect.any(Number), submitted: 0 });
  });

  it.each(["no-match", "cancelled"] as const)(
    "ends without a memory continuation when %s",
    async (scenario) => {
      const test = await setup({
        query: scenario === "no-match" ? "beta" : undefined,
        cancel: scenario === "cancelled",
      });
      await test.execute();
      expect(test.requests).toHaveLength(1);
      expect(test.terminal).toBe(1);
      expect(test.sourceSignals.every((signal) => signal.aborted)).toBe(true);
      if (scenario === "no-match") {
        expect(fixture.provider.embeddedQueryTexts).toContain("beta");
      } else {
        expect(fixture.provider.embedQueryCalls).toBe(0);
      }
    },
  );

  it("steers a real input A to B: A settles, B extracts independently, and no A material leaks", async () => {
    const test = await setup({
      reenter: true,
      memoryFacts: ["Beta rollout ships the amber dashboard."],
      extractorQueries: ["Alpha deployment", "Beta rollout"],
      steerBeforeRun: { text: "Now check the Beta rollout instead.", inputId: "parallel-input-b" },
    });
    await test.execute();
    // A's rotation aborted its sidecar before its extractor settled: only B searched.
    expect(fixture.provider.embeddedQueryTexts).toEqual(["Beta rollout"]);
    expect(test.sourceSignals[0]?.aborted).toBe(true);
    // The steered input B extracted and published its own material into the
    // same-turn continuation; the previous input's material never appears.
    expect(JSON.stringify(test.requests)).not.toContain(marker);
    expect(JSON.stringify(test.requests.at(-1))).toContain(test.betaMarker);
    expect(test.continuations).toBe(1);
    expect(test.terminal).toBe(1);
    expect(test.receipts).toEqual({
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 1,
      uncertain: 0,
      dropped: 0,
    });
  });

  it.each([
    { continuationText: "", streamReplies: true },
    { continuationText: "NO_REPLY", streamReplies: true },
    { continuationText: "", streamReplies: false },
    { continuationText: "NO_REPLY", streamReplies: false },
  ])(
    "retains the first answer with silent continuation $continuationText and streaming=$streamReplies",
    async (options) => {
      const test = await setup(options);
      await test.execute();
      expect(test.requests).toHaveLength(2);
      expect(test.deliveredBeforeContinuation).toBe(options.streamReplies ? 1 : 0);
      expect(test.delivered).toEqual(["Original answer."]);
      expect(
        test.session.messages.some(
          (message) =>
            message.role === "assistant" && JSON.stringify(message).includes("Original answer."),
        ),
      ).toBe(true);
      expect(test.terminal).toBe(1);
    },
  );

  it("records uncertain dispatch without replaying installed memory after a transport failure", async () => {
    const test = await setup({ dispatchFailure: true });
    await expect(test.execute()).rejects.toThrow("Synthetic continuation transport failed");
    expect(test.requests).toHaveLength(2);
    expect(test.delivered).toEqual(["Original answer."]);
    expect(test.terminalPhases).toEqual(["error"]);
    expect(test.receipts).toEqual({
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 0,
      uncertain: 1,
      dropped: 0,
    });
    expect(JSON.stringify(test.sessionManager.getBranch())).toContain(marker);
    const replay = normalizeMessagesForLlmBoundary(test.session.messages, {
      inHistorySystemUpdates: true,
      appendOnlyRuntimeContext: true,
      includeTimestamp: false,
    });
    expect(JSON.stringify(replay)).not.toContain(marker);
  });

  it("does not wake a terminal continuation when the token budget admits no memory", async () => {
    const test = await setup({ tokenBudget: 200 });
    await test.execute();
    expect(test.requests).toHaveLength(1);
    expect(test.delivered).toEqual(["Original answer."]);
    expect(test.terminal).toBe(1);
    expect(test.receipts).toEqual({
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 0,
      uncertain: 0,
      dropped: 1,
    });
    expect(JSON.stringify(test.sessionManager.getBranch())).not.toContain(marker);
  });

  it("closes at the terminal deadline and settles a late extractor without searching or waking", async () => {
    const test = await setup({ holdExtraction: true, terminalWaitMs: 20 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = test.execute();
      await test.firstAnswer;
      await test.terminalFlushStarted;
      await vi.advanceTimersByTimeAsync(20);
      expect(test.sourceSignals.every((signal) => signal.aborted)).toBe(true);
      // Release the transport after its input has closed. Actual source cleanup
      // must settle the tracked task while rejecting the stale search result.
      test.release.resolve();
      await pending;
      expect(test.requests).toHaveLength(1);
      expect(fixture.provider.embedQueryCalls).toBe(0);
      expect(test.terminal).toBe(1);
      expect(test.receipts).toEqual({
        queued: 0,
        leased: 0,
        installed: 0,
        submitted: 0,
        uncertain: 0,
        dropped: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.release.resolve();
      vi.useRealTimers();
    }
  });

  it("drops the drained batch at zero token headroom without installing or waking a turn", async () => {
    const test = await setup({ tool: true, tokenBudget: 200 });
    await test.execute();
    // The batch drained at the post-tool boundary but admits zero whole
    // entries into the tiny budget: never installed, never submitted.
    expect(test.requests).toHaveLength(2);
    expect(JSON.stringify(test.requests[1])).not.toContain(marker);
    expect(test.toolEffects).toBe(1);
    expect(test.terminal).toBe(1);
    expect(test.receipts).toEqual({
      queued: 0,
      leased: 0,
      installed: 0,
      submitted: 0,
      uncertain: 0,
      dropped: 1,
    });
    expect(JSON.stringify(test.sessionManager.getBranch())).not.toContain(marker);
  });
});
