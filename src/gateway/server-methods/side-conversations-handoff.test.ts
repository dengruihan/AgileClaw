import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readSideConversationHandoffQueue } from "../../sessions/side-conversation-handoff-queue.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const closeHandoffFaults = vi.hoisted(() => ({ failNextEnsure: false }));

vi.mock("../../sessions/side-conversation-handoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/side-conversation-handoff.js")>();
  return {
    ...actual,
    ensureClosedSideConversationHandoff: async (
      params: Parameters<typeof actual.ensureClosedSideConversationHandoff>[0],
    ) => {
      if (closeHandoffFaults.failNextEnsure) {
        closeHandoffFaults.failNextEnsure = false;
        throw new Error("database is locked");
      }
      return await actual.ensureClosedSideConversationHandoff(params);
    },
  };
});

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  closeHandoffFaults.failNextEnsure = false;
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

const parentKey = "agent:main:dashboard:handoff-parent";
const catalogEntries: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: catalogEntries,
      routeVariants: catalogEntries,
      agentId: "main",
      agentDir: "/tmp/openclaw-side-handoff-agent",
      workspaceDir: "/tmp/openclaw-side-handoff-workspace",
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

function readParentQueue(storePath: string) {
  const entry = loadSessionEntry({
    agentId: "main",
    sessionKey: parentKey,
    storePath,
    readConsistency: "latest",
  }) as InternalSessionEntry | undefined;
  if (!entry) {
    throw new Error("expected the parent entry");
  }
  return readSideConversationHandoffQueue(entry);
}

async function createGitFixture() {
  const root = tempDirs.make("openclaw-side-handoff-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq(
    "sessions.create",
    { key: parentKey, agentId: "main", model: "anthropic/claude-opus-4-6" },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const parent = loadSessionEntry({ agentId: "main", sessionKey: parentKey, storePath });
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
  return { workspace, storePath };
}

async function createSide(intentId: string): Promise<{ sessionKey: string; checkoutPath: string }> {
  const created = await directSessionReq<{
    conversation: {
      sessionKey: string;
      worktree?: { id: string; branch: string; path: string };
    };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionKey = created.payload!.conversation.sessionKey;
  const record = managedWorktrees.findLiveByOwner("session", sessionKey);
  expect(record).toBeDefined();
  return { sessionKey, checkoutPath: record!.path };
}

async function closeSide(sessionKey: string) {
  const closed = await directSessionReq<{ conversation: { state: string } }>(
    "sideConversations.close",
    { parentSessionKey: parentKey, sessionKey },
    { client },
  );
  expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
  return closed.payload!.conversation;
}

test(
  "close records one bounded reminder on the parent row without running or merging",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const parentHead = await git(workspace, "rev-parse", "HEAD");
    const { sessionKey, checkoutPath } = await createSide("intent-handoff");
    await fs.writeFile(path.join(checkoutPath, "draft.txt"), "child draft\n");

    expect((await closeSide(sessionKey)).state).toBe("closed");

    const queue = readParentQueue(storePath);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]).toMatchObject({
      sessionKey,
      intentId: "intent-handoff",
      ordinal: 1,
      worktree: {
        path: checkoutPath,
        changedFiles: 1,
        commitsAhead: 0,
      },
    });
    expect(queue.pending[0]?.worktree?.branch).toBeTruthy();

    // Close is state + reminder only: the parent branch never moves, the child
    // checkout and its uncommitted work stay exactly as they were.
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(parentHead);
    expect(await fs.readFile(path.join(checkoutPath, "draft.txt"), "utf8")).toBe("child draft\n");

    // The parent row exposes the pending count for the UI chip.
    const listed = await directSessionReq<{
      sessions: Array<{ key: string; handoffCount?: number }>;
    }>("sessions.list", { agentId: "main" }, { client });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.payload?.sessions.find((row) => row.key === parentKey)?.handoffCount).toBe(1);
    expect(listed.payload?.sessions.find((row) => row.key === sessionKey)).toBeUndefined();

    // A retried close is a no-op and never duplicates the reminder.
    await closeSide(sessionKey);
    expect(readParentQueue(storePath).pending).toHaveLength(1);

    // Abandon only records the state; the pending reminder is independent.
    const abandoned = await directSessionReq(
      "sideConversations.abandon",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(abandoned.ok, JSON.stringify(abandoned.error)).toBe(true);
    expect(readParentQueue(storePath).pending).toHaveLength(1);
  },
);

test("an untouched side conversation never records a reminder", { timeout: 60_000 }, async () => {
  const { storePath } = await createGitFixture();
  const { sessionKey } = await createSide("intent-clean");

  expect((await closeSide(sessionKey)).state).toBe("closed");
  expect(readParentQueue(storePath).pending).toHaveLength(0);

  const listed = await directSessionReq<{
    sessions: Array<{ key: string; handoffCount?: number }>;
  }>("sessions.list", { agentId: "main" }, { client });
  expect(
    listed.payload?.sessions.find((row) => row.key === parentKey)?.handoffCount,
  ).toBeUndefined();
});

test(
  "reopen withdraws the undelivered reminder and a later close queues it again",
  { timeout: 60_000 },
  async () => {
    const { storePath } = await createGitFixture();
    const { sessionKey, checkoutPath } = await createSide("intent-reopen");
    await fs.writeFile(path.join(checkoutPath, "draft.txt"), "child draft\n");
    await closeSide(sessionKey);
    expect(readParentQueue(storePath).pending).toHaveLength(1);

    const reopened = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.reopen",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.payload?.conversation.state).toBe("open");
    expect(readParentQueue(storePath).pending).toHaveLength(0);

    // A retried reopen is idempotent and still withdraws nothing extra.
    const replayed = await directSessionReq(
      "sideConversations.reopen",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(replayed.ok, JSON.stringify(replayed.error)).toBe(true);
    expect(readParentQueue(storePath).pending).toHaveLength(0);

    // Closing again starts a fresh reminder with the next sequence.
    await closeSide(sessionKey);
    const queue = readParentQueue(storePath);
    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]?.sequence).toBe(2);
  },
);

test(
  "a close whose reminder write fails reports a retryable partial and repairs on retry",
  { timeout: 60_000 },
  async () => {
    const { storePath } = await createGitFixture();
    const { sessionKey, checkoutPath } = await createSide("intent-partial");
    await fs.writeFile(path.join(checkoutPath, "draft.txt"), "child draft\n");

    closeHandoffFaults.failNextEnsure = true;
    const failed = await directSessionReq<never>(
      "sideConversations.close",
      {
        parentSessionKey: parentKey,
        sessionKey,
      },
      { client },
    );
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe("UNAVAILABLE");
    const errorPayload: unknown = failed.error;
    expect(isRecord(errorPayload) ? errorPayload.retryable : undefined).toBe(true);
    expect(failed.error?.details).toMatchObject({
      sessionKey,
      state: "closed",
      handoffRecorded: false,
    });
    // The close itself is durable; only the reminder is missing.
    const child = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(child?.sideConversation?.state).toBe("closed");
    expect(readParentQueue(storePath).pending).toHaveLength(0);

    // The retried close inspects the checkout again and records the reminder.
    const retried = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.close",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(readParentQueue(storePath).pending).toHaveLength(1);
    const listed = await directSessionReq<{
      sessions: Array<{ key: string; handoffCount?: number }>;
    }>("sessions.list", { agentId: "main" }, { client });
    expect(listed.payload?.sessions.find((row) => row.key === parentKey)?.handoffCount).toBe(1);
  },
);
