import { afterEach, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

const parentKey = "agent:main:dashboard:side-parent";

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
        agentDir: "/tmp/openclaw-side-agent",
        workspaceDir: "/tmp/openclaw-side-workspace",
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

function readEntry(storePath: string, sessionKey: string) {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

async function createParent(storePath: string) {
  const created = await directSessionReq<{ key: string; entry: { sessionId: string } }>(
    "sessions.create",
    {
      key: parentKey,
      agentId: "main",
      model: "anthropic/claude-opus-4-6",
      thinkingLevel: "high",
    },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const parent = readEntry(storePath, parentKey);
  expect(parent?.sessionId).toBeTruthy();
  await seedSessionTranscript({
    agentId: "main",
    sessionId: parent!.sessionId,
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
  return parent!;
}

test("side conversation forks a frozen snapshot and persists idempotently", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const first = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string; ordinal: number; state: string };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-1" },
    { client, context: modelCatalogContext() },
  );
  expect(first.ok, JSON.stringify(first.error)).toBe(true);
  expect(first.payload?.created).toBe(true);
  expect(first.payload?.conversation).toMatchObject({ ordinal: 1, state: "open" });
  const childKey = first.payload!.conversation.sessionKey;
  expect(childKey).toMatch(/^agent:main:dashboard:side-/);

  const child = readEntry(storePath, childKey)!;
  expect(child.sideConversation).toMatchObject({
    parentSessionKey: parentKey,
    intentId: "intent-1",
    ordinal: 1,
    state: "open",
  });
  // Frozen parent selection: model and thinking inherit at creation but stay unlocked.
  expect(child.modelOverride).toBe("claude-opus-4-6");
  expect(child.providerOverride).toBe("anthropic");
  expect(child.thinkingLevel).toBe("high");
  expect(child.modelSelectionLocked).not.toBe(true);
  expect(child.spawnedBy).toBeUndefined();

  const transcript = loadTranscriptEventsSync({
    agentId: "main",
    sessionKey: childKey,
    sessionId: child.sessionId,
    storePath,
  });
  expect(transcript.at(-1)).toMatchObject({
    type: "custom_message",
    customType: "openclaw.side-conversation-snapshot",
    display: false,
  });
  expect(
    transcript.some(
      (event) =>
        (event as { type?: string }).type === "message" &&
        (event as { message?: { role?: string } }).message?.role === "user",
    ),
  ).toBe(true);

  const replay = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-1" },
    { client, context: modelCatalogContext() },
  );
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(replay.payload?.created).toBe(false);
  expect(replay.payload?.conversation.sessionKey).toBe(childKey);

  const second = await directSessionReq<{ conversation: { sessionKey: string; ordinal: number } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-2" },
    { client, context: modelCatalogContext() },
  );
  expect(second.ok, JSON.stringify(second.error)).toBe(true);
  expect(second.payload?.conversation.ordinal).toBe(2);
  expect(second.payload?.conversation.sessionKey).not.toBe(childKey);

  // Restart boundary: registry and markers live in SQLite, not process memory.
  await disposeSessionReadContexts();
  const listedAfterRestart = await directSessionReq<{
    sideConversations: Array<{ sessionKey: string; ordinal: number }>;
  }>("sideConversations.list", { parentSessionKey: parentKey }, { client });
  expect(listedAfterRestart.ok, JSON.stringify(listedAfterRestart.error)).toBe(true);
  expect(listedAfterRestart.payload?.sideConversations.map((row) => row.ordinal)).toEqual([1, 2]);
  const replayAfterRestart = await directSessionReq<{
    created: boolean;
    conversation: { sessionKey: string; ordinal: number };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-1" },
    { client, context: modelCatalogContext() },
  );
  expect(replayAfterRestart.ok, JSON.stringify(replayAfterRestart.error)).toBe(true);
  expect(replayAfterRestart.payload?.created).toBe(false);
  expect(replayAfterRestart.payload?.conversation).toMatchObject({
    sessionKey: childKey,
    ordinal: 1,
  });
});

test("list hides side rows by default, exact reads expose the marker, patch stays independent", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const created = await directSessionReq<{ conversation: { sessionKey: string } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-hidden" },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const childKey = created.payload!.conversation.sessionKey;

  const defaultList = await directSessionReq<{
    sessions: Array<{ key: string; sideConversationCount?: number }>;
  }>("sessions.list", { agentId: "main" }, { client });
  expect(defaultList.ok, JSON.stringify(defaultList.error)).toBe(true);
  expect(defaultList.payload?.sessions.some((row) => row.key === childKey)).toBe(false);
  expect(
    defaultList.payload?.sessions.find((row) => row.key === parentKey)?.sideConversationCount,
  ).toBe(1);

  const withSide = await directSessionReq<{
    sessions: Array<{ key: string; sideConversation?: { state?: string } }>;
  }>("sessions.list", { agentId: "main", includeSideConversations: true }, { client });
  expect(
    withSide.payload?.sessions.find((row) => row.key === childKey)?.sideConversation,
  ).toMatchObject({ state: "open" });

  const described = await directSessionReq<{
    session: { key: string; sideConversation?: unknown };
  }>("sessions.describe", { key: childKey }, { client });
  expect(described.ok, JSON.stringify(described.error)).toBe(true);
  expect(described.payload?.session.sideConversation).toBeTruthy();

  const patched = await directSessionReq(
    "sessions.patch",
    { key: childKey, model: "anthropic/claude-sonnet-4-6" },
    { client, context: modelCatalogContext() },
  );
  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(readEntry(storePath, childKey)?.modelOverride).toBe("claude-sonnet-4-6");
  expect(readEntry(storePath, parentKey)?.modelOverride).toBe("claude-opus-4-6");
});

test("close quiesces without deleting, reopen restores open, parent delete serializes children", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const created = await directSessionReq<{ conversation: { sessionKey: string } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-lifecycle" },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const childKey = created.payload!.conversation.sessionKey;
  const childSessionId = readEntry(storePath, childKey)!.sessionId;

  const closed = await directSessionReq<{ conversation: { state: string } }>(
    "sideConversations.close",
    { parentSessionKey: parentKey, sessionKey: childKey },
    { client },
  );
  expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
  expect(closed.payload?.conversation.state).toBe("closed");
  expect(readEntry(storePath, childKey)?.sideConversation?.state).toBe("closed");
  expect(
    loadTranscriptEventsSync({
      agentId: "main",
      sessionKey: childKey,
      sessionId: childSessionId,
      storePath,
    }).length,
  ).toBeGreaterThan(0);

  const reopened = await directSessionReq<{ conversation: { state: string } }>(
    "sideConversations.reopen",
    { parentSessionKey: parentKey, sessionKey: childKey },
    { client },
  );
  expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
  expect(reopened.payload?.conversation.state).toBe("open");

  // An active hidden child blocks the parent delete with a retryable error.
  await patchSessionEntryCore(
    { agentId: "main", sessionKey: childKey, storePath },
    (current) => ({ ...current, status: "running" }),
    { replaceEntry: true, skipMaintenance: true },
  );
  const blocked = await directSessionReq("sessions.delete", { key: parentKey }, { client });
  expect(blocked).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expect(readEntry(storePath, parentKey)).toBeTruthy();

  await patchSessionEntryCore(
    { agentId: "main", sessionKey: childKey, storePath },
    (current) => ({ ...current, status: "done" }),
    { replaceEntry: true, skipMaintenance: true },
  );
  const deleted = await directSessionReq("sessions.delete", { key: parentKey }, { client });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(readEntry(storePath, parentKey)).toBeUndefined();
  expect(readEntry(storePath, childKey)).toBeUndefined();
});

test("parent archive refuses an active child and archives idle children", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath);
  const created = await directSessionReq<{ conversation: { sessionKey: string } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId: "intent-archive" },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const childKey = created.payload!.conversation.sessionKey;

  await patchSessionEntryCore(
    { agentId: "main", sessionKey: childKey, storePath },
    (current) => ({ ...current, status: "running" }),
    { replaceEntry: true, skipMaintenance: true },
  );
  const parentSessionId = readEntry(storePath, parentKey)!.sessionId;
  const blocked = await directSessionReq(
    "sessions.patch",
    { key: parentKey, archived: true, expectedSessionId: parentSessionId },
    { client },
  );
  expect(blocked).toMatchObject({ ok: false });
  expect(readEntry(storePath, parentKey)?.archivedAt).toBeUndefined();

  await patchSessionEntryCore(
    { agentId: "main", sessionKey: childKey, storePath },
    (current) => ({ ...current, status: "done" }),
    { replaceEntry: true, skipMaintenance: true },
  );
  const archived = await directSessionReq(
    "sessions.patch",
    { key: parentKey, archived: true, expectedSessionId: parentSessionId },
    { client },
  );
  expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
  expect(readEntry(storePath, parentKey)?.archivedAt).toBeTruthy();
  const child = readEntry(storePath, childKey);
  expect(child?.archivedAt).toBeTruthy();
  expect(child?.sideConversation?.state).toBe("closed");
});
