import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
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
  enqueueSideConversationHandoff,
  inspectSideConversationHandoffEdits,
} from "./side-conversation-handoff.js";

const parentKey = "agent:main:dashboard:handoff-parent";

afterEach(async () => {
  clearSideConversationHandoffClaimsForTest();
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
  it("queues one reminder for a close with edits and skips an untouched close", async () => {
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

      const enqueued = await enqueueSideConversationHandoff({
        cfg: {},
        agentId: "main",
        child: childEntry({
          childKey: "agent:main:child-dirty",
          intentId: "intent-dirty",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-dirty",
        now: 1_000,
        parentEntry: parent,
        parentSessionKey: parentKey,
        storePath,
      });
      expect(enqueued).toEqual({ enqueued: true });

      const queue = readSideConversationHandoffQueue(readParent(storePath));
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
      const text = formatSideConversationHandoffPrompt(queue);
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
      const skipped = await enqueueSideConversationHandoff({
        cfg: {},
        agentId: "main",
        child: childEntry({
          childKey: "agent:main:child-clean",
          intentId: "intent-clean",
          ordinal: 2,
          worktree: { id: cleanChild.id, branch: cleanChild.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-clean",
        now: 1_000,
        parentEntry: parent,
        parentSessionKey: parentKey,
        storePath,
      });
      expect(skipped).toEqual({ enqueued: false, reason: "no-edits" });
      expect(readSideConversationHandoffQueue(readParent(storePath)).pending).toHaveLength(1);
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
      await enqueueSideConversationHandoff({
        cfg: {},
        agentId: "main",
        child: childEntry({
          childKey: "agent:main:child-restart",
          intentId: "intent-restart",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-restart",
        now: 1_000,
        parentEntry: parent,
        parentSessionKey: parentKey,
        storePath,
      });

      await closeOpenClawAgentDatabasesAsync();
      const queue = readSideConversationHandoffQueue(readParent(storePath));
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
        await enqueueSideConversationHandoff({
          cfg: {},
          agentId: "main",
          child: childEntry({
            childKey: `agent:main:child-many-${index}`,
            intentId: `intent-many-${index}`,
            ordinal: index,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
          }),
          childSessionKey: `agent:main:child-many-${index}`,
          now: 1_000 + index,
          parentEntry: parent,
          parentSessionKey: parentKey,
          storePath,
        });
      }
      const queue = readSideConversationHandoffQueue(readParent(storePath));
      expect(queue.pending).toHaveLength(SIDE_CONVERSATION_HANDOFF_MAX_PENDING);
      expect(queue.droppedCount).toBe(2);
      expect(queue.nextSequence).toBe(SIDE_CONVERSATION_HANDOFF_MAX_PENDING + 3);
      const text = formatSideConversationHandoffPrompt(queue);
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
        await enqueueSideConversationHandoff({
          cfg: {},
          agentId: "main",
          child: childEntry({
            childKey: `agent:main:${intentId}`,
            intentId,
            ordinal,
            worktree: { id: child.id, branch: child.branch, repoRoot: repo },
          }),
          childSessionKey: `agent:main:${intentId}`,
          now: 1_000,
          parentEntry: parent,
          parentSessionKey: parentKey,
          storePath,
        });
      }
      expect(readSideConversationHandoffQueue(readParent(storePath)).pending).toHaveLength(2);

      const cancelled = await cancelPendingSideConversationHandoffs({
        agentId: "main",
        intentId: "intent-reopen",
        parentSessionKey: parentKey,
        storePath,
      });
      expect(cancelled).toBe(1);
      expect(
        readSideConversationHandoffQueue(readParent(storePath)).pending.map(
          (notice) => notice.intentId,
        ),
      ).toEqual(["intent-other"]);
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
      await enqueueSideConversationHandoff({
        cfg: {},
        agentId: "main",
        child: childEntry({
          childKey: "agent:main:child-deliver",
          intentId: "intent-deliver",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-deliver",
        now: 1_000,
        parentEntry: parent,
        parentSessionKey: parentKey,
        storePath,
      });

      const turn = {
        sessionKey: parentKey,
        sessionTarget: { agentId: "main", sessionKey: parentKey, storePath },
        trigger: "user" as const,
      };
      const claim = await claimSideConversationHandoffPrompt({ runId: "run-deliver", ...turn });
      expect(claim?.prependContext).toContain("[Side conversation handoff]");
      // Same run retry: identical text, still undelivered.
      const retried = await claimSideConversationHandoffPrompt({ runId: "run-deliver", ...turn });
      expect(retried?.prependContext).toBe(claim?.prependContext);
      expect(readSideConversationHandoffQueue(readParent(storePath)).pending).toHaveLength(1);

      // A pre-send failure never dispatches, so another run still claims it.
      const nextRunClaim = await claimSideConversationHandoffPrompt({ runId: "run-next", ...turn });
      expect(nextRunClaim?.prependContext).toBe(claim?.prependContext);

      await nextRunClaim!.dispatch();
      expect(readSideConversationHandoffQueue(readParent(storePath)).pending).toHaveLength(0);
      // Both the delivered run and a later user message stay silent.
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-next", ...turn }),
      ).toBeUndefined();
      expect(
        await claimSideConversationHandoffPrompt({ runId: "run-later", ...turn }),
      ).toBeUndefined();
      // A retried dispatch is idempotent.
      await nextRunClaim!.dispatch();
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
      await enqueueSideConversationHandoff({
        cfg: {},
        agentId: "main",
        child: childEntry({
          childKey: "agent:main:child-guard",
          intentId: "intent-guard",
          ordinal: 1,
          worktree: { id: child.id, branch: child.branch, repoRoot: repo },
        }),
        childSessionKey: "agent:main:child-guard",
        now: 1_000,
        parentEntry: parent,
        parentSessionKey: parentKey,
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
      expect(readSideConversationHandoffQueue(readParent(storePath)).pending).toHaveLength(1);
    });
  });
});
