import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  formatSideConversationHandoffPrompt,
  readSideConversationHandoffQueue,
  SIDE_CONVERSATION_HANDOFF_MAX_PENDING,
} from "./side-conversation-handoff-queue.js";
import {
  cancelPendingSideConversationHandoffs,
  claimSideConversationHandoffPrompt,
  clearSideConversationHandoffClaimsForTest,
  ensureClosedSideConversationHandoff,
  inspectSideConversationHandoffEdits,
} from "./side-conversation-handoff.js";

const parentKey = "agent:main:dashboard:handoff-parent";

afterEach(async () => {
  clearSideConversationHandoffClaimsForTest();
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createRepository(state: { root: string }): Promise<string> {
  const repo = path.join(state.root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "handoff@example.test");
  await git(repo, "config", "user.name", "Handoff Test");
  await fs.writeFile(path.join(repo, "readme.md"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  return repo;
}

async function addChildWorktree(params: {
  repo: string;
  stateRoot: string;
  env: NodeJS.ProcessEnv;
  childKey: string;
  branch: string;
  ownerId: string;
}): Promise<{ path: string; branch: string; baseRef: string; id: string }> {
  const dir = path.join(params.stateRoot, `checkout-${params.branch}`);
  await git(params.repo, "worktree", "add", "-b", params.branch, dir, "HEAD");
  const baseRef = await git(params.repo, "rev-parse", "HEAD");
  const record = {
    id: `wt-${params.branch}`,
    name: params.branch,
    repoFingerprint: "0123456789abcdef",
    repoRoot: params.repo,
    path: dir,
    branch: params.branch,
    baseRef,
    ownerKind: "session" as const,
    ownerId: params.ownerId,
    createdAt: 10,
    lastActiveAt: 20,
  };
  insertRegistryWorktree(params.env, record);
  return { path: dir, branch: params.branch, baseRef, id: record.id };
}

function childEntry(params: {
  childKey: string;
  intentId: string;
  ordinal: number;
  worktree?: { id: string; branch: string; repoRoot: string };
  closedAt?: number;
}): InternalSessionEntry {
  return {
    sessionId: `child-${params.intentId}`,
    updatedAt: 100,
    label: `Child ${params.ordinal}`,
    ...(params.worktree ? { worktree: params.worktree } : {}),
    sideConversation: {
      parentSessionKey: parentKey,
      intentId: params.intentId,
      ordinal: params.ordinal,
      state: "closed",
      createdAt: 1,
      updatedAt: 2,
      closedAt: params.closedAt ?? 3,
    },
  };
}

async function seedParent(params: {
  storePath: string;
  repo: string;
}): Promise<InternalSessionEntry> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey: parentKey, storePath: params.storePath },
    { sessionId: "parent-session", updatedAt: 1, spawnedCwd: params.repo },
  );
  const entry = loadSessionEntry({
    agentId: "main",
    sessionKey: parentKey,
    storePath: params.storePath,
  }) as InternalSessionEntry | undefined;
  if (!entry) {
    throw new Error("expected the seeded parent entry");
  }
  return entry;
}

function readParent(storePath: string): InternalSessionEntry {
  const entry = loadSessionEntry({
    agentId: "main",
    sessionKey: parentKey,
    storePath,
    readConsistency: "latest",
  }) as InternalSessionEntry | undefined;
  if (!entry) {
    throw new Error("expected the parent entry");
  }
  return entry;
}

function readQueue(storePath: string) {
  return readSideConversationHandoffQueue(readParent(storePath));
}

/** Hold a real SQLite write lock on the parent agent database. */
function lockParentDatabase(storePath: string): { release: () => void } {
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "main",
  }).path;
  if (!databasePath) {
    throw new Error("expected the parent agent database path");
  }
  const database = new DatabaseSync(databasePath, { timeout: 0 });
  database.exec("BEGIN IMMEDIATE");
  return {
    release: () => {
      database.exec("ROLLBACK");
      database.close();
    },
  };
}

async function ensureParentHandoff(params: {
  cfg?: Record<string, unknown>;
  child: InternalSessionEntry;
  childSessionKey: string;
  now?: number;
  parent: InternalSessionEntry;
  storePath: string;
}) {
  return await ensureClosedSideConversationHandoff({
    cfg: params.cfg ?? {},
    agentId: "main",
    child: params.child,
    childSessionKey: params.childSessionKey,
    now: params.now ?? 1_000,
    parentEntry: params.parent,
    parentSessionKey: parentKey,
    storePath: params.storePath,
  });
}

const turn = (storePath: string) => ({
  sessionKey: parentKey,
  sessionTarget: { agentId: "main", sessionKey: parentKey, storePath },
  trigger: "user" as const,
});

describe("side conversation handoff facts", () => {
  it("reports bounded checkout facts for dirty work and unreadable checkouts", async () => {
    await withOpenClawTestState({ label: "handoff-facts" }, async (state) => {
      const repo = await createRepository(state);
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child",
        branch: "side-facts",
        ownerId: "agent:main:child",
      });
      const clean = await inspectSideConversationHandoffEdits({
        childCheckoutPath: child.path,
        childBranch: child.branch,
        parentCheckoutPath: repo,
        baseRef: child.baseRef,
      });
      expect(clean).toMatchObject({
        branch: "side-facts",
        path: child.path,
        commitsAhead: 0,
        changedFiles: 0,
      });
      expect(clean.headCommit).toBe(child.baseRef.slice(0, 12));

      await fs.writeFile(path.join(child.path, "draft.txt"), "draft\n");
      await fs.writeFile(path.join(child.path, "readme.md"), "changed\n");
      const dirty = await inspectSideConversationHandoffEdits({
        childCheckoutPath: child.path,
        childBranch: child.branch,
        parentCheckoutPath: repo,
        baseRef: child.baseRef,
      });
      expect(dirty.changedFiles).toBe(2);

      await git(child.path, "add", ".");
      await git(child.path, "commit", "-m", "child change");
      const committed = await inspectSideConversationHandoffEdits({
        childCheckoutPath: child.path,
        childBranch: child.branch,
        parentCheckoutPath: repo,
        baseRef: child.baseRef,
      });
      expect(committed).toMatchObject({ commitsAhead: 1, changedFiles: 0 });

      const missing = await inspectSideConversationHandoffEdits({
        childCheckoutPath: path.join(state.root, "missing-checkout"),
        childBranch: child.branch,
        parentCheckoutPath: repo,
        baseRef: child.baseRef,
      });
      expect(missing.changedFiles).toBeUndefined();
      expect(missing.commitsAhead).toBe(1);
    });
  });
});

describe("side conversation handoff queue", () => {
  it("records one reminder for a close with edits and skips an untouched close", async () => {
    await withOpenClawTestState({ label: "handoff-enqueue" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-dirty",
        branch: "side-dirty",
        ownerId: "agent:main:child-dirty",
      });
      await fs.writeFile(path.join(child.path, "draft.txt"), "draft\n");

      const recorded = await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-dirty",
          intentId: "intent-dirty",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-dirty",
        parent,
        storePath,
      });
      expect(recorded).toEqual({ status: "recorded" });

      const queue = readQueue(storePath);
      expect(queue.nextSequence).toBe(2);
      expect(queue.pending).toHaveLength(1);
      expect(queue.pending[0]).toMatchObject({
        sequence: 1,
        sessionKey: "agent:main:child-dirty",
        intentId: "intent-dirty",
        ordinal: 1,
        title: "Child 1",
        closedAt: 3,
        worktree: {
          branch: "side-dirty",
          path: child.path,
          changedFiles: 1,
          commitsAhead: 0,
        },
      });
      const text = formatSideConversationHandoffPrompt({
        notices: queue.pending,
        droppedCount: 0,
      });
      expect(text).toContain("[Side conversation handoff] 1 side conversation was closed");
      expect(text).toContain("branch: side-dirty");
      expect(text).toContain(`path: ${child.path}`);
      expect(text).toContain("1 uncommitted file");
      expect(text).toContain("do not merge, abandon, reopen, or start a run on your own");

      const cleanChild = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-clean",
        branch: "side-clean",
        ownerId: "agent:main:child-clean",
      });
      const skipped = await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-clean",
          intentId: "intent-clean",
          ordinal: 2,
          worktree: { id: cleanChild.id, branch: cleanChild.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-clean",
        parent,
        storePath,
      });
      expect(skipped).toEqual({ status: "no-edits" });
      expect(readQueue(storePath).pending).toHaveLength(1);

      // A repeated close of the same generation is final, not duplicated.
      expect(
        await ensureParentHandoff({
          child: childEntry({
            childKey: "agent:main:child-dirty",
            intentId: "intent-dirty",
            ordinal: 1,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
          }),
          childSessionKey: "agent:main:child-dirty",
          parent,
          storePath,
        }),
      ).toEqual({ status: "already-recorded" });
      expect(readQueue(storePath).pending).toHaveLength(1);
    });
  });

  it("repairs a close reminder whose enqueue write failed", async () => {
    await withOpenClawTestState({ label: "handoff-close-failure" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-locked",
        branch: "side-locked",
        ownerId: "agent:main:child-locked",
      });
      await fs.writeFile(path.join(child.path, "draft.txt"), "draft\n");
      const childClosed = childEntry({
        childKey: "agent:main:child-locked",
        intentId: "intent-locked",
        ordinal: 1,
        worktree: { id: child.id, branch: child.branch, repoRoot: repo },
      });

      const lock = lockParentDatabase(storePath);
      try {
        await expect(
          ensureParentHandoff({
            child: childClosed,
            childSessionKey: "agent:main:child-locked",
            parent,
            storePath,
          }),
        ).rejects.toThrow(/locked|busy/iu);
      } finally {
        lock.release();
      }
      expect(readQueue(storePath).pending).toHaveLength(0);

      // The retried close inspects again and records the missing reminder.
      expect(
        await ensureParentHandoff({
          child: childClosed,
          childSessionKey: "agent:main:child-locked",
          parent,
          storePath,
        }),
      ).toEqual({ status: "recorded" });
      expect(readQueue(storePath).pending).toHaveLength(1);
    });
  });

  it("keeps the pending reminder across a store restart", async () => {
    await withOpenClawTestState({ label: "handoff-restart" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-restart",
        branch: "side-restart",
        ownerId: "agent:main:child-restart",
      });
      await git(child.path, "commit", "--allow-empty", "-m", "child commit");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-restart",
          intentId: "intent-restart",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-restart",
        parent,
        storePath,
      });

      await closeOpenClawAgentDatabasesAsync();
      const queue = readQueue(storePath);
      expect(queue.pending.map((notice) => notice.intentId)).toEqual(["intent-restart"]);
      expect(queue.pending[0]?.worktree?.commitsAhead).toBe(1);
    });
  });

  it("aggregates several notices into one bounded block", async () => {
    await withOpenClawTestState({ label: "handoff-bounded" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-many",
        branch: "side-many",
        ownerId: "agent:main:child-many",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      for (let index = 1; index <= SIDE_CONVERSATION_HANDOFF_MAX_PENDING + 2; index += 1) {
        await ensureParentHandoff({
          child: childEntry({
            childKey: `agent:main:child-many-${index}`,
            intentId: `intent-many-${index}`,
            ordinal: index,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
            closedAt: 100 + index,
          }),
          childSessionKey: `agent:main:child-many-${index}`,
          now: 1_000 + index,
          parent,
          storePath,
        });
      }
      const queue = readQueue(storePath);
      expect(queue.pending).toHaveLength(SIDE_CONVERSATION_HANDOFF_MAX_PENDING);
      expect(queue.dropped).toEqual([1, 2]);
      expect(queue.nextSequence).toBe(SIDE_CONVERSATION_HANDOFF_MAX_PENDING + 3);
      const text = formatSideConversationHandoffPrompt({
        notices: queue.pending,
        droppedCount: queue.dropped?.length ?? 0,
      });
      expect(text).toContain(
        `${SIDE_CONVERSATION_HANDOFF_MAX_PENDING} side conversations were closed`,
      );
      expect(text).toContain("2 earlier closed side conversations had pending handoffs");
      // The newest closes are the ones kept.
      expect(queue.pending.at(-1)?.intentId).toBe(
        `intent-many-${SIDE_CONVERSATION_HANDOFF_MAX_PENDING + 2}`,
      );
    });
  });

  it("reopen cancels only that child's undelivered notice", async () => {
    await withOpenClawTestState({ label: "handoff-reopen" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-reopen",
        branch: "side-reopen",
        ownerId: "agent:main:child-reopen",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      for (const [intentId, ordinal] of [
        ["intent-reopen", 1],
        ["intent-other", 2],
      ] as const) {
        await ensureParentHandoff({
          child: childEntry({
            childKey: `agent:main:${intentId}`,
            intentId,
            ordinal,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
            closedAt: 100 + ordinal,
          }),
          childSessionKey: `agent:main:${intentId}`,
          parent,
          storePath,
        });
      }
      expect(readQueue(storePath).pending).toHaveLength(2);

      const cancelled = await cancelPendingSideConversationHandoffs({
        agentId: "main",
        intentId: "intent-reopen",
        parentSessionKey: parentKey,
        storePath,
      });
      expect(cancelled).toBe(1);
      expect(readQueue(storePath).pending.map((notice) => notice.intentId)).toEqual([
        "intent-other",
      ]);
    });
  });
});

describe("side conversation handoff delivery", () => {
  it("delivers the batch once, only after dispatch, and never repeats it", async () => {
    await withOpenClawTestState({ label: "handoff-delivery" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-deliver",
        branch: "side-deliver",
        ownerId: "agent:main:child-deliver",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-deliver",
          intentId: "intent-deliver",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-deliver",
        parent,
        storePath,
      });

      const claim = await claimSideConversationHandoffPrompt({
        runId: "run-deliver",
        ...turn(storePath),
      });
      expect(claim?.prependContext).toContain("[Side conversation handoff]");
      expect(readQueue(storePath).dispatching?.runId).toBe("run-deliver");
      // Same run retry: identical text, still undelivered and receipt-stable.
      const retried = await claimSideConversationHandoffPrompt({
        runId: "run-deliver",
        ...turn(storePath),
      });
      expect(retried?.prependContext).toBe(claim?.prependContext);

      await claim!.commit();
      const queue = readQueue(storePath);
      expect(queue.pending).toHaveLength(0);
      expect(queue.dispatching).toBeUndefined();
      expect(queue.delivered?.["intent-deliver"]).toMatchObject({ sequence: 1, closedAt: 3 });
      // Both the delivered run and a later user message stay silent.
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-deliver", ...turn(storePath) }),
      ).toBeUndefined();
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-later", ...turn(storePath) }),
      ).toBeUndefined();
      await claim!.commit();
    });
  });

  it("releases a pre-send claim so a retry still delivers the reminder", async () => {
    await withOpenClawTestState({ label: "handoff-release" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-release",
        branch: "side-release",
        ownerId: "agent:main:child-release",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-release",
          intentId: "intent-release",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-release",
        parent,
        storePath,
      });

      const claim = await claimSideConversationHandoffPrompt({
        runId: "run-release",
        ...turn(storePath),
      });
      await claim!.release();
      expect(readQueue(storePath).dispatching).toBeUndefined();
      expect(readQueue(storePath).pending).toHaveLength(1);

      // The same run may try again, and the next user message still gets it.
      const retried = await claimSideConversationHandoffPrompt({
        runId: "run-release",
        ...turn(storePath),
      });
      expect(retried?.prependContext).toContain("[Side conversation handoff]");
      await retried!.commit();
      expect(readQueue(storePath).pending).toHaveLength(0);
    });
  });

  it("treats a delivery write failure as delivered and cleans up later", async () => {
    await withOpenClawTestState({ label: "handoff-dispatch-failure" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-dispatch",
        branch: "side-dispatch",
        ownerId: "agent:main:child-dispatch",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-dispatch",
          intentId: "intent-dispatch",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-dispatch",
        parent,
        storePath,
      });

      const claim = await claimSideConversationHandoffPrompt({
        runId: "run-dispatch",
        ...turn(storePath),
      });
      const lock = lockParentDatabase(storePath);
      try {
        await claim!.commit();
        expect(readQueue(storePath).pending).toHaveLength(1);
        expect(readQueue(storePath).dispatching?.runId).toBe("run-dispatch");
        // The same run and the next run must both suppress the reminder.
        expect(
          await claimSideConversationHandoffPrompt({ runId: "run-dispatch", ...turn(storePath) }),
        ).toBeUndefined();
        expect(
          await claimSideConversationHandoffPrompt({ runId: "run-next", ...turn(storePath) }),
        ).toBeUndefined();
      } finally {
        lock.release();
      }

      // After release, a later run reconciles the receipt without re-injecting.
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-reconcile", ...turn(storePath) }),
      ).toBeUndefined();
      const queue = readQueue(storePath);
      expect(queue.pending).toHaveLength(0);
      expect(queue.dispatching).toBeUndefined();
      expect(queue.delivered?.["intent-dispatch"]).toMatchObject({ sequence: 1, closedAt: 3 });
    });
  });

  it("does not absorb a close that lands during an empty run's retries", async () => {
    await withOpenClawTestState({ label: "handoff-negative" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-negative",
        branch: "side-negative",
        ownerId: "agent:main:child-negative",
      });
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-empty", ...turn(storePath) }),
      ).toBeUndefined();

      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-negative",
          intentId: "intent-negative",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-negative",
        parent,
        storePath,
      });
      expect(readQueue(storePath).pending).toHaveLength(1);
      // Same run stays byte-stable: the close belongs to the next user message.
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-empty", ...turn(storePath) }),
      ).toBeUndefined();
      const nextRun = await claimSideConversationHandoffPrompt({
        runId: "run-fresh",
        ...turn(storePath),
      });
      expect(nextRun?.prependContext).toContain("[Side conversation handoff]");
    });
  });

  it("consumes dropped history only with its delivered batch", async () => {
    await withOpenClawTestState({ label: "handoff-dropped" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-dropped",
        branch: "side-dropped",
        ownerId: "agent:main:child-dropped",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      const record = async (index: number) =>
        await ensureParentHandoff({
          child: childEntry({
            childKey: `agent:main:child-dropped-${index}`,
            intentId: `intent-dropped-${index}`,
            ordinal: index,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
            closedAt: 100 + index,
          }),
          childSessionKey: `agent:main:child-dropped-${index}`,
          parent,
          storePath,
        });
      for (let index = 1; index <= SIDE_CONVERSATION_HANDOFF_MAX_PENDING + 2; index += 1) {
        await record(index);
      }
      expect(readQueue(storePath).dropped).toEqual([1, 2]);

      const claim = await claimSideConversationHandoffPrompt({
        runId: "run-dropped",
        ...turn(storePath),
      });
      expect(claim?.prependContext).toContain("2 earlier closed side conversations");
      await claim!.commit();
      expect(readQueue(storePath).dropped).toBeUndefined();

      // A new close after delivery renders only its own note.
      await record(20);
      const nextClaim = await claimSideConversationHandoffPrompt({
        runId: "run-dropped-next",
        ...turn(storePath),
      });
      expect(nextClaim?.prependContext).toContain("1 side conversation was closed");
      expect(nextClaim?.prependContext).not.toContain("earlier closed side conversation");
    });
  });

  it("never drains for cron, subagent, internal, or incognito turns", async () => {
    await withOpenClawTestState({ label: "handoff-guards" }, async (state) => {
      const repo = await createRepository(state);
      const storePath = path.join(state.root, "sessions.json");
      const parent = await seedParent({ storePath, repo });
      const child = await addChildWorktree({
        repo,
        stateRoot: state.root,
        env: state.env,
        childKey: "agent:main:child-guard",
        branch: "side-guard",
        ownerId: "agent:main:child-guard",
      });
      await fs.writeFile(path.join(child.path, "work.txt"), "work\n");
      await ensureParentHandoff({
        child: childEntry({
          childKey: "agent:main:child-guard",
          intentId: "intent-guard",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-guard",
        parent,
        storePath,
      });
      const sessionTarget = { agentId: "main", sessionKey: parentKey, storePath };
      const claims = await Promise.all([
        claimSideConversationHandoffPrompt({
          runId: "run-cron",
          sessionKey: parentKey,
          sessionTarget,
          trigger: "cron",
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-heartbeat",
          sessionKey: parentKey,
          sessionTarget,
          trigger: "heartbeat",
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-subagent",
          sessionKey: "agent:main:subagent:child",
          sessionTarget,
          trigger: "user",
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-internal",
          sessionKey: parentKey,
          sessionTarget,
          trigger: "user",
          inputProvenance: { kind: "internal_system" },
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-incognito",
          sessionKey: "agent:main:incognito:abc",
          sessionTarget: { ...sessionTarget, sessionKey: "agent:main:incognito:abc" },
          trigger: "user",
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-continuation",
          sessionKey: parentKey,
          sessionTarget,
          trigger: "user",
          skipPreparedUserTurnMessage: true,
        }),
        claimSideConversationHandoffPrompt({
          runId: "run-internal-event",
          sessionKey: parentKey,
          sessionTarget,
          trigger: "user",
          hasInternalEvents: true,
        }),
      ]);
      expect(claims).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(readQueue(storePath).pending).toHaveLength(1);
    });
  });
});
