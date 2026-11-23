import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
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

async function waitForMutation(
  scope: string,
  identities: string[],
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSessionLifecycleMutationActive(scope, identities)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
}

async function installMergeBaseFaultWrapper(
  root: string,
  failOnCall: number,
): Promise<{ restore: () => void }> {
  const binDir = path.join(root, "merge-base-fault-bin");
  await fs.mkdir(binDir, { recursive: true });
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  if (!realGit.startsWith("/")) {
    throw new Error("expected an absolute git path");
  }
  const counter = path.join(root, "merge-base-count");
  const script = [
    "#!/bin/sh",
    "is_ancestor=0",
    'for arg in "$@"; do',
    '  if [ "$arg" = "--is-ancestor" ]; then is_ancestor=1; fi',
    "done",
    'if [ "$is_ancestor" = "1" ]; then',
    "  count=0",
    `  if [ -f "${counter}" ]; then count=$(cat "${counter}"); fi`,
    "  count=$((count + 1))",
    `  printf '%s' "$count" > "${counter}"`,
    `  if [ "$count" = "${failOnCall}" ]; then`,
    '    echo "injected merge-base inspection failure" >&2',
    "    exit 2",
    "  fi",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(binDir, "git"), script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  return {
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
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

test(
  "typed authority loss after Git keeps its canonical error and reports the landed commit",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey } =
      await createMergedFixture("intent-typed-authority");
    const context = createDirectChatContext({
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
    });
    const authorityError = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, "Session access changed", {
        details: { code: "SESSION_ACCESS_CHANGED" },
      }),
    );
    let thrown = false;

    const result = await mergePersistentSideConversation({
      cfg: getRuntimeConfig(),
      context,
      parentSessionKey: parentKey,
      sessionKey,
      assertCurrent: () => {
        if (mockState.mergedCommit && !thrown) {
          thrown = true;
          throw authorityError;
        }
      },
    });
    expect(result.ok).toBe(false);
    const landed = mockState.mergedCommit;
    if (!result.ok) {
      // Canonical code/message stay intact; the accepted write is reconciled.
      expect(result.error.code).toBe(ErrorCodes.FORBIDDEN);
      expect(result.error.message).toBe("Session access changed");
      expect(result.error.details).toMatchObject({
        code: "SESSION_ACCESS_CHANGED",
        mergeCommit: landed,
      });
      expect(result.error.retryable).toBe(true);
    }
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");

    // Abandon must not bury the accepted write; it points back at the merge retry.
    const abandoned = await directSessionReq(
      "sideConversations.abandon",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(abandoned.ok).toBe(false);
    expect(abandoned.error?.message).toContain("already merged");
    expect(mergeCommitDetail(abandoned.error)).toBe(landed);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);

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

test(
  "abandon after a post-Git metadata failure is refused and the retry records merged",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey } =
      await createMergedFixture("intent-metadata-abandon");
    mockState.failNextPatch = true;
    const failed = await directSessionReq(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(failed.ok).toBe(false);
    const landed = mergeCommitDetail(failed.error);
    expect(landed).toBeTruthy();
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");

    // The sequential post-Git failure must not become an unreconcilable abandon.
    const abandoned = await directSessionReq(
      "sideConversations.abandon",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(abandoned.ok).toBe(false);
    expect(abandoned.error?.retryable).toBe(true);
    expect(abandoned.error?.message).toContain("already merged");
    expect(mergeCommitDetail(abandoned.error)).toBe(landed);
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);

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
    // The retry records the state without creating another merge.
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
  },
);

test(
  "a merge queued behind a long mutation settles on abort without moving HEAD",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey } = await createMergedFixture("intent-queued-abort");
    const parent = readEntry(storePath, parentKey)!;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const holder = runExclusiveSessionLifecycleMutation("patch", {
      scope: storePath,
      identities: [parentKey, parent.sessionId],
      run: async () => {
        await gate;
      },
    });
    const activated = await waitForMutation(storePath, [parentKey]);
    expect(activated).toBe(true);
    const context = createDirectChatContext({
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
    });

    try {
      const controller = new AbortController();
      const pending = mergePersistentSideConversation({
        cfg: getRuntimeConfig(),
        context,
        parentSessionKey: parentKey,
        sessionKey,
        assertCurrent: () => {},
        signal: controller.signal,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      const headBefore = await git(workspace, "rev-parse", "HEAD");
      controller.abort();
      const settlement = await Promise.race([
        pending.then(
          () => "resolved",
          (error: unknown) => error,
        ),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 2000);
        }),
      ]);
      // The queued request settles at abort time instead of waiting for the holder.
      expect(settlement).not.toBe("timeout");
      expect(settlement).not.toBe("resolved");
      expect(await git(workspace, "rev-parse", "HEAD")).toBe(headBefore);
      expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");
    } finally {
      releaseGate();
      await holder;
    }

    // The lane is usable again for a later merge.
    const retried = await directSessionReq<{
      alreadyMerged: boolean;
      mergeCommit?: string;
      conversation: { state: string };
    }>("sideConversations.merge", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(retried.payload?.conversation.state).toBe("merged");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(retried.payload?.mergeCommit);
  },
);

test(
  "an inconclusive ancestry inspection refuses abandon and keeps the landed merge reconcilable",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath, sessionKey } =
      await createMergedFixture("intent-inspection-fault");
    mockState.failNextPatch = true;
    const wrapperRoot = tempDirs.make("openclaw-side-inspection-fault-");
    // Merge preflight and post-merge validation use calls 1-3; call 4 is the
    // abandon inspection that must fail closed.
    const wrapper = await installMergeBaseFaultWrapper(wrapperRoot, 4);
    let landed: string | undefined;
    try {
      const failed = await directSessionReq(
        "sideConversations.merge",
        { parentSessionKey: parentKey, sessionKey },
        { client },
      );
      expect(failed.ok).toBe(false);
      landed = mergeCommitDetail(failed.error);
      expect(landed).toBeTruthy();
      expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
      expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");

      const abandoned = await directSessionReq(
        "sideConversations.abandon",
        { parentSessionKey: parentKey, sessionKey },
        { client },
      );
      expect(abandoned.ok).toBe(false);
      expect(abandoned.error?.retryable).toBe(true);
      expect(abandoned.error?.message).toContain("could not verify");
      // Bounded error: no checkout path or raw Git stderr leaks.
      expect(abandoned.error?.message).not.toContain(workspace);
      expect(abandoned.error?.message).not.toContain("injected merge-base");
      expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");
      expect(await git(workspace, "rev-parse", "HEAD")).toBe(landed);
    } finally {
      wrapper.restore();
    }

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
