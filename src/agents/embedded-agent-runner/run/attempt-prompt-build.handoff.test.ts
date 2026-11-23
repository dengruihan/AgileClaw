import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { Model } from "../../../llm/types.js";
import { readSideConversationHandoffQueue } from "../../../sessions/side-conversation-handoff-queue.js";
import {
  cancelPendingSideConversationHandoffs,
  clearSideConversationHandoffClaimsForTest,
} from "../../../sessions/side-conversation-handoff.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../../test-utils/database-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-build.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

// mock-isolation: the handoff turn must not drain real plugin injections.
vi.mock("../../../plugins/host-hook-state.js", () => ({
  drainPluginNextTurnInjectionContext: vi.fn(async () => ({ queuedInjections: [] })),
}));
// mock-isolation: only the steering lease is stubbed; prompt text stays real.
vi.mock("../../subagents/registry/subagent-registry.js", async () => {
  const { prependAgentSteeringPrompt } = await import("../../agent-steering-queue.js");
  return {
    leasePendingAgentSteeringItems: vi.fn(async () => undefined),
    prependAgentSteeringPrompt,
  };
});

registerAgentSessionLoopTestLifecycle();

const parentKey = "agent:main:dashboard:handoff-parent";
const handoffMarker = "[Side conversation handoff]";
const tempDirs: string[] = [];
let storePath: string;
let sequence = 0;

beforeEach(() => {
  storePath = path.join(makeTempDir(tempDirs, "handoff-prompt-"), "sessions.json");
  streamMocks.streamSimple.mockImplementation((model: Model) =>
    createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }])),
  );
});

afterEach(async () => {
  clearSideConversationHandoffClaimsForTest();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

async function seedPendingHandoff(): Promise<void> {
  const entry: InternalSessionEntry = {
    sessionId: "parent-session",
    updatedAt: 1,
    sideConversationHandoffs: {
      version: 1,
      nextSequence: 2,
      pending: [
        {
          sequence: 1,
          sessionKey: "agent:main:dashboard:side-1",
          intentId: "intent-1",
          ordinal: 1,
          title: "Parser cleanup",
          closedAt: 1_700_000_000_000,
          worktree: {
            branch: "openclaw/side-parser",
            path: "/tmp/side-parser",
            changedFiles: 2,
            commitsAhead: 1,
          },
        },
      ],
    },
  };
  await replaceSessionEntry({ agentId: "main", sessionKey: parentKey, storePath }, entry);
}

function readQueue() {
  const entry = loadSessionEntry({
    agentId: "main",
    sessionKey: parentKey,
    storePath,
    readConsistency: "latest",
  }) as InternalSessionEntry | undefined;
  return readSideConversationHandoffQueue(entry);
}

function readPending(): number {
  return readQueue().pending.length;
}

type Fixture = {
  attempt: EmbeddedRunAttemptParams;
  assemble: () => ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>;
  releasedClaims: Array<(() => Promise<void>) | undefined>;
  submit: (
    assembly: Awaited<ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>>,
    promptActiveSession?: Parameters<typeof submitEmbeddedAttemptPrompt>[0]["promptActiveSession"],
  ) => Promise<void>;
  session: Awaited<ReturnType<typeof createTestSession>>["session"];
};

async function fixture(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
  options: {
    applyPromptBuildToolsAllow?: () => string[];
    isRawModelRun?: boolean;
  } = {},
): Promise<Fixture> {
  const runId = `handoff-${++sequence}`;
  const releasedClaims: Array<(() => Promise<void>) | undefined> = [];
  const { session, sessionManager, modelRegistry } = await createTestSession();
  session.setActiveToolsByName([]);
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "handoff-prompt-test");
  onTestFinished(() => {
    admission.close();
  });
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    config: {},
    model: testModel,
    modelId: testModel.id,
    provider: testModel.provider,
    thinkLevel: "off",
    prompt: "Hello",
    transcriptPrompt: "Hello",
    runId,
    sessionId: runId,
    sessionKey: parentKey,
    sessionTarget: { agentId: "main", sessionId: runId, sessionKey: parentKey, storePath },
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
    workspaceDir: "/tmp/handoff-prompt-test",
    ...overrides,
  };
  const assemble = () =>
    prepareEmbeddedAttemptPromptAssembly({
      attempt,
      activeSession: session,
      sessionManager,
      hookRunner: null,
      hookAgentId: "main",
      diagnosticTrace: { traceId: "11111111111111111111111111111111" },
      isRawModelRun: options.isRawModelRun === true,
      sessionAgentId: "main",
      runtimeModel: testModel.id,
      systemPromptText: "Base system prompt",
      runAbortSignal: new AbortController().signal,
      applyPromptBuildToolsAllow: options.applyPromptBuildToolsAllow ?? (() => []),
      setActiveSessionSystemPrompt: () => {},
      setLeasedSteering: () => {},
      setHandoffRelease: (release) => {
        releasedClaims.push(release);
      },
    });
  const submit = async (
    assembly: Awaited<ReturnType<typeof prepareEmbeddedAttemptPromptAssembly>>,
    promptActiveSession?: Parameters<typeof submitEmbeddedAttemptPrompt>[0]["promptActiveSession"],
  ) =>
    await submitEmbeddedAttemptPrompt({
      attempt,
      activeSession: session,
      contextTokenBudget: 8_000,
      images: [],
      modelPrompt: assembly.effectivePrompt,
      transcriptPrompt: assembly.effectiveTranscriptPrompt,
      systemPrompt: session.agent.state.systemPrompt,
      runtimeOnly: false,
      toolResultPromptProjectionState: getEmbeddedSessionPromptState(runId).toolResults,
      toolResultMaxChars: 4_000,
      toolResultAggregateMaxChars: 8_000,
      transcriptLeafId: null,
      trajectoryRecorder: null,
      onFinalPromptText: () => {},
      onSteeringAcknowledged: () => {},
      assertHostActive: assembly.assertHostActive,
      persistToolResultProjections: async () => {},
      promptActiveSession:
        promptActiveSession ??
        (async (prompt, promptOptions) => {
          await session.prompt(prompt, promptOptions);
        }),
      ...(assembly.handoffDispatch ? { onPrimaryModelDispatched: assembly.handoffDispatch } : {}),
      ...(assembly.handoffRelease ? { onPrimaryModelNotDispatched: assembly.handoffRelease } : {}),
      ...(assembly.handoffRevalidate ? { handoffRevalidate: assembly.handoffRevalidate } : {}),
      ...(assembly.handoffFreeModelPrompt !== undefined
        ? { handoffFreeModelPrompt: assembly.handoffFreeModelPrompt }
        : {}),
    });
  return { attempt, assemble, releasedClaims, submit, session };
}

describe("side conversation next-message handoff", () => {
  it("prepends the reminder to the model prompt only, once per run", async () => {
    await seedPendingHandoff();
    const f = await fixture();

    const assembly = await f.assemble();
    expect(assembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);
    expect(assembly.effectivePrompt).toContain("Parser cleanup");
    expect(assembly.effectivePrompt).toContain("branch: openclaw/side-parser");
    expect(assembly.effectivePrompt).toContain("1 ahead");
    expect(assembly.effectivePrompt).toContain("2 uncommitted files");
    // The user's own bytes and the transcript prompt never change.
    expect(assembly.effectiveTranscriptPrompt).toBe("Hello");
    expect(assembly.effectivePrompt.match(/\[Side conversation handoff\]/gu)).toHaveLength(1);
    expect(assembly.handoffDispatch).toBeTypeOf("function");

    // A retry of the same run reuses the exact same block, never a duplicate.
    const retried = await f.assemble();
    expect(retried.effectivePrompt).toBe(assembly.effectivePrompt);
    expect(readPending()).toBe(1);
  });

  it("commits delivery only after the model request is dispatched", async () => {
    await seedPendingHandoff();
    const f = await fixture();
    const assembly = await f.assemble();
    expect(assembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);
    await f.submit(assembly);

    expect(readPending()).toBe(0);
    const queue = readQueue();
    expect(queue.dispatching).toBeUndefined();
    expect(queue.delivered?.["intent-1"]).toMatchObject({ sequence: 1 });
    // The durable user turn keeps the prompt bytes the user sent.
    const userMessages = f.session.messages.filter((message) => message.role === "user");
    expect(JSON.stringify(userMessages.at(-1)?.content)).toContain("Hello");
    expect(JSON.stringify(f.session.messages)).not.toContain(handoffMarker);

    // The next user message never repeats the reminder.
    const nextRun = await fixture();
    const nextAssembly = await nextRun.assemble();
    expect(nextAssembly.effectivePrompt).toBe("Hello");
    expect(nextAssembly.handoffDispatch).toBeUndefined();
  });

  it("keeps the reminder pending when the send never happens", async () => {
    await seedPendingHandoff();
    const f = await fixture();
    const assembly = await f.assemble();
    expect(assembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);

    await expect(
      f.submit(assembly, async () => {
        throw new Error("preflight refused before dispatch");
      }),
    ).rejects.toThrow("preflight refused");
    // A submission that never dispatched rolls its claim receipt back.
    expect(readPending()).toBe(1);
    expect(readQueue().dispatching).toBeUndefined();

    // The next real user message still gets it, exactly once.
    const retryRun = await fixture();
    const retryAssembly = await retryRun.assemble();
    expect(retryAssembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);
    await retryRun.submit(retryAssembly);
    expect(readPending()).toBe(0);
  });

  it("writes no receipt when a tool-policy step fails after prompt work starts", async () => {
    await seedPendingHandoff();
    const failing = await fixture(
      {},
      {
        applyPromptBuildToolsAllow: () => {
          throw new Error("post-claim tool policy failed");
        },
      },
    );
    await expect(failing.assemble()).rejects.toThrow("post-claim tool policy failed");
    expect(failing.releasedClaims).toEqual([]);
    expect(readPending()).toBe(1);
    expect(readQueue().dispatching).toBeUndefined();

    // The next real user message still delivers the reminder exactly once.
    const nextRun = await fixture();
    const assembly = await nextRun.assemble();
    expect(assembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);
    await nextRun.submit(assembly);
    expect(readPending()).toBe(0);
    expect(readQueue().delivered?.["intent-1"]).toBeDefined();
  });

  it("transfers claim release ownership before the assembly returns", async () => {
    await seedPendingHandoff();
    const f = await fixture();
    await f.assemble();
    expect(f.releasedClaims).toHaveLength(1);
    expect(f.releasedClaims[0]).toBeTypeOf("function");
    await f.releasedClaims[0]!();
    expect(readPending()).toBe(1);
    expect(readQueue().dispatching).toBeUndefined();
  });

  it("drops the handoff at the provider boundary when reopen cancels it after assembly", async () => {
    await seedPendingHandoff();
    const f = await fixture();
    const assembly = await f.assemble();
    expect(assembly.effectivePrompt.startsWith(handoffMarker)).toBe(true);
    expect(assembly.handoffFreeModelPrompt).toBe("Hello");
    expect(assembly.handoffRevalidate).toBeTypeOf("function");

    expect(
      await cancelPendingSideConversationHandoffs({
        agentId: "main",
        intentId: "intent-1",
        parentSessionKey: parentKey,
        storePath,
      }),
    ).toBe(1);

    const providerPrompts: string[] = [];
    let revalidateCalls = 0;
    const originalRevalidate = assembly.handoffRevalidate!;
    const instrumented = {
      ...assembly,
      handoffRevalidate: async () => {
        revalidateCalls += 1;
        return await originalRevalidate();
      },
    };
    streamMocks.streamSimple.mockImplementation((model: Model, context) => {
      providerPrompts.push(JSON.stringify(context.messages));
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }]));
    });
    await f.submit(instrumented);

    expect(revalidateCalls).toBeGreaterThan(0);

    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).not.toContain(handoffMarker);
    expect(providerPrompts[0]).toContain("Hello");
    const queue = readQueue();
    expect(queue.pending).toHaveLength(0);
    expect(queue.dispatching).toBeUndefined();
    expect(queue.delivered).toBeUndefined();
  });

  it.each([
    ["heartbeat", { trigger: "heartbeat" as const }, {}],
    ["cron", { trigger: "cron" as const }, {}],
    ["continuation", { skipPreparedUserTurnMessage: true }, {}],
    ["internal provenance", { inputProvenance: { kind: "internal_system" as const } }, {}],
    ["inter-session provenance", { inputProvenance: { kind: "inter_session" as const } }, {}],
    ["raw run", {}, { isRawModelRun: true }],
    ["settled-turn finalization", { operation: "settled-tool-finalization" as const }, {}],
  ])("never injects for a %s turn", async (_name, overrides, options) => {
    await seedPendingHandoff();
    const f = await fixture(overrides, options);
    const assembly = await f.assemble();
    expect(assembly.effectivePrompt).toBe("Hello");
    expect(assembly.handoffDispatch).toBeUndefined();
    expect(readPending()).toBe(1);
  });

  it("never injects for an incognito parent", async () => {
    await seedPendingHandoff();
    const f = await fixture({ sessionKey: "agent:main:incognito:handoff" });
    const assembly = await f.assemble();
    expect(assembly.effectivePrompt).toBe("Hello");
    expect(assembly.handoffDispatch).toBeUndefined();
    expect(readPending()).toBe(1);
  });
});
