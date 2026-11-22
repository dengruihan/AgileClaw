import { afterEach, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
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
import { archiveSideConversationChildrenInParentFence } from "./side-conversations-fence.js";
import { closePersistentSideConversation } from "./side-conversations-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  throwWorktree: false,
  failIntentCleanup: undefined as string | undefined,
}));

vi.mock("../../sessions/session-worktree-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-worktree-lifecycle.js")>();
  return {
    ...actual,
    removeSessionWorktree: vi.fn(async (params: { commitGuard?: () => void }) => {
      if (!mockState.throwWorktree) {
        return undefined;
      }
      params.commitGuard?.();
      throw new Error("injected post-delete authority loss");
    }),
  };
});

vi.mock("../../config/sessions/side-conversation-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/side-conversation-registry.js")>();
  return {
    ...actual,
    removeSideConversationIntent: vi.fn(async (params: { intentId: string }) => {
      if (mockState.failIntentCleanup === params.intentId) {
        throw new Error("registry cleanup boom");
      }
      return actual.removeSideConversationIntent(params);
    }),
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  mockState.throwWorktree = false;
  mockState.failIntentCleanup = undefined;
  closeOpenClawStateDatabaseForTest();
});

const parentKey = "agent:main:dashboard:durable-parent";
const catalogEntries: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: catalogEntries,
      routeVariants: catalogEntries,
      agentId: "main",
      agentDir: "/tmp/openclaw-durable-agent",
      workspaceDir: "/tmp/openclaw-durable-workspace",
      config: getRuntimeConfig(),
      catalogComplete: true,
    }),
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

function fenceContext(): GatewayRequestContext {
  return createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
  });
}

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

async function createParent(storePath: string) {
  const created = await directSessionReq(
    "sessions.create",
    { key: parentKey, agentId: "main", model: "anthropic/claude-opus-4-6" },
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

async function createSide(storePath: string, intentId: string, worktreeId?: string) {
  const created = await directSessionReq<{ conversation: { sessionKey: string } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.conversation.sessionKey;
  if (worktreeId) {
    await patchSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      (current) => ({
        ...current,
        worktree: { id: worktreeId, branch: `branch-${worktreeId}`, repoRoot: "/repo" },
      }),
      { replaceEntry: true, skipMaintenance: true },
    );
  }
  return sessionKey;
}

test("archive maps a final-write incarnation mismatch to CHILD_CHANGED", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const created = await createSide(storePath, "mismatch-direct-intent");
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
      if (calls === 1) {
        const current = readEntry(storePath, created)!;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: created, storePath },
          { ...current, lifecycleRevision: "moved-before-archive" },
        );
      }
    },
  });
  expect(archived).toMatchObject({
    archivedKeys: [],
    remaining: [{ key: created, code: "CHILD_CHANGED" }],
    preserved: [],
  });
  const child = readEntry(storePath, created)!;
  expect(child.archivedAt).toBeUndefined();
  expect(child.sideConversation?.state).toBe("open");
  expect(
    readEntry(storePath, parentKey)?.sideConversations?.conversations["mismatch-direct-intent"]
      ?.state,
  ).toBe("open");
});

test("sessions.patch reports CHILD_CHANGED when the child moves before the final archive write", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath);
  const created = await createSide(storePath, "mismatch-rpc-intent");
  let bumped = false;
  const context = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    workerSessionPlacementService: {
      getMany: () => {
        if (!bumped && readEntry(storePath, parentKey)?.archivedAt !== undefined) {
          bumped = true;
          const current = readEntry(storePath, created)!;
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: created, storePath },
            { ...current, lifecycleRevision: "moved-during-rpc-archive" },
          );
        }
        return new Map();
      },
      listPendingWorkspaceResultsAsync: async () => [],
      waitForTurnClaimRelease: async () => true,
    } as never,
  });
  const archived = await directSessionReq<{
    parentArchived?: boolean;
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
    archivedKeys: [],
    remainingSideConversations: [{ key: created, code: "CHILD_CHANGED" }],
    partial: true,
  });
  const child = readEntry(storePath, created)!;
  expect(child.archivedAt).toBeUndefined();
  expect(child.sideConversation?.state).toBe("open");
  expect(
    readEntry(storePath, parentKey)?.sideConversations?.conversations["mismatch-rpc-intent"]?.state,
  ).toBe("open");
});

test("post-delete worktree guard failure keeps deleted facts and reports cleanup pending", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const first = await createSide(storePath, "post-delete-first", "wt-post-delete");
  const second = await createSide(storePath, "post-delete-second");
  const secondChild = readEntry(storePath, second)!;
  mockState.throwWorktree = true;
  const context = lateClaimContext(
    (sessionId) => sessionId === secondChild.sessionId && readEntry(storePath, first) === undefined,
  );
  const deleted = await directSessionReq<{
    deleted: boolean;
    partial?: boolean;
    deletedKeys?: string[];
    remainingSideConversations?: Array<{ key: string; code: string }>;
    cleanupPending?: Array<{ key: string; code: string }>;
  }>("sessions.delete", { key: parentKey }, { client, context });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload).toMatchObject({
    deleted: false,
    partial: true,
    deletedKeys: [first],
    remainingSideConversations: [{ key: second, code: "CHILD_ACTIVE" }],
    cleanupPending: [{ key: first, code: "POST_DELETE_CLEANUP_FAILED" }],
  });
  expect(readEntry(storePath, parentKey)).toBeTruthy();
  expect(readEntry(storePath, first)).toBeUndefined();
  expect(readEntry(storePath, second)?.sessionId).toBe(secondChild.sessionId);
  expect(
    Object.keys(readEntry(storePath, parentKey)?.sideConversations?.conversations ?? {}),
  ).toEqual(["post-delete-second"]);
});

test("registry cleanup failure stays visible and is retried by the next create", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const first = await createSide(storePath, "cleanup-fail-first");
  const second = await createSide(storePath, "cleanup-fail-second");
  const secondChild = readEntry(storePath, second)!;
  mockState.failIntentCleanup = "cleanup-fail-first";
  const context = lateClaimContext(
    (sessionId) => sessionId === secondChild.sessionId && readEntry(storePath, first) === undefined,
  );
  const deleted = await directSessionReq<{
    deleted: boolean;
    partial?: boolean;
    deletedKeys?: string[];
    remainingSideConversations?: Array<{ key: string; code: string }>;
    cleanupPending?: Array<{ key: string; code: string }>;
  }>("sessions.delete", { key: parentKey }, { client, context });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload).toMatchObject({
    deleted: false,
    partial: true,
    deletedKeys: [first],
    remainingSideConversations: [{ key: second, code: "CHILD_ACTIVE" }],
    cleanupPending: [{ key: first, code: "REGISTRY_CLEANUP_PENDING" }],
  });
  expect(readEntry(storePath, first)).toBeUndefined();
  const parentAfter = readEntry(storePath, parentKey)!;
  expect(Object.keys(parentAfter.sideConversations?.conversations ?? {})).toEqual([
    "cleanup-fail-first",
    "cleanup-fail-second",
  ]);
  const listed = await directSessionReq<{
    sessions: Array<{ key: string; sideConversationCount?: number }>;
  }>("sessions.list", { agentId: "main" }, { client });
  expect(listed.payload?.sessions.find((row) => row.key === parentKey)?.sideConversationCount).toBe(
    1,
  );
  const sides = await directSessionReq<{
    sideConversations: Array<{ sessionKey: string }>;
    cleanupPending?: Array<{ intentId: string; sessionKey: string }>;
  }>("sideConversations.list", { parentSessionKey: parentKey }, { client });
  expect(sides.payload?.sideConversations.map((row) => row.sessionKey)).toEqual([second]);
  expect(sides.payload?.cleanupPending).toEqual([
    { intentId: "cleanup-fail-first", sessionKey: first },
  ]);

  // The tombstone is retryable: a new create with the same intent cleans it up.
  mockState.failIntentCleanup = undefined;
  const recreated = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "cleanup-fail-first" },
    { client, context: modelCatalogContext() },
  );
  expect(recreated.ok, JSON.stringify(recreated.error)).toBe(true);
  expect(recreated.payload?.created).toBe(true);
  expect(recreated.payload?.conversation.sessionKey).toBe(first);
  const healed = await directSessionReq<{
    sideConversations: Array<{ sessionKey: string }>;
    cleanupPending?: unknown[];
  }>("sideConversations.list", { parentSessionKey: parentKey }, { client });
  expect(healed.payload?.cleanupPending).toBeUndefined();
  expect(healed.payload?.sideConversations.map((row) => row.sessionKey).toSorted()).toEqual(
    [first, second].toSorted(),
  );
});

test("close refuses worker work that appears at the final commit guard", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const childKey = await createSide(storePath, "close-worker-intent");
  const child = readEntry(storePath, childKey)!;
  let armed = false;
  const context = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    terminalSessions: {
      beginAgentSessionDrain: () => {
        armed = true;
        return { drained: Promise.resolve(), hasWork: () => false, release: () => {} };
      },
    } as never,
    workerSessionPlacementService: {
      getMany: (sessionIds: string[]) =>
        new Map(
          armed
            ? sessionIds.map((sessionId) => [
                sessionId,
                { turnClaim: { sessionId, runId: "close-late-run" } },
              ])
            : [],
        ),
      listPendingWorkspaceResultsAsync: async () => [],
      waitForTurnClaimRelease: async () => true,
    } as never,
  });
  const closed = await closePersistentSideConversation({
    cfg: getRuntimeConfig(),
    context,
    client: null,
    parentSessionKey: parentKey,
    sessionKey: childKey,
    assertCurrent: () => {},
  });
  expect(closed).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(readEntry(storePath, childKey)?.sideConversation?.state).toBe("open");
  expect(
    readEntry(storePath, parentKey)?.sideConversations?.conversations["close-worker-intent"]?.state,
  ).toBe("open");
  // The drain was released even though the commit was refused.
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [childKey, child.sessionId],
    assertAllowed: () => {},
  });
  lease.release();
});

test("close refuses terminal work that appears at the final commit guard", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const childKey = await createSide(storePath, "close-terminal-intent");
  const child = readEntry(storePath, childKey)!;
  const context = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    terminalSessions: {
      beginAgentSessionDrain: () => ({
        drained: Promise.resolve(),
        hasWork: () => false,
        release: () => {},
      }),
      hasAgentSessionWork: () => true,
    } as never,
  });
  const closed = await closePersistentSideConversation({
    cfg: getRuntimeConfig(),
    context,
    client: null,
    parentSessionKey: parentKey,
    sessionKey: childKey,
    assertCurrent: () => {},
  });
  expect(closed).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", retryable: true },
  });
  expect(readEntry(storePath, childKey)?.sideConversation?.state).toBe("open");
  const lease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [childKey, child.sessionId],
    assertAllowed: () => {},
  });
  lease.release();
});

test("delete reports already-deleted children when the parent commit guard fails", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const childKey = await createSide(storePath, "parent-guard-fail-intent");
  let bumped = false;
  const context = createDirectChatContext({
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    workerSessionPlacementService: {
      getMany: () => {
        if (!bumped && readEntry(storePath, childKey) === undefined) {
          bumped = true;
          const current = readEntry(storePath, parentKey)!;
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: parentKey, storePath },
            { ...current, lifecycleRevision: "parent-moved-after-child-delete" },
          );
        }
        return new Map();
      },
      listPendingWorkspaceResultsAsync: async () => [],
      waitForTurnClaimRelease: async () => true,
    } as never,
  });
  const deleted = await directSessionReq<{
    deleted: boolean;
    partial?: boolean;
    deletedKeys?: string[];
    remainingSideConversations?: unknown[];
    cleanupPending?: unknown[];
  }>("sessions.delete", { key: parentKey }, { client, context });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload).toMatchObject({
    deleted: false,
    partial: true,
    deletedKeys: [childKey],
    remainingSideConversations: [],
  });
  expect(readEntry(storePath, parentKey)).toBeTruthy();
  expect(readEntry(storePath, childKey)).toBeUndefined();
  expect(
    readEntry(storePath, parentKey)?.sideConversations?.conversations["parent-guard-fail-intent"],
  ).toBeUndefined();
});
