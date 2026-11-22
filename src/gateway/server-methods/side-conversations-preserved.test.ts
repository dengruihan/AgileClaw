import { afterEach, expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

vi.mock("../../sessions/session-worktree-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-worktree-lifecycle.js")>();
  return {
    ...actual,
    removeSessionWorktree: vi.fn(async (params: { id?: string; sessionKey: string }) =>
      params.id
        ? {
            id: params.id,
            branch: `branch-${params.sessionKey}`,
            path: `/preserved/${params.id}`,
            reason: "busy" as const,
          }
        : undefined,
    ),
    synchronizeSessionWorktreeArchive: vi.fn(
      async (params: { entry: { worktree?: { id: string } } }) => {
        if (params.entry.worktree?.id) {
          throw new actual.SessionWorktreeLifecycleError("worktree preserved", "busy");
        }
      },
    ),
  };
});

vi.mock("../../agents/worktrees/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/worktrees/registry.js")>();
  return {
    ...actual,
    getRegistryWorktree: vi.fn((_env: NodeJS.ProcessEnv, id: string) => ({
      id,
      name: id,
      repoFingerprint: "fingerprint",
      repoRoot: "/repo",
      path: `/preserved/${id}`,
      branch: `branch-${id}`,
      baseRef: "main",
      ownerKind: "session",
      createdAt: 1,
      lastActiveAt: 1,
    })),
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

const parentKey = "agent:main:dashboard:preserved-parent";
const catalogEntries = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: catalogEntries,
      routeVariants: catalogEntries,
      agentId: "main",
      agentDir: "/tmp/openclaw-preserved-agent",
      workspaceDir: "/tmp/openclaw-preserved-workspace",
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

function readEntry(storePath: string, sessionKey: string) {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

async function createParent(storePath: string, worktreeId?: string) {
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
  if (worktreeId) {
    await patchSessionEntryCore(
      { agentId: "main", sessionKey: parentKey, storePath },
      (current) => ({
        ...current,
        worktree: { id: worktreeId, branch: `branch-${worktreeId}`, repoRoot: "/repo" },
      }),
      { replaceEntry: true, skipMaintenance: true },
    );
  }
  return readEntry(storePath, parentKey)!;
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

test("delete returns every preserved parent and child worktree", async () => {
  const { storePath } = await createSessionStoreDir();
  await createParent(storePath, "wt-parent");
  const childA = await createSide(storePath, "preserved-a", "wt-child-a");
  const childB = await createSide(storePath, "preserved-b", "wt-child-b");

  const deleted = await directSessionReq<{
    worktreePreserved?: { id: string };
    preservedWorktrees?: Array<{ id: string }>;
  }>("sessions.delete", { key: parentKey }, { client });
  expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
  expect(deleted.payload?.worktreePreserved?.id).toBe("wt-parent");
  expect(new Set(deleted.payload?.preservedWorktrees?.map((worktree) => worktree.id))).toEqual(
    new Set(["wt-parent", "wt-child-a", "wt-child-b"]),
  );
  expect(readEntry(storePath, childA)).toBeUndefined();
  expect(readEntry(storePath, childB)).toBeUndefined();
});

test("archive returns preserved child worktrees in the patch result", async () => {
  const { storePath } = await createSessionStoreDir();
  const parent = await createParent(storePath);
  const childKey = await createSide(storePath, "archive-preserved", "wt-archive-child");

  const archived = await directSessionReq<{ preservedWorktrees?: Array<{ id: string }> }>(
    "sessions.patch",
    { key: parentKey, archived: true, expectedSessionId: parent.sessionId },
    { client },
  );
  expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
  expect(archived.payload?.preservedWorktrees?.map((worktree) => worktree.id)).toEqual([
    "wt-archive-child",
  ]);
  expect(readEntry(storePath, childKey)?.archivedAt).toBeTruthy();
});
