import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import { mergePersistentSideConversation } from "./side-conversations-handoff.js";

const mockState = vi.hoisted(() => ({
  failNextPatch: false,
  mergedCommit: undefined as string | undefined,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    patchSessionEntryCore: vi.fn(
      async (...args: Parameters<typeof actual.patchSessionEntryCore>) => {
        if (mockState.failNextPatch) {
          mockState.failNextPatch = false;
          throw new Error("injected metadata write failure");
        }
        return await actual.patchSessionEntryCore(...args);
      },
    ),
  };
});

vi.mock("../../agents/worktrees/side-conversation-merge.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/worktrees/side-conversation-merge.js")>();
  return {
    ...actual,
    mergeSideConversationBranch: vi.fn(
      async (params: Parameters<typeof actual.mergeSideConversationBranch>[0]) => {
        const result = await actual.mergeSideConversationBranch(params);
        if (result.ok) {
          mockState.mergedCommit = result.value.commit;
        }
        return result;
      },
    ),
  };
});

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  mockState.failNextPatch = false;
  mockState.mergedCommit = undefined;
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

const parentKey = "agent:main:dashboard:merge-outcome-parent";
const catalogEntries: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: catalogEntries,
      routeVariants: catalogEntries,
      agentId: "main",
      agentDir: "/tmp/openclaw-side-merge-agent",
      workspaceDir: "/tmp/openclaw-side-merge-workspace",
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

function readEntry(storePath: string, sessionKey: string) {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

function mergeCommitDetail(error: { details?: unknown } | undefined): string | undefined {
  const details = error?.details as { mergeCommit?: string } | undefined;
  return details?.mergeCommit;
}

async function createMergedFixture(intentId: string) {
  const root = tempDirs.make("openclaw-side-merge-outcome-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
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
  const side = await directSessionReq<{ conversation: { sessionKey: string } }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId },
    { client, context: modelCatalogContext() },
  );
  expect(side.ok, JSON.stringify(side.error)).toBe(true);
  const sessionKey = side.payload!.conversation.sessionKey;
  const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
  await fs.writeFile(path.join(record.path, "feature.txt"), "feature\n");
  await git(record.path, "add", "feature.txt");
  await git(record.path, "commit", "-m", "child feature");
  const childHead = await git(record.path, "rev-parse", "HEAD");
  return { workspace, storePath, sessionKey, record, childHead };
}

test(
  "a post-merge metadata failure reports the landed commit and retries idempotently",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey, childHead } =
      await createMergedFixture("intent-metadata-failure");

    mockState.failNextPatch = true;
    const failed = await directSessionReq(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(failed.ok).toBe(false);
    expect(failed.error?.retryable).toBe(true);
    const landed = mergeCommitDetail(failed.error);
    expect(landed).toBeTruthy();
    expect(failed.error?.message).toContain(`merged at ${landed}`);
    // The accepted Git write is real and the marker stayed open for the retry.
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
    await git(workspace, "merge-base", "--is-ancestor", childHead, landed!);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");

    const retried = await directSessionReq<{
      alreadyMerged: boolean;
      mergeCommit?: string;
      conversation: { state: string };
    }>("sideConversations.merge", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(retried.payload).toMatchObject({
      alreadyMerged: true,
      mergeCommit: landed,
      conversation: { state: "merged" },
    });
    // A retry records the same landing commit and never moves the parent again.
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
  },
);

test(
  "a final commit-guard failure reconciles the landed merge instead of throwing",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey } = await createMergedFixture("intent-final-guard");
    const context = createDirectChatContext({
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
    });

    const result = await mergePersistentSideConversation({
      cfg: getRuntimeConfig(),
      context,
      parentSessionKey: parentKey,
      sessionKey,
      assertCurrent: () => {
        if (mockState.mergedCommit) {
          throw new Error("injected final commit-guard failure");
        }
      },
    });
    expect(result.ok).toBe(false);
    const landed = result.ok ? undefined : mergeCommitDetail(result.error);
    expect(landed).toBe(mockState.mergedCommit);
    expect(result.ok ? undefined : result.error.retryable).toBe(true);
    expect(result.ok ? "" : result.error.message).toContain("merged at");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");

    const retried = await directSessionReq<{
      alreadyMerged: boolean;
      mergeCommit?: string;
      conversation: { state: string };
    }>("sideConversations.merge", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(retried.payload).toMatchObject({
      alreadyMerged: true,
      mergeCommit: landed,
      conversation: { state: "merged" },
    });
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
  },
);
