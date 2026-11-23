/**
 * Manual merge of one side-conversation branch into its parent checkout.
 *
 * The parent checkout stays untouched unless every precheck passes: the child
 * branch must be committed, the parent checkout clean and on a branch, and
 * `git merge-tree` must find no conflict. Conflicts are detected before any
 * working-tree write; the real merge then runs against the exact commits that
 * were inspected, and a failed merge is aborted back to the inspected HEAD.
 */
import { existsSync } from "node:fs";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { runGit } from "./git.js";

export type SideConversationMergeFailureCode =
  | "parent-dirty"
  | "child-dirty"
  | "parent-detached"
  | "merge-in-progress"
  | "child-branch-missing"
  | "conflict"
  | "source-changed"
  | "unsupported-git"
  | "merge-failed";

export type SideConversationMergeFailure = {
  code: SideConversationMergeFailureCode;
  message: string;
  /** Bounded list of conflicting or dirty paths for the caller to display. */
  paths?: string[];
};

export type SideConversationMergeOutcome = {
  /** Commit now reachable from the parent branch (the merge commit or child HEAD). */
  commit: string;
  alreadyMerged: boolean;
};

const MAX_REPORTED_PATHS = 10;

function failure(
  code: SideConversationMergeFailureCode,
  message: string,
  paths?: string[],
): SideConversationMergeFailure {
  return { code, message, ...(paths?.length ? { paths: paths.slice(0, MAX_REPORTED_PATHS) } : {}) };
}

function boundedPaths(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_REPORTED_PATHS);
}

async function dirtyPaths(
  checkoutPath: string,
): Promise<Result<string[], SideConversationMergeFailure>> {
  const status = await runGit(checkoutPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status.termination !== "exit" || status.code !== 0) {
    return err(
      failure("merge-failed", `could not inspect ${checkoutPath}: ${status.stderr.trim()}`),
    );
  }
  return ok(boundedPaths(status.stdout.split("\n")));
}

/** A checkout caught mid-merge cannot accept another merge or be aborted by us. */
async function mergeInProgress(checkoutPath: string): Promise<boolean> {
  const mergeHead = await runGit(checkoutPath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  return mergeHead.termination === "exit" && mergeHead.code === 0;
}

async function commitAt(
  checkoutPath: string,
  revision: string,
  missing: SideConversationMergeFailureCode,
  message: string,
): Promise<Result<string, SideConversationMergeFailure>> {
  const resolved = await runGit(checkoutPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  if (resolved.termination !== "exit" || resolved.code !== 0) {
    return err(failure(missing, message));
  }
  return ok(resolved.stdout.trim());
}

async function isAncestor(
  checkoutPath: string,
  ancestor: string,
  descendant: string,
): Promise<Result<boolean, SideConversationMergeFailure>> {
  const result = await runGit(checkoutPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.termination !== "exit") {
    return err(failure("merge-failed", `git merge-base failed: ${result.stderr.trim()}`));
  }
  if (result.code === 0) {
    return ok(true);
  }
  if (result.code === 1) {
    return ok(false);
  }
  return err(failure("merge-failed", `git merge-base failed: ${result.stderr.trim()}`));
}

/**
 * Oldest merge commit on the parent branch that names the child commit as a
 * direct parent. This is the landing commit of an earlier attempt, so a retry
 * can report the original merge instead of a fresh (nonexistent) one.
 */
type LandingLookup =
  | { status: "found"; commit: string }
  | { status: "none" }
  | { status: "unknown" };

async function findLandedMergeCommit(
  checkoutPath: string,
  childHead: string,
  parentHead: string,
): Promise<LandingLookup> {
  const result = await runGit(checkoutPath, [
    "rev-list",
    "--parents",
    "--merges",
    `${childHead}..${parentHead}`,
  ]);
  if (result.termination !== "exit" || result.code !== 0) {
    return { status: "unknown" };
  }
  let landed: string | undefined;
  // rev-list is newest first; the last direct-parent match is the original landing merge.
  for (const line of result.stdout.split("\n")) {
    const [commit, ...parents] = line.trim().split(/\s+/).filter(Boolean);
    if (commit && parents.includes(childHead)) {
      landed = commit;
    }
  }
  return landed ? { status: "found", commit: landed } : { status: "none" };
}

/**
 * Resolve the commit that already contains a merged side-conversation branch.
 *
 * Used by the replay path so a completed merge reports the same landing commit
 * as the call that created it.
 */
export async function resolveLandedSideConversationMerge(params: {
  parentCheckoutPath: string;
  childBranch: string;
}): Promise<string | undefined> {
  const parentHead = await commitAt(
    params.parentCheckoutPath,
    "HEAD",
    "merge-failed",
    "parent checkout has no committed HEAD",
  );
  if (!parentHead.ok) {
    return undefined;
  }
  const childHead = await commitAt(
    params.parentCheckoutPath,
    params.childBranch,
    "child-branch-missing",
    "side conversation branch is missing",
  );
  if (!childHead.ok) {
    return undefined;
  }
  const already = await isAncestor(params.parentCheckoutPath, childHead.value, parentHead.value);
  if (!already.ok || !already.value) {
    return undefined;
  }
  const landed = await findLandedMergeCommit(
    params.parentCheckoutPath,
    childHead.value,
    parentHead.value,
  );
  return landed.status === "found" ? landed.commit : childHead.value;
}

export type SideConversationLandingState =
  | { status: "landed"; mergeCommit: string }
  | { status: "not-landed" }
  /** The repository could not answer; callers must not treat this as "not landed". */
  | { status: "unknown" };

/** A genuinely absent branch has no accepted write; an execution failure does not. */
async function branchExists(
  checkoutPath: string,
  branch: string,
): Promise<"exists" | "missing" | "unknown"> {
  const result = await runGit(checkoutPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.termination !== "exit") {
    return "unknown";
  }
  if (result.code === 0) {
    return "exists";
  }
  return result.code === 1 ? "missing" : "unknown";
}

/**
 * Read-only tri-state landing inspection used before a state-only abandon.
 *
 * A child that never committed sits exactly on the parent HEAD; that is not an
 * accepted merge write and must not block an abandon. A landing merge commit
 * naming the child, or a child commit strictly contained in the parent branch,
 * is an accepted write whose merge retry must record it first. Every repository
 * or ancestry execution failure is `unknown`, never `not-landed`, so a transient
 * read error can never bury an accepted merge behind an abandon.
 */
export async function inspectSideConversationLanded(params: {
  parentCheckoutPath: string;
  childBranch: string;
}): Promise<SideConversationLandingState> {
  const parentHead = await runGit(params.parentCheckoutPath, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (parentHead.termination !== "exit" || parentHead.code !== 0) {
    return { status: "unknown" };
  }
  const branch = await branchExists(params.parentCheckoutPath, params.childBranch);
  if (branch === "missing") {
    return { status: "not-landed" };
  }
  if (branch === "unknown") {
    return { status: "unknown" };
  }
  const childHead = await runGit(params.parentCheckoutPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${params.childBranch}^{commit}`,
  ]);
  if (childHead.termination !== "exit" || childHead.code !== 0) {
    return { status: "unknown" };
  }
  const parent = parentHead.stdout.trim();
  const child = childHead.stdout.trim();
  const already = await isAncestor(params.parentCheckoutPath, child, parent);
  if (!already.ok) {
    return { status: "unknown" };
  }
  if (!already.value) {
    return { status: "not-landed" };
  }
  // Same commit on both sides: the child never committed beyond its base.
  if (child === parent) {
    return { status: "not-landed" };
  }
  const landing = await findLandedMergeCommit(params.parentCheckoutPath, child, parent);
  if (landing.status === "unknown") {
    return { status: "unknown" };
  }
  return {
    status: "landed",
    mergeCommit: landing.status === "found" ? landing.commit : child,
  };
}

type MergeTreeInspection =
  | { status: "clean" }
  | { status: "conflict"; paths: string[] }
  | { status: "unsupported" };

/** Parse conflicted paths from `merge-tree --write-tree` stage rows. */
function parseMergeTreeConflicts(stdout: string): string[] {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^[0-7]{6} [0-9a-f]+ [123]\t(.+)$/u.exec(line);
    if (match?.[1]) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

async function inspectMergeTree(
  parentCheckoutPath: string,
  parentHead: string,
  childHead: string,
): Promise<Result<MergeTreeInspection, SideConversationMergeFailure>> {
  const result = await runGit(parentCheckoutPath, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    parentHead,
    childHead,
  ]);
  if (result.termination !== "exit") {
    return err(failure("merge-failed", `git merge-tree failed: ${result.stderr.trim()}`));
  }
  if (result.code === 0) {
    return ok({ status: "clean" });
  }
  if (result.code === 1) {
    return ok({ status: "conflict", paths: parseMergeTreeConflicts(result.stdout) });
  }
  // Git older than 2.38 has no `--write-tree`; refuse instead of merging blind.
  const stderr = result.stderr.trim();
  if (/unknown option|usage:/iu.test(stderr)) {
    return ok({ status: "unsupported" });
  }
  return err(
    failure(
      "merge-failed",
      `git merge-tree could not inspect the merge: ${stderr || "unknown Git error"}`,
    ),
  );
}

export async function mergeSideConversationBranch(params: {
  parentCheckoutPath: string;
  childBranch: string;
  /** Present when the child checkout still exists; a missing checkout only skips its dirty check. */
  childCheckoutPath?: string;
  message: string;
  signal?: AbortSignal;
}): Promise<Result<SideConversationMergeOutcome, SideConversationMergeFailure>> {
  const signal = params.signal;
  const gitOptions = { signal };
  const parentCheckoutPath = params.parentCheckoutPath;

  signal?.throwIfAborted();
  if (!existsSync(parentCheckoutPath)) {
    return err(
      failure("merge-failed", `parent checkout ${parentCheckoutPath} is missing; restore it first`),
    );
  }
  const parentHead = await commitAt(
    parentCheckoutPath,
    "HEAD",
    "merge-failed",
    "parent checkout has no committed HEAD",
  );
  if (!parentHead.ok) {
    return parentHead;
  }
  const parentBranch = await runGit(parentCheckoutPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (parentBranch.termination !== "exit" || parentBranch.code !== 0) {
    return err(
      failure(
        "parent-detached",
        "parent checkout is on a detached HEAD; check out a branch before merging this side conversation",
      ),
    );
  }
  if (await mergeInProgress(parentCheckoutPath)) {
    return err(
      failure(
        "merge-in-progress",
        "parent checkout already has a merge in progress; finish or abort it before merging",
      ),
    );
  }
  const childHead = await commitAt(
    parentCheckoutPath,
    params.childBranch,
    "child-branch-missing",
    `side conversation branch ${params.childBranch} is missing; the branch may have been deleted`,
  );
  if (!childHead.ok) {
    return childHead;
  }
  const parentDirty = await dirtyPaths(parentCheckoutPath);
  if (!parentDirty.ok) {
    return parentDirty;
  }
  if (parentDirty.value.length > 0) {
    return err(
      failure(
        "parent-dirty",
        "parent checkout has uncommitted changes; commit or stash them before merging this side conversation",
        parentDirty.value,
      ),
    );
  }
  const childCheckoutPath = params.childCheckoutPath;
  if (childCheckoutPath && existsSync(childCheckoutPath)) {
    if (await mergeInProgress(childCheckoutPath)) {
      return err(
        failure(
          "merge-in-progress",
          "side conversation checkout has a merge in progress; finish or abort it before merging",
        ),
      );
    }
    const childDirty = await dirtyPaths(childCheckoutPath);
    if (!childDirty.ok) {
      return childDirty;
    }
    if (childDirty.value.length > 0) {
      return err(
        failure(
          "child-dirty",
          "side conversation has uncommitted changes; commit them before merging",
          childDirty.value,
        ),
      );
    }
  }

  const already = await isAncestor(parentCheckoutPath, childHead.value, parentHead.value);
  if (!already.ok) {
    return already;
  }
  if (already.value) {
    const landed = await findLandedMergeCommit(
      parentCheckoutPath,
      childHead.value,
      parentHead.value,
    );
    return ok({
      commit: landed.status === "found" ? landed.commit : childHead.value,
      alreadyMerged: true,
    });
  }

  const inspected = await inspectMergeTree(parentCheckoutPath, parentHead.value, childHead.value);
  if (!inspected.ok) {
    return inspected;
  }
  if (inspected.value.status === "unsupported") {
    return err(
      failure(
        "unsupported-git",
        "this Git version cannot preflight merges without touching the working tree; upgrade to Git 2.38 or newer",
      ),
    );
  }
  if (inspected.value.status === "conflict") {
    return err(
      failure(
        "conflict",
        "side conversation conflicts with the parent checkout; nothing was merged",
        inspected.value.paths,
      ),
    );
  }

  // The inspected commits must still be current; a moved branch needs a new preflight.
  const currentParent = await runGit(
    parentCheckoutPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    gitOptions,
  );
  const currentChild = await runGit(
    parentCheckoutPath,
    ["rev-parse", "--verify", "--end-of-options", `${params.childBranch}^{commit}`],
    gitOptions,
  );
  if (
    currentParent.termination !== "exit" ||
    currentParent.code !== 0 ||
    currentParent.stdout.trim() !== parentHead.value ||
    currentChild.termination !== "exit" ||
    currentChild.code !== 0 ||
    currentChild.stdout.trim() !== childHead.value
  ) {
    return err(
      failure(
        "source-changed",
        "side conversation or parent branch moved during the merge preflight; retry the merge",
      ),
    );
  }

  const merged = await runGit(
    parentCheckoutPath,
    ["merge", "--no-ff", "-m", params.message, childHead.value],
    gitOptions,
  );
  if (merged.termination !== "exit" || merged.code !== 0) {
    const mergeHeadPresent = await mergeInProgress(parentCheckoutPath);
    let aborted = true;
    if (mergeHeadPresent) {
      const abort = await runGit(parentCheckoutPath, ["merge", "--abort"], gitOptions);
      aborted = abort.termination === "exit" && abort.code === 0;
    }
    const restored = aborted
      ? await commitAt(parentCheckoutPath, "HEAD", "merge-failed", "")
      : undefined;
    const detail = merged.stderr.trim() || "unknown Git error";
    if (!aborted || !restored?.ok) {
      return err(
        failure(
          "merge-failed",
          `merge failed and the parent checkout could not be restored automatically: ${detail}. Inspect the parent checkout before retrying.`,
        ),
      );
    }
    return err(
      failure("merge-failed", `merge failed; the parent checkout was left unchanged: ${detail}`),
    );
  }

  const head = await commitAt(
    parentCheckoutPath,
    "HEAD",
    "merge-failed",
    "merge reported success without a commit",
  );
  if (!head.ok) {
    return head;
  }
  const parentReachable = await isAncestor(parentCheckoutPath, parentHead.value, head.value);
  const childReachable = await isAncestor(parentCheckoutPath, childHead.value, head.value);
  if (
    !parentReachable.ok ||
    !childReachable.ok ||
    !parentReachable.value ||
    !childReachable.value
  ) {
    return err(
      failure(
        "merge-failed",
        "merge commit does not contain both branches; inspect the parent checkout before retrying",
      ),
    );
  }
  return ok({ commit: head.value, alreadyMerged: false });
}

/** Short, display-safe subject line for the merge commit created by this owner. */
export function buildSideConversationMergeMessage(params: {
  label?: string;
  sessionKey: string;
}): string {
  const label = params.label?.trim();
  return `Merge side conversation ${label && label.length > 0 ? label : params.sessionKey}`.slice(
    0,
    200,
  );
}
