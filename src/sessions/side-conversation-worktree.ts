/**
 * Side-conversation worktree facts and checkout resolution.
 *
 * A side conversation owns its own managed worktree when its parent has a Git
 * source. When it does not (non-Git workspace, remote-node parent, or a row with
 * no worktree binding) the session is never presented as isolated: readers get an
 * explicit skip reason and a `shared` filesystem isolation fact instead.
 *
 * Databases, listening ports, and network APIs are never per-conversation; that
 * external-state fact is constant and must stay visible on the wire.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SideConversationWorktreeFact,
  SideConversationWorktreeSkipReason,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type SideConversationWorktreeState =
  | { kind: "worktree"; facts: SideConversationWorktreeFact }
  | { kind: "skipped"; reason: SideConversationWorktreeSkipReason };

type SessionWorktreeBinding = Pick<InternalSessionEntry, "worktree">;

/** A parent bound to a remote node runs its tools there, not in a local checkout. */
function runsOnRemoteNode(
  entry: Pick<InternalSessionEntry, "execHost" | "execNode"> | undefined,
): boolean {
  return entry?.execHost === "node" || Boolean(normalizeOptionalString(entry?.execNode));
}

function readLiveWorktree(binding: SessionWorktreeBinding | undefined) {
  const id = normalizeOptionalString(binding?.worktree?.id);
  if (!id) {
    return undefined;
  }
  return managedWorktrees.findLiveById(id);
}

/** The checkout a parent session's tools use, when it is local and inside Git. */
export function resolveSideConversationParentCheckout(params: {
  cfg: OpenClawConfig;
  agentId: string;
  parentEntry: InternalSessionEntry | undefined;
}): { path: string; repoRoot?: string; source: "worktree" | "session-cwd" } | undefined {
  const record = readLiveWorktree(params.parentEntry);
  if (record) {
    return { path: record.path, repoRoot: record.repoRoot, source: "worktree" };
  }
  const cwd =
    normalizeOptionalString(params.parentEntry?.spawnedCwd) ??
    normalizeOptionalString(params.parentEntry?.spawnedWorkspaceDir) ??
    normalizeOptionalString(resolveAgentWorkspaceDir(params.cfg, params.agentId));
  if (!cwd || runsOnRemoteNode(params.parentEntry) || !insideGitCheckout(cwd)) {
    return undefined;
  }
  return { path: cwd, source: "session-cwd" };
}

/** The child's own checkout and branch, when it still owns a live worktree. */
export function resolveSideConversationChildCheckout(entry: InternalSessionEntry | undefined): {
  checkoutPath?: string;
  branch?: string;
} {
  const branch = normalizeOptionalString(entry?.worktree?.branch);
  const record = readLiveWorktree(entry);
  return {
    ...(record ? { checkoutPath: record.path } : {}),
    ...(branch ? { branch } : {}),
  };
}

/**
 * Explain why this child has no isolated checkout without inventing isolation.
 *
 * `unavailable` is used when the parent source is Git but the child owns no live
 * worktree, for example a row created before isolation existed or a checkout that
 * was retired by explicit cleanup.
 */
export function resolveSideConversationWorktreeSkipReason(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: InternalSessionEntry | undefined;
  parentEntry: InternalSessionEntry | undefined;
}): SideConversationWorktreeSkipReason {
  if (runsOnRemoteNode(params.parentEntry) || runsOnRemoteNode(params.entry)) {
    return "remote-exec";
  }
  const parentCheckout = resolveSideConversationParentCheckout(params);
  if (!parentCheckout) {
    return "not-git";
  }
  return "unavailable";
}

/** Resolve the wire facts for one hidden child row. */
export function resolveSideConversationWorktreeState(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: InternalSessionEntry | undefined;
  parentEntry: InternalSessionEntry | undefined;
}): SideConversationWorktreeState {
  const record = readLiveWorktree(params.entry);
  const branch =
    normalizeOptionalString(record?.branch) ??
    normalizeOptionalString(params.entry?.worktree?.branch);
  if (record && branch) {
    return {
      kind: "worktree",
      facts: {
        id: record.id,
        branch,
        path: record.path,
        ...(normalizeOptionalString(record.baseRef)
          ? { baseRef: normalizeOptionalString(record.baseRef)! }
          : {}),
      },
    };
  }
  return {
    kind: "skipped",
    reason: resolveSideConversationWorktreeSkipReason(params),
  };
}
