import { afterEach, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { buildSideConversationSessionKey } from "../../config/sessions/side-conversation-registry.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
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

async function createParent(storePath: string, model?: string) {
  const created = await directSessionReq(
    "sessions.create",
    {
      key: parentKey,
      agentId: "main",
      ...(model ? { model } : {}),
      thinkingLevel: "high",
    },
    { client, context: modelCatalogContext() },
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
    context,
    parentEntry: parent,
    parentSessionKey: parentKey,
    storePath,
    deleteTranscript: true,
    commitGuard: () => {},
  });
  expect(blocked).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(readEntry(storePath, created.sessionKey)).toBeTruthy();
  lease.release();

  // Work attempted in the first post-preflight commit guard is rejected because
  // the helper closes the child's ingress before its first durable write.
  let admissionAttempt: Promise<unknown> | undefined;
  const deleted = await deleteSideConversationChildrenInParentFence({
    agentId: "main",
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
  expect(deleted).toMatchObject({ ok: true, deletedKeys: [created.sessionKey] });
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
  expect(archived).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
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
