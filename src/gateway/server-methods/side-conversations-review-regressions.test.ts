import { afterEach, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { buildSideConversationSessionKey } from "../../config/sessions/side-conversation-registry.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { resolveFrozenParentSessionSelection } from "../session-create-model-selection.js";
import { resolveEffectiveSessionThinkingLevel } from "../session-utils-model.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import {
  archiveSideConversationChildrenInParentFence,
  deleteSideConversationChildrenInParentFence,
} from "./side-conversations-fence.js";
import type { GatewayRequestContext } from "./types.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

const parentKey = "agent:main:dashboard:review-parent";
const catalogEntries: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => {
      const config = getRuntimeConfig();
      return {
        entries: catalogEntries,
        routeVariants: catalogEntries,
        agentId: "main",
        agentDir: "/tmp/openclaw-review-agent",
        workspaceDir: "/tmp/openclaw-review-workspace",
        config,
        catalogComplete: true,
      };
    },
  };
}

const client = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    role: "operator",
    scopes: ["operator.read", "operator.write"],
  },
} as never;

function readEntry(storePath: string, sessionKey: string): InternalSessionEntry | undefined {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

async function createParent(
  storePath: string,
  model?: string,
  options: {
    thinkingLevel?: string | null;
    cfg?: unknown;
    catalog?: ModelCatalogEntry[];
  } = {},
) {
  const created = await directSessionReq(
    "sessions.create",
    {
      key: parentKey,
      agentId: "main",
      ...(model ? { model } : {}),
      ...((options.thinkingLevel ?? "high")
        ? { thinkingLevel: options.thinkingLevel ?? "high" }
        : {}),
    },
    {
      client,
      context: {
        ...modelCatalogContext(),
        ...(options.cfg ? { getRuntimeConfig: () => options.cfg } : {}),
        ...(options.catalog
          ? {
              loadGatewayModelCatalogSnapshot: async () => ({
                entries: options.catalog,
                routeVariants: options.catalog,
                agentId: "main",
                agentDir: "/tmp/openclaw-review-agent",
                workspaceDir: "/tmp/openclaw-review-workspace",
                config: options.cfg ?? getRuntimeConfig(),
                catalogComplete: true,
              }),
            }
          : {}),
      },
    },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const parent = readEntry(storePath, parentKey)!;
  await seedSessionTranscript({
    agentId: "main",
    sessionId: parent.sessionId,
    sessionKey: parentKey,
    storePath,
    messages: [
      { role: "user", content: "parent question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "parent answer" }],
        stopReason: "endTurn",
      },
    ],
  });
  return parent;
}

async function createSide(
  intentId: string,
): Promise<{ created: boolean; sessionKey: string; snapshot?: { retainedMessages: number } }> {
  const result = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string; snapshot?: { retainedMessages: number } };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId },
    { client, context: modelCatalogContext() },
  );
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return {
    created: result.payload!.created,
    sessionKey: result.payload!.conversation.sessionKey,
    ...(result.payload!.conversation.snapshot
      ? { snapshot: result.payload!.conversation.snapshot }
      : {}),
  };
}

function fenceContext(): GatewayRequestContext {
  return createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
  });
}

test("concurrent creates for one intent all replay the same committed child", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      directSessionReq<{ created: boolean; conversation: { sessionKey: string } }>(
        "sideConversations.create",
        { parentSessionKey: parentKey, intentId: "concurrent-intent" },
        { client, context: modelCatalogContext() },
      ),
    ),
  );
  expect(
    attempts.every((result) => result.ok),
    JSON.stringify(attempts),
  ).toBe(true);
  const keys = new Set(attempts.map((result) => result.payload!.conversation.sessionKey));
  expect(keys.size).toBe(1);
  expect(attempts.filter((result) => result.payload!.created)).toHaveLength(1);
});

test("prototype-named intents are schema-rejected or stored as own properties", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const rejected = await directSessionReq(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "__proto__" },
    { client, context: modelCatalogContext() },
  );
  expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

  // Identifier-shaped prototype names pass the schema but are ordinary own
  // properties; they must not read inherited Object state.
  for (const [ordinal, intentId] of ["constructor", "toString", "prototype"].entries()) {
    const created = await directSessionReq<{
      conversation: { intentId: string; ordinal: number; state: string; sessionKey: string };
    }>(
      "sideConversations.create",
      { parentSessionKey: parentKey, intentId },
      { client, context: modelCatalogContext() },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.conversation).toMatchObject({
      intentId,
      ordinal: ordinal + 1,
      state: "open",
    });
  }
  const parent = readEntry(storePath, parentKey)!;
  expect(Object.keys(parent.sideConversations?.conversations ?? {})).toEqual([
    "constructor",
    "toString",
    "prototype",
  ]);
  expect(Object.getPrototypeOf(parent.sideConversations!.conversations)).toBe(Object.prototype);
  const listed = await directSessionReq<{ sideConversations: Array<{ intentId: string }> }>(
    "sideConversations.list",
    { parentSessionKey: parentKey },
    { client },
  );
  expect(listed.payload?.sideConversations.map((row) => row.intentId)).toEqual([
    "constructor",
    "toString",
    "prototype",
  ]);
});

test("a preclaimed deterministic key is not registered, counted, or permanently poisoned", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath, "anthropic/claude-opus-4-6");
  const childKey = buildSideConversationSessionKey({
    agentId: "main",
    parentSessionKey: parentKey,
    intentId: "preclaimed-intent",
  });
  const ordinary = await directSessionReq(
    "sessions.create",
    { key: childKey, agentId: "main", model: "anthropic/claude-sonnet-4-6" },
    { client, context: modelCatalogContext() },
  );
  expect(ordinary.ok, JSON.stringify(ordinary.error)).toBe(true);

  const conflict = await directSessionReq(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "preclaimed-intent" },
    { client, context: modelCatalogContext() },
  );
  expect(conflict).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(parent.sessionId).toBeTruthy();
  const afterConflict = readEntry(storePath, parentKey)!;
  expect(afterConflict.sideConversations?.conversations["preclaimed-intent"]).toBeUndefined();
  const listed = await directSessionReq<{ sideConversations: unknown[] }>(
    "sideConversations.list",
    { parentSessionKey: parentKey },
    { client },
  );
  expect(listed.payload?.sideConversations).toEqual([]);
});

test("crash replay recovers frozen snapshot facts from the child transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("replay-intent");
  expect(created.created).toBe(true);
  const parent = readEntry(storePath, parentKey)!;
  const registration = parent.sideConversations!.conversations["replay-intent"]!;
  expect(registration.snapshot?.retainedMessages).toBeGreaterThan(0);

  // Simulate a crash between the child commit and the registry finalize.
  await patchSessionEntryCore(
    { agentId: "main", sessionKey: parentKey, storePath },
    (current) => ({
      ...current,
      sideConversations: {
        version: 1 as const,
        nextOrdinal: current.sideConversations!.nextOrdinal,
        conversations: {
          "replay-intent": {
            ...registration,
            sessionId: undefined,
            snapshot: undefined,
          },
        },
      },
    }),
    { replaceEntry: true, skipMaintenance: true },
  );

  const replay = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string; snapshot?: { retainedMessages: number } };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "replay-intent" },
    { client, context: modelCatalogContext() },
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload?.created).toBe(false);
  expect(replay.payload?.conversation.sessionKey).toBe(created.sessionKey);
  expect(replay.payload?.conversation.snapshot?.retainedMessages).toBe(
    registration.snapshot!.retainedMessages,
  );
  const healed = readEntry(storePath, parentKey)!;
  expect(healed.sideConversations?.conversations["replay-intent"]?.snapshot?.retainedMessages).toBe(
    registration.snapshot!.retainedMessages,
  );
});

test("creation freezes a parent selection that only came from config defaults", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath);
  const cfg = getRuntimeConfig();
  const effective = resolveSessionModelRef(cfg, parent, "main");
  const created = await createSide("default-freeze-intent");
  const child = readEntry(storePath, created.sessionKey)!;

  // The parent had no stored override; the child still persists the effective pair.
  expect(parent.modelOverride).toBeUndefined();
  expect(child.providerOverride).toBe(effective.provider);
  expect(child.modelOverride).toBe(effective.model);
  expect(child.thinkingLevel).toBeTruthy();

  const changedCfg = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, model: "unit-test/other-default" },
    },
  };
  expect(resolveSessionModelRef(changedCfg, child, "main")).toEqual(effective);
  // The parent still follows the config default, proving the child is frozen.
  expect(resolveSessionModelRef(changedCfg, parent, "main")).not.toEqual(effective);
});

test("parent delete refuses work accepted after the child preflight", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("late-active-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;
  const context = fenceContext();

  // Acquired work before the fence: the preflight refuses and keeps the child.
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [created.sessionKey, child.sessionId],
    assertAllowed: () => {},
  });
  const blocked = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
    cfg: getRuntimeConfig(),
    context,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {},
  });
  expect(blocked).toMatchObject({
    ok: true,
    deletedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, created.sessionKey)).toBeTruthy();
  lease.release();

  // Work attempted in the first post-preflight commit guard is rejected because
  // the helper closes the child's ingress before its first durable write.
  let admissionAttempt: Promise<unknown> | undefined;
  const deleted = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
    cfg: getRuntimeConfig(),
    context,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {
      admissionAttempt ??= beginSessionWorkAdmission({
        scope: storePath,
        identities: [created.sessionKey, child.sessionId],
        assertAllowed: () => {},
      }).catch((error: unknown) => error);
    },
  });
  expect(deleted).toMatchObject({
    ok: true,
    deletedKeys: [created.sessionKey],
    remaining: [],
  });
  expect(await admissionAttempt).toBeInstanceOf(Error);
  expect(readEntry(storePath, created.sessionKey)).toBeUndefined();
});

test("archive fence refuses a child that owns authoritative work", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("archive-active-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [created.sessionKey, child.sessionId],
    assertAllowed: () => {},
  });
  const archived = await archiveSideConversationChildrenInParentFence({
    cfg: getRuntimeConfig(),
    agentId: "main",
    context: fenceContext(),
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    commitGuard: () => {},
  });
  expect(archived).toMatchObject({
    archivedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, created.sessionKey)?.archivedAt).toBeUndefined();
  lease.release();
});

test("parent archive RPC refuses an active child and leaves it unarchived", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("archive-rpc-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [created.sessionKey, child.sessionId],
    assertAllowed: () => {},
  });
  try {
    const archived = await directSessionReq(
      "sessions.patch",
      { key: parentKey, archived: true, expectedSessionId: parent.sessionId },
      { client },
    );
    expect(archived.ok).toBe(false);
    expect(readEntry(storePath, created.sessionKey)?.archivedAt).toBeUndefined();
  } finally {
    lease.release();
  }
});

test("canonical worker and terminal work block parent delete and keep the child", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("worker-claim-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;

  const claimContext = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    workerSessionPlacementService: {
      getMany: (sessionIds: string[]) =>
        new Map(
          sessionIds.map((sessionId) => [
            sessionId,
            { turnClaim: { sessionId, runId: "worker-run" } },
          ]),
        ),
    } as never,
  });
  const blockedByClaim = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
    cfg: getRuntimeConfig(),
    context: claimContext,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {},
  });
  expect(blockedByClaim).toMatchObject({
    ok: true,
    deletedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, created.sessionKey)).toBeTruthy();

  const terminalContext = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    terminalSessions: { hasAgentSessionWork: () => true } as never,
  });
  const blockedByTerminal = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
    cfg: getRuntimeConfig(),
    context: terminalContext,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {},
  });
  expect(blockedByTerminal).toMatchObject({
    ok: true,
    deletedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, created.sessionKey)?.sessionId).toBe(child.sessionId);
});

test("frozen thinking matches the parent projection for a reasoning runtime model", () => {
  const base = getRuntimeConfig();
  const mainEntry = (base.agents?.entries as Record<string, object> | undefined)?.main;
  const cfg = {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        model: "demo/reasoning-model",
        thinkingDefault: undefined,
      },
      entries: {
        ...base.agents?.entries,
        main: { ...mainEntry, thinkingDefault: undefined, model: undefined },
      },
    },
  };
  const parentEntry = {
    sessionId: "thinking-parent-incarnation",
    updatedAt: 1,
  } as SessionEntry;
  const catalog: ModelCatalogEntry[] = [
    { provider: "demo", id: "reasoning-model", name: "Reasoning", reasoning: true },
  ];
  // Without the runtime catalog the reasoning model looks like a non-reasoning
  // model and resolves "off"; the parent's Gateway projection resolves "medium".
  const withoutRuntimeCatalog = resolveEffectiveSessionThinkingLevel({
    cfg,
    provider: "demo",
    model: "reasoning-model",
    agentId: "main",
    sessionKey: parentKey,
    entry: parentEntry,
    preparedAcpMeta: null,
  });
  expect(withoutRuntimeCatalog).toBe("off");
  const parentEffective = resolveEffectiveSessionThinkingLevel({
    cfg,
    provider: "demo",
    model: "reasoning-model",
    agentId: "main",
    sessionKey: parentKey,
    entry: parentEntry,
    preparedAcpMeta: null,
    modelCatalog: catalog,
    modelCatalogRouteVariants: catalog,
  });
  expect(parentEffective).toBe("medium");

  const frozen = resolveFrozenParentSessionSelection({
    cfg,
    agentId: "main",
    parentEntry,
    parentSessionKey: parentKey,
    modelCatalog: catalog,
    modelCatalogRouteVariants: catalog,
  });
  expect(frozen).toMatchObject({
    provider: "demo",
    model: "reasoning-model",
    thinkingLevel: parentEffective,
  });
});

test("archive preparation releases the parent drain when child interruption throws", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("interrupt-throw-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  let releasePending: (() => void) | undefined;
  const pending = beginSessionWorkAdmission({
    scope: storePath,
    identities: [created.sessionKey, child.sessionId],
    assertAllowed: () =>
      new Promise<void>((resolve) => {
        releasePending = resolve;
      }),
    onInterrupt: () => {
      throw new Error("interrupt boom");
    },
  }).catch((error: unknown) => error);

  const archived = await directSessionReq(
    "sessions.patch",
    { key: parentKey, archived: true, expectedSessionId: parent.sessionId },
    { client },
  );
  expect(archived.ok).toBe(false);

  // The failed preparation must not leave the parent fenced or leak interruptions
  // into unrelated sessions.
  const parentLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [parentKey, parent.sessionId],
    assertAllowed: () => {},
  });
  parentLease.release();
  const unrelatedLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:unrelated"],
    assertAllowed: () => {},
  });
  unrelatedLease.release();
  releasePending?.();
  expect(await pending).toBeInstanceOf(Error);
  expect(readEntry(storePath, created.sessionKey)?.archivedAt).toBeUndefined();
});

test("replay rejects a marker without the expected parent incarnation", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("incarnation-mismatch-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  await patchSessionEntryCore(
    { agentId: "main", sessionKey: created.sessionKey, storePath },
    (current) => ({
      ...current,
      sideConversation: current.sideConversation
        ? { ...current.sideConversation, parentSessionId: undefined }
        : undefined,
    }),
    { replaceEntry: true, skipMaintenance: true },
  );
  expect(child.sideConversation?.parentSessionId).toBeTruthy();

  const replay = await directSessionReq(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "incarnation-mismatch-intent" },
    { client, context: modelCatalogContext() },
  );
  expect(replay).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  const parent = readEntry(storePath, parentKey)!;
  expect(parent.sideConversations?.conversations["incarnation-mismatch-intent"]).toBeUndefined();
});

test("replay ignores boundary snapshot facts that name another parent", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("forged-snapshot-intent");
  const child = readEntry(storePath, created.sessionKey)!;
  const events = loadTranscriptEventsSync({
    agentId: "main",
    sessionKey: created.sessionKey,
    sessionId: child.sessionId,
    storePath,
  });
  const forgeBoundary = (event: unknown): unknown => {
    const record = event as Record<string, unknown>;
    if (record.customType !== "openclaw.side-conversation-snapshot") {
      return event;
    }
    const details = record.details as { source?: string; snapshot?: Record<string, unknown> };
    return {
      ...record,
      details: {
        ...details,
        snapshot: {
          ...details.snapshot,
          sourceSessionKey: "agent:main:dashboard:some-other-parent",
          sourceSessionId: "some-other-parent-incarnation",
        },
      },
    };
  };
  const forged = events.map(forgeBoundary);
  await replaceTranscriptEvents(
    {
      agentId: "main",
      sessionKey: created.sessionKey,
      sessionId: child.sessionId,
      storePath,
    },
    forged,
  );
  const parent = readEntry(storePath, parentKey)!;
  const registration = parent.sideConversations!.conversations["forged-snapshot-intent"]!;
  await patchSessionEntryCore(
    { agentId: "main", sessionKey: parentKey, storePath },
    (current) => ({
      ...current,
      sideConversations: {
        version: 1 as const,
        nextOrdinal: current.sideConversations!.nextOrdinal,
        conversations: {
          "forged-snapshot-intent": { ...registration, sessionId: undefined, snapshot: undefined },
        },
      },
    }),
    { replaceEntry: true, skipMaintenance: true },
  );

  const replay = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string; snapshot?: unknown };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "forged-snapshot-intent" },
    { client, context: modelCatalogContext() },
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload?.created).toBe(false);
  expect(replay.payload?.conversation.snapshot).toBeUndefined();
  expect(
    readEntry(storePath, parentKey)?.sideConversations?.conversations["forged-snapshot-intent"]
      ?.snapshot,
  ).toBeUndefined();
});

test("archive never emits a non-preservation lifecycle reason as preserved", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("invalid-preserved-intent");
  await patchSessionEntryCore(
    { agentId: "main", sessionKey: created.sessionKey, storePath },
    (current) => ({
      ...current,
      worktree: { id: "wt-invalid-preserved", branch: "branch-invalid", repoRoot: "/repo" },
    }),
    { replaceEntry: true, skipMaintenance: true },
  );
  const child = readEntry(storePath, created.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;
  let calls = 0;
  const archived = await archiveSideConversationChildrenInParentFence({
    cfg: getRuntimeConfig(),
    agentId: "main",
    context: fenceContext(),
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    commitGuard: () => {
      calls += 1;
      if (calls === 2) {
        const current = readEntry(storePath, created.sessionKey)!;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: created.sessionKey, storePath },
          { ...current, lifecycleRevision: "rev-bumped" },
        );
      }
    },
  });
  expect(archived).toMatchObject({
    archivedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ARCHIVE_FAILED" }],
  });
  expect(readEntry(storePath, created.sessionKey)?.archivedAt).toBeUndefined();
  expect(child.worktree?.id).toBe("wt-invalid-preserved");
});

function lateClaimContext(isActive: (sessionId: string) => boolean): GatewayRequestContext {
  return createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    workerSessionPlacementService: {
      getMany: (sessionIds: string[]) =>
        new Map(
          sessionIds
            .filter((sessionId) => isActive(sessionId))
            .map((sessionId) => [sessionId, { turnClaim: { sessionId, runId: "late-run" } }]),
        ),
      listPendingWorkspaceResultsAsync: async () => [],
      waitForTurnClaimRelease: async () => true,
    } as never,
  });
}

test("archive final durable write runs the guard after a microtask activation", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("final-guard-intent");
  const parent = readEntry(storePath, parentKey)!;
  let active = false;
  let calls = 0;
  const archived = await archiveSideConversationChildrenInParentFence({
    cfg: getRuntimeConfig(),
    agentId: "main",
    context: lateClaimContext(() => active),
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    commitGuard: () => {
      calls += 1;
      if (calls === 1) {
        queueMicrotask(() => {
          active = true;
        });
      }
    },
  });
  expect(archived).toMatchObject({
    archivedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  const child = readEntry(storePath, created.sessionKey)!;
  expect(child.archivedAt).toBeUndefined();
  expect(child.sideConversation?.state).toBe("open");
});

test("archive final durable write runs the guard after a terminal microtask activation", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const created = await createSide("final-terminal-intent");
  const parent = readEntry(storePath, parentKey)!;
  let active = false;
  let calls = 0;
  const context = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    terminalSessions: { hasAgentSessionWork: () => active } as never,
  });
  const archived = await archiveSideConversationChildrenInParentFence({
    cfg: getRuntimeConfig(),
    agentId: "main",
    context,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    commitGuard: () => {
      calls += 1;
      if (calls === 1) {
        queueMicrotask(() => {
          active = true;
        });
      }
    },
  });
  expect(archived).toMatchObject({
    archivedKeys: [],
    remaining: [{ key: created.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, created.sessionKey)?.archivedAt).toBeUndefined();
});

test("parent archive returns an explicit partial result when the second child activates", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath, "anthropic/claude-opus-4-6");
  const first = await createSide("partial-archive-first");
  const second = await createSide("partial-archive-second");
  const secondChild = readEntry(storePath, second.sessionKey)!;
  const context = lateClaimContext(
    (sessionId) =>
      sessionId === secondChild.sessionId &&
      readEntry(storePath, first.sessionKey)?.archivedAt !== undefined,
  );
  const archived = await directSessionReq<{
    parentArchived?: boolean;
    applied?: boolean;
    archivedKeys?: string[];
    remainingSideConversations?: Array<{ key: string; code: string }>;
    partial?: boolean;
  }>(
    "sessions.patch",
    { key: parentKey, archived: true, expectedSessionId: parent.sessionId },
    { client, context },
  );
  expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
  expect(archived.payload).toMatchObject({
    parentArchived: true,
    applied: true,
    archivedKeys: [first.sessionKey],
    remainingSideConversations: [{ key: second.sessionKey, code: "CHILD_ACTIVE" }],
    partial: true,
  });
  expect(readEntry(storePath, parentKey)?.archivedAt).toBeTruthy();
  expect(readEntry(storePath, first.sessionKey)?.archivedAt).toBeTruthy();
  expect(readEntry(storePath, first.sessionKey)?.sideConversation?.state).toBe("closed");
  expect(readEntry(storePath, second.sessionKey)?.archivedAt).toBeUndefined();
  expect(readEntry(storePath, second.sessionKey)?.sideConversation?.state).toBe("open");
});

test("parent delete returns an explicit partial result and keeps the parent and later child", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const first = await createSide("partial-delete-first");
  const second = await createSide("partial-delete-second");
  const secondChild = readEntry(storePath, second.sessionKey)!;
  const context = lateClaimContext(
    (sessionId) =>
      sessionId === secondChild.sessionId && readEntry(storePath, first.sessionKey) === undefined,
  );
  const deleted = await directSessionReq<{
    deleted: boolean;
    partial?: boolean;
    deletedKeys?: string[];
    remainingSideConversations?: Array<{ key: string; code: string }>;
  }>("sessions.delete", { key: parentKey }, { client, context });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload).toMatchObject({
    deleted: false,
    partial: true,
    deletedKeys: [first.sessionKey],
    remainingSideConversations: [{ key: second.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, parentKey)).toBeTruthy();
  expect(readEntry(storePath, first.sessionKey)).toBeUndefined();
  expect(readEntry(storePath, second.sessionKey)?.sessionId).toBe(secondChild.sessionId);
  const parentAfter = readEntry(storePath, parentKey)!;
  expect(Object.keys(parentAfter.sideConversations?.conversations ?? {})).toEqual([
    "partial-delete-second",
  ]);
  const listed = await directSessionReq<{
    sessions: Array<{ key: string; sideConversationCount?: number }>;
    sideConversations?: Array<{ sessionKey: string }>;
  }>("sessions.list", { agentId: "main" }, { client });
  expect(listed.payload?.sessions.find((row) => row.key === parentKey)?.sideConversationCount).toBe(
    1,
  );
  const listedSides = await directSessionReq<{ sideConversations: Array<{ sessionKey: string }> }>(
    "sideConversations.list",
    { parentSessionKey: parentKey },
    { client },
  );
  expect(listedSides.payload?.sideConversations.map((row) => row.sessionKey)).toEqual([
    second.sessionKey,
  ]);
});

test("direct archive with two children reports the active second child partially", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const first = await createSide("direct-partial-archive-first");
  const second = await createSide("direct-partial-archive-second");
  const secondChild = readEntry(storePath, second.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;
  const archived = await archiveSideConversationChildrenInParentFence({
    cfg: getRuntimeConfig(),
    agentId: "main",
    context: lateClaimContext(
      (sessionId) =>
        sessionId === secondChild.sessionId &&
        readEntry(storePath, first.sessionKey)?.archivedAt !== undefined,
    ),
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    commitGuard: () => {},
  });
  expect(archived).toMatchObject({
    archivedKeys: [first.sessionKey],
    remaining: [{ key: second.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, first.sessionKey)?.archivedAt).toBeTruthy();
  expect(readEntry(storePath, second.sessionKey)?.archivedAt).toBeUndefined();
});

test("direct delete with two children reports the deleted first and keeps registry consistent", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "anthropic/claude-opus-4-6");
  const first = await createSide("direct-partial-delete-first");
  const second = await createSide("direct-partial-delete-second");
  const secondChild = readEntry(storePath, second.sessionKey)!;
  const parent = readEntry(storePath, parentKey)!;
  const deleted = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
    cfg: getRuntimeConfig(),
    context: lateClaimContext(
      (sessionId) =>
        sessionId === secondChild.sessionId && readEntry(storePath, first.sessionKey) === undefined,
    ),
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {},
  });
  expect(deleted).toMatchObject({
    ok: true,
    deletedKeys: [first.sessionKey],
    remaining: [{ key: second.sessionKey, code: "CHILD_ACTIVE" }],
  });
  expect(readEntry(storePath, first.sessionKey)).toBeUndefined();
  expect(readEntry(storePath, second.sessionKey)?.sessionId).toBe(secondChild.sessionId);
  expect(
    Object.keys(readEntry(storePath, parentKey)?.sideConversations?.conversations ?? {}),
  ).toEqual(["direct-partial-delete-second"]);
});
