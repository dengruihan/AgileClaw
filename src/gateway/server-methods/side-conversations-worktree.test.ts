import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { runGit } from "../../agents/worktrees/git.js";
import { createManagedWorktreeOwnerPolicy } from "../../agents/worktrees/owner-protection.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  IDLE_GC_MS,
  ManagedWorktreeService,
  managedWorktrees,
} from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

const parentKey = "agent:main:dashboard:worktree-parent";
const catalogEntries: ModelCatalogEntry[] = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
];

function modelCatalogContext() {
  return {
    loadGatewayModelCatalogSnapshot: async () => ({
      entries: catalogEntries,
      routeVariants: catalogEntries,
      agentId: "main",
      agentDir: "/tmp/openclaw-side-worktree-agent",
      workspaceDir: "/tmp/openclaw-side-worktree-workspace",
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

async function createGitFixture() {
  const root = tempDirs.make("openclaw-side-worktree-");
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
  return { workspace, storePath };
}

async function createSide(intentId: string): Promise<{
  sessionKey: string;
  conversation: {
    isolation: { filesystem: string; externalState: string };
    worktree?: { id: string; branch: string; path: string; baseRef?: string };
    worktreeSkipped?: string;
  };
}> {
  const created = await directSessionReq<{
    conversation: {
      sessionKey: string;
      isolation: { filesystem: string; externalState: string };
      worktree?: { id: string; branch: string; path: string; baseRef?: string };
      worktreeSkipped?: string;
    };
  }>(
    "sideConversations.create",
    { parentSessionKey: parentKey, intentId },
    { client, context: modelCatalogContext() },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return {
    sessionKey: created.payload!.conversation.sessionKey,
    conversation: created.payload!.conversation,
  };
}

test(
  "side conversation owns an isolated worktree at the parent HEAD through close, reopen, merge, and abandon",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const parentHead = await git(workspace, "rev-parse", "HEAD");
    // Uncommitted parent work must never be copied into the child checkout.
    await fs.writeFile(path.join(workspace, "parent-wip.txt"), "uncommitted parent edit\n");

    const { sessionKey, conversation } = await createSide("intent-lifecycle");
    expect(conversation.isolation).toEqual({ filesystem: "worktree", externalState: "shared" });
    expect(conversation.worktreeSkipped).toBeUndefined();
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    expect(record).toMatchObject({ repoRoot: workspace, baseRef: parentHead });
    expect(conversation.worktree).toMatchObject({
      id: record.id,
      branch: record.branch,
      path: record.path,
      baseRef: parentHead,
    });
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(parentHead);
    await expect(fs.stat(path.join(record.path, "parent-wip.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The tool cwd follows the worktree's spawnedCwd binding.
    const child = readEntry(storePath, sessionKey)!;
    expect(child.spawnedCwd).toBe(record.path);
    expect(child.worktree?.id).toBe(record.id);

    // Close preserves the checkout, branch, and uncommitted child edits.
    await fs.writeFile(path.join(record.path, "draft.txt"), "child draft\n");
    const closed = await directSessionReq<{
      conversation: { state: string; worktree?: { path: string } };
    }>("sideConversations.close", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
    expect(closed.payload?.conversation.state).toBe("closed");
    expect(managedWorktrees.findLiveById(record.id)?.path).toBe(record.path);
    expect(await git(record.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(record.branch);
    expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe("child draft\n");

    const reopened = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.reopen",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.payload?.conversation.state).toBe("open");
    expect(managedWorktrees.findLiveById(record.id)?.path).toBe(record.path);

    // A dirty child checkout cannot be merged.
    const dirtyMerge = await directSessionReq(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(dirtyMerge.ok).toBe(false);
    expect(dirtyMerge.error?.message).toContain("uncommitted changes");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(parentHead);

    // Commit the child's work; a dirty parent checkout still blocks the merge.
    await git(record.path, "add", "draft.txt");
    await git(record.path, "commit", "-m", "child change");
    const childHead = await git(record.path, "rev-parse", "HEAD");
    const parentDirtyMerge = await directSessionReq(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(parentDirtyMerge.ok).toBe(false);
    expect(parentDirtyMerge.error?.message).toContain("parent checkout has uncommitted changes");
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(parentHead);

    await fs.rm(path.join(workspace, "parent-wip.txt"));
    const merged = await directSessionReq<{
      mergeCommit?: string;
      alreadyMerged: boolean;
      conversation: { state: string };
    }>("sideConversations.merge", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(merged.ok, JSON.stringify(merged.error)).toBe(true);
    expect(merged.payload?.alreadyMerged).toBe(false);
    expect(merged.payload?.conversation.state).toBe("merged");
    const mergeCommit = await git(workspace, "rev-parse", "HEAD");
    expect(merged.payload?.mergeCommit).toBe(mergeCommit);
    await git(workspace, "merge-base", "--is-ancestor", parentHead, mergeCommit);
    await git(workspace, "merge-base", "--is-ancestor", childHead, mergeCommit);
    expect(await fs.readFile(path.join(workspace, "draft.txt"), "utf8")).toBe("child draft\n");
    // The merge keeps the child checkout and branch for explicit cleanup.
    expect(managedWorktrees.findLiveById(record.id)).toBeDefined();
    expect(await git(workspace, "rev-parse", "--verify", `refs/heads/${record.branch}`)).toBe(
      childHead,
    );

    const replayed = await directSessionReq<{
      alreadyMerged: boolean;
      mergeCommit?: string;
      conversation: { state: string };
    }>("sideConversations.merge", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(replayed.ok, JSON.stringify(replayed.error)).toBe(true);
    expect(replayed.payload?.alreadyMerged).toBe(true);
    // A replay reports the original landing commit; the parent never moves again.
    expect(replayed.payload?.mergeCommit).toBe(mergeCommit);
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(mergeCommit);

    const abandoned = await directSessionReq(
      "sideConversations.abandon",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(abandoned.ok).toBe(false);
    expect(abandoned.error?.message).toContain("merged");
  },
);

test(
  "a conflicting side conversation leaves the parent checkout and child checkout untouched",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const { sessionKey } = await createSide("intent-conflict");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "README.md"), "child version\n");
    await git(record.path, "add", "README.md");
    await git(record.path, "commit", "-m", "child edit");
    const childHead = await git(record.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(workspace, "README.md"), "parent version\n");
    await git(workspace, "add", "README.md");
    await git(workspace, "commit", "-m", "parent edit");
    const parentHead = await git(workspace, "rev-parse", "HEAD");

    const conflicted = await directSessionReq<{ details?: { paths?: string[] } }>(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(conflicted.ok).toBe(false);
    expect(conflicted.error?.message).toContain("conflicts with the parent checkout");
    expect(conflicted.error?.details).toMatchObject({ paths: ["README.md"] });
    // Nothing was merged: the parent HEAD and working tree are unchanged.
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(parentHead);
    expect(await git(workspace, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(workspace, "README.md"), "utf8")).toBe("parent version\n");
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(childHead);
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("child version\n");
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("open");
  },
);

test(
  "abandon keeps the branch and edits while explicit delete retires them behind a snapshot",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const { sessionKey } = await createSide("intent-abandon");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "notes.txt"), "kept work\n");
    const draftHead = await git(record.path, "rev-parse", "HEAD");

    const openDelete = await directSessionReq(
      "sideConversations.delete",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(openDelete.ok).toBe(false);
    expect(openDelete.error?.message).toContain("close it or abandon it");

    const abandoned = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.abandon",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(abandoned.ok, JSON.stringify(abandoned.error)).toBe(true);
    expect(abandoned.payload?.conversation.state).toBe("abandoned");
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("abandoned");
    expect(managedWorktrees.findLiveById(record.id)?.path).toBe(record.path);
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(draftHead);
    expect(await fs.readFile(path.join(record.path, "notes.txt"), "utf8")).toBe("kept work\n");
    expect(await git(workspace, "rev-parse", "--verify", `refs/heads/${record.branch}`)).toBe(
      draftHead,
    );

    const deleted = await directSessionReq<{
      deleted: boolean;
      cleanupPending?: unknown[];
      worktreePreserved?: { path: string; reason: string };
    }>("sideConversations.delete", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(readEntry(storePath, sessionKey)).toBeUndefined();
    expect(managedWorktrees.findLiveById(record.id)).toBeUndefined();
    const retired = getRegistryWorktree(process.env, record.id)!;
    expect(retired.removedAt).toBeDefined();
    expect(retired.snapshotRef).toBeTruthy();
    // Untracked edits survive in the removal snapshot.
    expect(await git(workspace, "cat-file", "-p", `${retired.snapshotRef}:notes.txt`)).toContain(
      "kept work",
    );
    // The membership left the parent registry.
    const listed = await directSessionReq<{ sideConversations: unknown[] }>(
      "sideConversations.list",
      { parentSessionKey: parentKey },
      { client },
    );
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.payload?.sideConversations).toEqual([]);
  },
);

test(
  "a non-Git parent shares its checkout and reports worktreeSkipped instead of isolation",
  { timeout: 60_000 },
  async () => {
    const root = tempDirs.make("openclaw-side-worktree-nongit-");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
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
      messages: [{ role: "user", content: "question" }],
    });

    const { sessionKey, conversation } = await createSide("intent-nongit");
    expect(conversation.isolation).toEqual({ filesystem: "shared", externalState: "shared" });
    expect(conversation.worktree).toBeUndefined();
    expect(conversation.worktreeSkipped).toBe("not-git");
    const child = readEntry(storePath, sessionKey)!;
    expect(child.worktree).toBeUndefined();
    expect(child.spawnedCwd).toBe(workspace);
    expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();

    const merge = await directSessionReq(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(merge.ok).toBe(false);
    expect(merge.error?.message).toContain("shares the parent checkout");

    const closed = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.close",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
    expect(closed.payload?.conversation.state).toBe("closed");
    const deleted = await directSessionReq(
      "sideConversations.delete",
      {
        parentSessionKey: parentKey,
        sessionKey,
      },
      { client },
    );
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(readEntry(storePath, sessionKey)).toBeUndefined();
  },
);

test(
  "deleting the parent preserves an unmerged child checkout in its removal snapshot",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const { sessionKey } = await createSide("intent-parent-delete");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "child-work.txt"), "unmerged child work\n");
    await git(record.path, "add", "child-work.txt");
    await git(record.path, "commit", "-m", "unmerged child work");
    const childHead = await git(record.path, "rev-parse", "HEAD");

    const deleted = await directSessionReq("sessions.delete", { key: parentKey }, { client });
    expect(deleted.ok, JSON.stringify(deleted.error)).toBe(true);
    expect(readEntry(storePath, sessionKey)).toBeUndefined();
    const retired = getRegistryWorktree(process.env, record.id)!;
    expect(retired.removedAt).toBeDefined();
    expect(retired.snapshotRef).toBeTruthy();
    expect(
      await git(workspace, "cat-file", "-p", `${retired.snapshotRef}:child-work.txt`),
    ).toContain("unmerged child work");
    // The unmerged child commit is reachable from the snapshot, not from the parent branch.
    const ancestry = await runGit(workspace, ["merge-base", "--is-ancestor", childHead, "HEAD"]);
    expect(ancestry.code).toBe(1);
  },
);

test(
  "a parent worktree is the source: the child restarts from its HEAD and merges back into it",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const baseCommit = await git(workspace, "rev-parse", "HEAD");
    const parentWorktree = await managedWorktrees.create({
      ownerKind: "session",
      ownerId: parentKey,
      repoRoot: workspace,
      baseRef: baseCommit,
      checkoutCommit: baseCommit,
    });
    await patchSessionEntryCore(
      { agentId: "main", sessionKey: parentKey, storePath },
      (current) => ({
        ...current,
        spawnedCwd: parentWorktree.path,
        worktree: {
          id: parentWorktree.id,
          branch: parentWorktree.branch,
          repoRoot: workspace,
          canonicalWorkspaceDir: workspace,
        },
      }),
      { replaceEntry: true, skipMaintenance: true },
    );
    // The parent's committed HEAD is its own worktree commit, not the repository root.
    await fs.writeFile(path.join(parentWorktree.path, "parent-committed.txt"), "parent work\n");
    await git(parentWorktree.path, "add", "parent-committed.txt");
    await git(parentWorktree.path, "commit", "-m", "parent committed work");
    const parentWorktreeHead = await git(parentWorktree.path, "rev-parse", "HEAD");
    expect(parentWorktreeHead).not.toBe(baseCommit);

    const { sessionKey } = await createSide("intent-parent-worktree");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    // The child derives from the parent's repository root at the parent worktree HEAD.
    expect(record.repoRoot).toBe(workspace);
    expect(record.path).not.toBe(parentWorktree.path);
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(parentWorktreeHead);

    await fs.writeFile(path.join(record.path, "child-committed.txt"), "child work\n");
    await git(record.path, "add", "child-committed.txt");
    await git(record.path, "commit", "-m", "child work");
    const merged = await directSessionReq<{ alreadyMerged: boolean }>(
      "sideConversations.merge",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(merged.ok, JSON.stringify(merged.error)).toBe(true);
    expect(merged.payload?.alreadyMerged).toBe(false);
    // The merge lands in the parent checkout, never in the repository root working tree.
    expect(await git(parentWorktree.path, "rev-parse", "HEAD")).toBe(
      await git(workspace, "rev-parse", `refs/heads/${parentWorktree.branch}`),
    );
    expect(await fs.readFile(path.join(parentWorktree.path, "child-committed.txt"), "utf8")).toBe(
      "child work\n",
    );
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(baseCommit);
  },
);

test(
  "a remote-exec parent never materializes a host checkout even from a Git cwd",
  { timeout: 60_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    await patchSessionEntryCore(
      { agentId: "main", sessionKey: parentKey, storePath },
      (current) => ({ ...current, execHost: "node" as const, execNode: "node-1" }),
      { replaceEntry: true, skipMaintenance: true },
    );

    const { sessionKey, conversation } = await createSide("intent-remote-parent");
    expect(conversation.isolation).toEqual({ filesystem: "shared", externalState: "shared" });
    expect(conversation.worktree).toBeUndefined();
    expect(conversation.worktreeSkipped).toBe("remote-exec");
    expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
    const child = readEntry(storePath, sessionKey)!;
    expect(child.worktree).toBeUndefined();
    expect(child.spawnedCwd).toBe(workspace);

    // A leftover live child record never overrides the remote binding's shared fact.
    const head = await git(workspace, "rev-parse", "HEAD");
    const stale = await managedWorktrees.create({
      ownerKind: "session",
      ownerId: sessionKey,
      repoRoot: workspace,
      baseRef: head,
      checkoutCommit: head,
    });
    await patchSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      (current) => ({
        ...current,
        worktree: {
          id: stale.id,
          branch: stale.branch,
          repoRoot: workspace,
          canonicalWorkspaceDir: workspace,
        },
      }),
      { replaceEntry: true, skipMaintenance: true },
    );
    const listed = await directSessionReq<{
      sideConversations: Array<{
        worktree?: unknown;
        worktreeSkipped?: string;
        isolation: { filesystem: string };
      }>;
    }>("sideConversations.list", { parentSessionKey: parentKey }, { client });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    expect(listed.payload?.sideConversations[0]).toMatchObject({
      worktreeSkipped: "remote-exec",
      isolation: { filesystem: "shared" },
    });
    expect(listed.payload?.sideConversations[0]?.worktree).toBeUndefined();
  },
);

test(
  "owner protection keeps a closed checkout through idle GC while normal sessions still collect",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const { sessionKey } = await createSide("intent-gc-protected");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "draft.txt"), "protected draft\n");
    const closed = await directSessionReq(
      "sideConversations.close",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
    const childHead = await git(record.path, "rev-parse", "HEAD");

    // A normal idle session worktree is still collected by the same policy.
    const plainKey = "agent:main:dashboard:plain-gc";
    const plainCreated = await directSessionReq(
      "sessions.create",
      { key: plainKey, agentId: "main", model: "anthropic/claude-opus-4-6" },
      { client, context: modelCatalogContext() },
    );
    expect(plainCreated.ok, JSON.stringify(plainCreated.error)).toBe(true);
    await patchSessionEntryCore(
      { agentId: "main", sessionKey: plainKey, storePath },
      (current) => ({ ...current, updatedAt: 1, lastInteractionAt: 1 }),
      { replaceEntry: true, skipMaintenance: true },
    );
    const head = await git(workspace, "rev-parse", "HEAD");
    const plain = await managedWorktrees.create({
      ownerKind: "session",
      ownerId: plainKey,
      repoRoot: workspace,
      baseRef: head,
      checkoutCommit: head,
    });

    const advancedNow = Date.now() + IDLE_GC_MS + 60_000;
    const cfg = getRuntimeConfig();
    const policy = createManagedWorktreeOwnerPolicy(cfg, () => advancedNow);
    expect(policy.shouldProtectOwner("session", sessionKey)).toBe(true);
    expect(policy.shouldRemoveOwner("session", sessionKey)).toBe(false);
    expect(policy.shouldProtectOwner("session", plainKey)).toBe(false);

    const service = new ManagedWorktreeService({
      env: process.env,
      getConfig: getRuntimeConfig,
      now: () => advancedNow,
    });
    const gc = await service.gc({
      shouldProtectOwner: policy.shouldProtectOwner,
      shouldRemoveOwner: policy.shouldRemoveOwner,
    });
    expect(gc.removed).toContain(plain.id);
    expect(gc.removed).not.toContain(record.id);
    expect(managedWorktrees.findLiveById(record.id)?.path).toBe(record.path);
    expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe(
      "protected draft\n",
    );
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(childHead);
    expect(await git(record.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(record.branch);

    const reopened = await directSessionReq<{
      conversation: { state: string; worktree?: { path: string } };
    }>("sideConversations.reopen", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.payload?.conversation.state).toBe("open");
    expect(reopened.payload?.conversation.worktree?.path).toBe(record.path);
    expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe(
      "protected draft\n",
    );
  },
);

test(
  "reopen restores a retired checkout from its removal snapshot",
  { timeout: 90_000 },
  async () => {
    await createGitFixture();
    const { sessionKey } = await createSide("intent-reopen-restore");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "draft.txt"), "restored draft\n");
    const childHead = await git(record.path, "rev-parse", "HEAD");
    const closed = await directSessionReq(
      "sideConversations.close",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true);

    const removed = await managedWorktrees.remove({ id: record.id, reason: "test-retirement" });
    expect(removed.removed).toBe(true);
    expect(getRegistryWorktree(process.env, record.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(path.join(record.path, "draft.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const reopened = await directSessionReq<{
      conversation: { state: string; worktree?: { id: string; path: string } };
    }>("sideConversations.reopen", { parentSessionKey: parentKey, sessionKey }, { client });
    expect(reopened.ok, JSON.stringify(reopened.error)).toBe(true);
    expect(reopened.payload?.conversation.state).toBe("open");
    expect(reopened.payload?.conversation.worktree).toMatchObject({
      id: record.id,
      path: record.path,
    });
    expect(await fs.readFile(path.join(record.path, "draft.txt"), "utf8")).toBe("restored draft\n");
    expect(await git(record.path, "rev-parse", "HEAD")).toBe(childHead);
    expect(await git(record.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(record.branch);
  },
);

test(
  "reopen stays closed with a visible failure when the snapshot is gone",
  { timeout: 90_000 },
  async () => {
    const { workspace, storePath } = await createGitFixture();
    const { sessionKey } = await createSide("intent-reopen-failed");
    const record = managedWorktrees.findLiveByOwner("session", sessionKey)!;
    await fs.writeFile(path.join(record.path, "draft.txt"), "lost draft\n");
    const closed = await directSessionReq(
      "sideConversations.close",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(closed.ok, JSON.stringify(closed.error)).toBe(true);
    const removed = await managedWorktrees.remove({ id: record.id, reason: "test-retirement" });
    expect(removed.removed).toBe(true);
    const snapshotRef = getRegistryWorktree(process.env, record.id)!.snapshotRef!;
    await git(workspace, "update-ref", "-d", snapshotRef);

    const reopened = await directSessionReq<{ conversation: { state: string } }>(
      "sideConversations.reopen",
      { parentSessionKey: parentKey, sessionKey },
      { client },
    );
    expect(reopened.ok).toBe(false);
    expect(reopened.error?.message).toContain("stays closed");
    expect(readEntry(storePath, sessionKey)?.sideConversation?.state).toBe("closed");
  },
);
