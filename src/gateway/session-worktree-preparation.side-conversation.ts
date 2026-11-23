/**
 * Side-conversation checkout preparation.
 *
 * Kept beside the session worktree owner so the ordinary `sessions.create`
 * defaults stay unchanged: only side conversations derive a fresh checkout from
 * their parent, and only they decide to skip isolation visibly.
 */
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { insideGitCheckout, runGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSideConversationParentCheckout } from "../sessions/side-conversation-worktree.js";
import type {
  PreparedGatewaySessionLifecycle,
  PrepareGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import {
  prepareSessionWorktree,
  resolveSpawnParentWorktreeSource,
  SessionWorktreeSourceChangedError,
  type SpawnParentWorktreeSource,
} from "./session-worktree-preparation.js";

/**
 * Materialize the isolated checkout every side conversation starts with.
 *
 * The child always gets its own managed worktree and branch, based on the
 * parent's committed HEAD; the parent's uncommitted edits are never copied. A
 * parent that has no Git source (non-Git workspace or remote-node execution) is
 * reported as skipped by the session-layer facts instead of pretending isolation,
 * and the child keeps the parent's ordinary working directory when one exists.
 */
export async function prepareSideConversationWorktreeCreation(params: {
  cfg: OpenClawConfig;
  target: Parameters<PrepareGatewaySessionLifecycle>[0];
  parentSessionKey: string;
  parentEntry: InternalSessionEntry;
  agentId: string;
  label?: string;
  signal?: AbortSignal;
  commitGuard: () => void;
}): Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>> {
  const { cfg, target, parentEntry, commitGuard } = params;
  commitGuard();
  if (parentEntry.pendingWorktree || parentEntry.pendingProjectGitUrl) {
    // The parent's own checkout does not exist yet, so there is no committed
    // parent HEAD to derive an isolated side conversation from.
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The parent session is still preparing its checkout; retry the side conversation after its first turn.",
        { retryable: true },
      ),
    );
  }
  if (hasRemoteExecutionBinding(parentEntry)) {
    // A remote parent's tools never run in a host checkout. Materializing a local
    // worktree here would derive from an unrelated repository, so the child keeps
    // the parent's shared roots and reports the remote-exec degradation.
    return sharedParentRoots(cfg, params.agentId, parentEntry);
  }
  const parentCheckout = resolveSideConversationParentCheckout({
    cfg,
    agentId: params.agentId,
    parentEntry,
  });
  let source: SpawnParentWorktreeSource | undefined;
  const parentWorktreeId = normalizeOptionalString(parentEntry.worktree?.id);
  const recordedParentRoot = normalizeOptionalString(parentEntry.worktree?.repoRoot);
  const liveParentWorktree = managedWorktrees.findLiveByOwner("session", params.parentSessionKey);
  // A parent whose recorded checkout is already retired still names its repository
  // root. Derive from that root instead of failing the side conversation; the
  // parent entry guard below still binds the creation to this parent incarnation.
  if (parentWorktreeId && recordedParentRoot && liveParentWorktree?.id !== parentWorktreeId) {
    source = recordedParentRootSource({
      agentId: params.agentId,
      parentSessionKey: params.parentSessionKey,
      repoRoot: recordedParentRoot,
    });
  }
  try {
    source ??= await resolveSpawnParentWorktreeSource(
      params.parentSessionKey,
      params.agentId,
      params.signal ? { signal: params.signal } : {},
    );
  } catch (error) {
    if (
      collectNestedErrorCandidates(error).some(
        (cause) => cause instanceof SessionWorktreeSourceChangedError,
      )
    ) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Parent session changed while creating its side conversation; retry the request.",
          { retryable: true },
        ),
      );
    }
    throw error;
  }
  const workspace =
    source?.workspace ??
    normalizeOptionalString(parentEntry.spawnedWorkspaceDir) ??
    normalizeOptionalString(parentEntry.spawnedCwd) ??
    resolveAgentWorkspaceDir(cfg, params.agentId);
  commitGuard();
  if (!workspace || !insideGitCheckout(workspace)) {
    // Shared, not isolated: the child keeps the parent's ordinary cwd when it has one.
    return sharedParentRoots(cfg, params.agentId, parentEntry);
  }
  // Pin the parent's committed HEAD. A parent checkout that is not reachable from
  // the selected repository falls back to that repository's own HEAD.
  const parentHead = parentCheckout
    ? await readHeadCommit(parentCheckout.path, params.signal)
    : undefined;
  const baseCommit =
    parentHead && (await repositoryHasCommit(workspace, parentHead, params.signal))
      ? parentHead
      : await readHeadCommit(workspace, params.signal);
  commitGuard();
  if (!baseCommit) {
    return err(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "The parent workspace has no committed Git history yet; make an initial commit before starting a side conversation.",
      ),
    );
  }
  const prepared = await prepareSessionWorktree({
    cfg,
    target,
    workspace,
    // The exact parent commit is both the recorded base and the checkout point.
    baseRef: baseCommit,
    checkoutCommit: baseCommit,
    ...(params.label ? { label: params.label } : {}),
    // Repository setup scripts are an explicit admin action, never an implicit
    // side effect of opening a side conversation.
    runSetupScript: false,
    ...(params.signal ? { signal: params.signal } : {}),
    commitGuard,
    ...(source
      ? {
          withSource: source.withCurrent,
          ...(source.withRollback ? { withRollback: source.withRollback } : {}),
        }
      : {}),
  });
  return prepared;
}

/** Node-executed parents own no host checkout, so their child shares the recorded roots. */
export function hasRemoteExecutionBinding(
  entry: Pick<InternalSessionEntry, "execHost" | "execNode"> | undefined,
): boolean {
  return entry?.execHost === "node" || Boolean(normalizeOptionalString(entry?.execNode));
}

function sharedParentRoots(
  cfg: OpenClawConfig,
  agentId: string,
  parentEntry: InternalSessionEntry,
): Result<PreparedGatewaySessionLifecycle, ErrorShape> {
  const roots = resolveSessionWorkspaceRoots(cfg, agentId, parentEntry);
  const spawnedCwd = normalizeOptionalString(roots.diffCwd);
  const sessionRoot = normalizeOptionalString(roots.root);
  return ok({
    ...(spawnedCwd ? { spawnedCwd } : {}),
    ...(sessionRoot ? { sessionRoot } : {}),
  });
}

/** Custody for a parent whose own checkout is gone but whose repository root remains. */
function recordedParentRootSource(params: {
  agentId: string;
  parentSessionKey: string;
  repoRoot: string;
}): SpawnParentWorktreeSource {
  const parent = loadGatewaySessionEntryReadOnly(params.parentSessionKey, {
    agentId: params.agentId,
  });
  const parentSessionId = parent.entry?.sessionId;
  const assertCurrent = () => {
    const current = loadGatewaySessionEntryReadOnly(params.parentSessionKey, {
      agentId: params.agentId,
    });
    if (
      !parentSessionId ||
      current.entry?.sessionId !== parentSessionId ||
      current.entry.archivedAt !== undefined ||
      current.entry.worktree?.repoRoot !== params.repoRoot
    ) {
      throw new SessionWorktreeSourceChangedError(
        "Spawn parent worktree changed; retry from its current session",
      );
    }
  };
  return {
    workspace: params.repoRoot,
    withCurrent: async (run) => await run({ assertCurrent }),
  };
}

async function readHeadCommit(
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const head = await runGit(
    checkoutPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal ? { signal } : {},
  );
  return head.termination === "exit" && head.code === 0 ? head.stdout.trim() : undefined;
}

async function repositoryHasCommit(
  workspace: string,
  commit: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const exists = await runGit(
    workspace,
    ["cat-file", "-e", `${commit}^{commit}`],
    signal ? { signal } : {},
  );
  return exists.termination === "exit" && exists.code === 0;
}
