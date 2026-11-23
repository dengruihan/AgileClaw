---
doc-schema-version: 1
summary: "Persistent hidden child sessions for side work beside a conversation"
read_when:
  - You want to ask a side question or do side work without changing the main conversation
  - You are using the Control UI Side chat rail, panes, or worktrees
  - You are implementing a client that uses the sideConversations methods
title: "Side conversations"
---

A side conversation is a persistent, hidden child session of one dashboard
session. It has its own transcript, model selection, and workspace, so you can
explore a question or make a small change beside the main conversation without
adding either to the parent transcript.

In the Control UI, the **Side chat** rail lists a session's side conversations
and starts new ones. Each side conversation opens as its own chat pane beside
the parent. The child stays out of the session sidebar and default session
lists; the parent row reports how many children it has.

This page describes the Control UI side-conversation contract. Channel and TUI
`/btw` are a different, ephemeral one-shot contract; see
[BTW side questions](/tools/btw).

## At a glance

| Property     | Behavior                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relationship | Hidden child of one parent session; children never appear as normal sidebar sessions.                                                                             |
| Transcript   | Own transcript, seeded once from a frozen parent snapshot and never synchronized again.                                                                           |
| Runtime      | A real agent session with its own runs, tools, model selection, and permission behavior.                                                                          |
| Workspace    | Own managed worktree when the parent runs in a local Git checkout; otherwise shares the parent workspace and says so.                                             |
| Count        | Up to 32 registered side conversations per parent; abandoned entries do not count toward the limit.                                                               |
| Persistence  | Stored with sessions, so panes and transcripts survive reloads, reconnects, and Gateway restarts until you delete them. Close, merge, and abandon keep the child. |
| Settling     | Close, reopen, merge, abandon, or explicit delete. There is no automatic review, merge, or run.                                                                   |

## Start a side conversation

You start one from the parent session:

- Open the **Side chat** rail with the panel's **+** menu, its keyboard shortcut
  (Shift-Command-S on Apple platforms, Ctrl+Shift-S elsewhere), or type `/btw`
  or `/side` in the main composer.
- Type a question in the rail's composer and send it. Each sent question creates
  a new child and opens it as a split pane next to the parent.
- An empty `/btw` or `/side` opens a new child's composer without sending a
  question.
- Highlight text in a message and choose **Ask in side chat** to open a child
  pane with the quoted selection already staged as its draft.

You can keep several side conversations open at once, each in its own pane.
Narrow layouts show only the active pane. Closing a pane only hides it; the
child keeps its state and can be opened again from the rail.

Creation can take a moment because the child gets a fresh transcript and
checkout. The rail allows one creation at a time. If the parent is still
preparing its own checkout, wait for its first turn. In a Git workspace with no
committed history, make an initial commit first. If the frozen snapshot is too
large, creation fails with the token counts instead of truncating.

## Frozen snapshot

Creating a child takes one structured snapshot of the parent's active
transcript branch. The child never receives parent updates after that point.

<a id="snapshot-rules" />

The projection keeps:

- User, assistant, tool-result, and shell-execution messages that are part of
  the parent's active branch.
- Complete tool rounds, where every tool call in the assistant turn has a later
  matching result.
- Reasoning text, converted to plain text under a fixed marker. Provider-native
  thinking signatures are never copied or replayed.

It drops:

- Assistant turns that stopped `aborted` or `error`, plus their tool results.
- Tool calls without a settled result and tool results that no kept call claims.
- Context-excluded messages, control rows such as compaction or model changes,
  labels, leaf markers, and custom or application messages.

Copied messages are hidden from the child's visible transcript but stay in its
model context. A hidden boundary row after the copied history tells the model
that the snapshot is reference material, not a task to resume. The child's
transcript is never written back to the parent.

The snapshot is frozen at creation time:

- Text and reasoning prefixes already written by a parent run are captured as
  model-only reference context; the projection does not wait for a terminal stop
  reason.
- Incomplete work still follows the drop rules above: assistant turns that
  stopped `aborted` or `error`, and tool rounds whose calls lack settled
  results, are omitted.
- Only what existed at creation is copied. Streaming text that was not persisted
  then never appears, and later text is not appended even if the parent run
  completes a moment later.
- The parent's uncommitted working-tree changes are not copied.
- Later parent messages, compactions, or model changes do not update the child.

The Control UI path uses a hard safety cap of 100,000 estimated tokens. A
larger snapshot is refused with the snapshot and limit counts; it is never
truncated silently. To continue, reduce the parent history (for example with
session pruning), or start the side work from a new parent session.

## Worktree by default

<a id="worktree-isolation" />

Every side conversation tries to start with its own managed worktree:

- The new branch is based on the parent's committed `HEAD` when that commit is
  reachable from the selected repository; otherwise it uses the repository's
  own `HEAD`.
- The parent's uncommitted edits are never copied into the child.
- Repository setup scripts (`.openclaw/worktree-setup.sh`) do not run for a
  side conversation. Creating the side-conversation worktree is implicit for an
  `operator.write` caller; only a worktree started with setup remains an
  explicit admin action.

When the parent has no usable local Git source, the child shares the parent's
workspace and the UI shows why:

| Reason              | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| Not a Git workspace | The parent's working directory is not inside a Git checkout.            |
| Remote workspace    | The parent runs on a paired node or remote host with no local checkout. |
| Unavailable         | The child has no resolvable checkout, such as a retired record.         |

Shared mode is not isolation: edits in the child are visible to the parent
immediately. Treat it as working in the same folder, not as a sandbox.

Filesystem and external state are separate facts. A side conversation never
isolates databases, listening ports, or network services from the parent. Even
with its own worktree, the child shares the agent's configured state and
external resources unless a tool's own policy says otherwise. See
[Managed worktrees](/concepts/managed-worktrees#side-conversation-worktrees).

Closing does not touch the checkout. Reopening may restore a retired checkout;
otherwise the child stays closed. Among child actions, explicit delete is the
only one that retires the checkout; parent delete or archive can also clean up
children and their checkouts.

## Model selection

The child starts from a frozen copy of the parent's effective selection at
creation time: provider and model, thinking and reasoning levels, fast mode,
and verbosity, trace, and elevated levels. Changing agent defaults or another
session's model later does not move the child.

After creation, the child's pane controls change only that child. You can switch
its model or thinking level without affecting the parent, and the parent can
change independently. The status strip shows the child's current model.

## Lifecycle

| State       | Meaning                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `open`      | Active child; runs and edits are allowed.                                                               |
| `closed`    | Quiesced and kept; transcript, branch, and checkout remain. Reopen is available.                        |
| `merged`    | The child's committed branch was merged into the parent checkout. Terminal; branch and checkout remain. |
| `abandoned` | The conversation was dropped without merging. Terminal; branch, checkout, and uncommitted files remain. |

### Close and reopen

Closing stops in-flight work, then records `closed`. If work is still settling,
close returns a retryable busy error and changes nothing; retry after the run
finishes. Closing keeps the transcript, branch, and checkout intact.

Reopening is allowed only from `closed`. It restores a retired checkout before
changing state and never starts a run. If the checkout cannot be restored, the
conversation stays closed and the error says so; restore the repository or
start a new side conversation instead. Reopen also cancels that child's pending
next-message reminder, but only while it has not been dispatched.

### Merge

Merge writes the child's committed branch into the parent checkout through Git.
It requires:

- The child owns an isolated branch. A shared-checkout child has nothing
  separate to merge.
- Both the parent and the child are idle.
- The parent checkout is on a branch, has no merge in progress, and has no
  uncommitted or untracked changes.
- The child checkout is clean, with its work committed.
- Git can preflight the merge without conflicts (Git 2.38 or newer).

A conflict is detected before the parent's working tree is touched. The error
lists up to ten conflicting paths, and nothing is merged. A successful merge
creates a merge commit and records `merged`; it does not delete the branch or
checkout. Merging an already-merged branch reports the commit that already
contains it, using the original landing merge commit when Git can find it,
instead of merging again.

If Git landed the merge but recording the state failed, retry the merge. The
retry records the same landing commit and does not move the parent branch again.

### Abandon

Abandon records `abandoned` and changes nothing else: the branch, checkout, and
any uncommitted files stay. Use it when the side work should not land but you
may still want the files.

Abandon refuses a conversation that already merged, and it refuses when the
branch has landed in Git but the merge state was not recorded. In that case,
retry **Merge** to record the landing commit; the child then finishes as
`merged` and cannot be abandoned.

### Delete

Explicit delete is a Gateway API operation and is not exposed in the Control
UI. It requires the child to be closed or settled, not `open`. Delete snapshots
the checkout before removal so dirty work is preserved rather than discarded,
then removes the child row, transcript (by default), and registration.

If cleanup cannot finish safely, the child is still deleted and the result
reports retryable cleanup plus any preserved checkout, its branch, path, and
reason. Locate that checkout and recover anything you need before deleting it
yourself.

## Next-message handoff

Close records a durable reminder on the parent when the child has committed or
uncommitted changes, or when its checkout cannot be inspected. A child that
made no edits, or that shared the parent checkout, records no reminder.

A close reminder rides the next real external user message on that parent
session:

- It is model-only context prepended to that turn. The user's text, transcript
  bytes, and `chat.history` are not rewritten, and no reminder appears as a
  separate chat message.
- The model is told to treat it as context only: do not merge, abandon, reopen,
  or start a run on its own. If the user's request depends on the pending work,
  it should mention what is pending and ask how to proceed.
- Cron jobs, heartbeats, subagent turns, internal events, and incognito turns
  never drain the reminder. The next message from the user's own client does.
- A retry of the same run reuses one claim, and a delivered reminder is not
  injected again in the same process. An interrupted dispatch is different:
  after a Gateway restart, an unconfirmed reminder can be delivered again
  instead of being lost.
- At most eight closed children share one reminder block; older entries are
  summarized as a count rather than dropped silently.

The parent composer shows a handoff chip with the pending count. **Cancel**
reopens the newest closed child and withdraws its reminder only while that
reminder is still undelivered. Reopening any child cancels only its pending,
undispatched reminder; once a turn has dispatched the reminder to the provider,
the prepended context cannot be recalled. Closing that child again records a new
reminder for the next user message.

There is no automatic review, merge, or follow-up run. The reminder exists only
to tell the model that closed side work may matter to the next request.

## Parent delete and archive

Side conversations are settled with their parent rather than orphaned:

- **Delete parent:** registered children are deleted first inside the parent's
  own lifecycle fence, including abandoned children and their checkouts. If a
  child is still active, the result is an explicit partial delete: earlier
  children are reported as deleted, the parent and every unprocessed child stay
  intact, and retrying after the child settles is safe.
- **Archive parent:** archive refuses while a child is active and asks you to
  close it first. After the parent archive commits, children are archived and
  their checkouts are snapshotted and removed. A child that becomes active after
  that check produces an explicit partial result: the parent and earlier
  children are archived, and the active child is named for a retry. Any checkout
  that could not be removed safely is reported with its branch and path.
- A hidden child never outlives a deleted parent as an unreachable row; once the
  parent is gone, no side-conversation method can resolve it again.

Cleaning up an abandoned child is an explicit delete or a parent cleanup; abandon
alone leaves it on disk.

## Control UI and channel BTW

The two side-question contracts are intentionally separate:

| Surface                                                             | Behavior                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control UI                                                          | `/btw`, `/side`, the Side chat rail, and the selection action create a persistent hidden child. It has its own transcript, worktree, and model, and settles through close, reopen, merge, or abandon. |
| Channels (Telegram, WhatsApp, Discord), TUI, embedded `tui --local` | `/btw` is a one-shot side question on the session's actual model. The answer is delivered as a detached side result and never enters session history.                                                 |

Channels cannot use side conversations because they have no Gateway RPC
connection. TUI stays on the ephemeral BTW path by design. See
[BTW side questions](/tools/btw) for the channel and TUI behavior.

## Gateway methods

| Method                      | Scope            | Purpose                                                          |
| --------------------------- | ---------------- | ---------------------------------------------------------------- |
| `sideConversations.create`  | `operator.write` | Create or reuse one hidden child from a parent and intent id.    |
| `sideConversations.list`    | `operator.read`  | List a parent's registered children and cleanup state.           |
| `sideConversations.close`   | `operator.write` | Quiesce and keep a child; records the next-message reminder.     |
| `sideConversations.reopen`  | `operator.write` | Restore a closed child and cancel its undelivered reminder.      |
| `sideConversations.merge`   | `operator.write` | Merge the child's committed branch into the parent checkout.     |
| `sideConversations.abandon` | `operator.write` | Drop the conversation and keep its branch and checkout.          |
| `sideConversations.delete`  | `operator.write` | Delete a settled child with snapshot-protected checkout cleanup. |

`create` takes a caller-owned `intentId`; retries with the same intent return
the same child instead of creating a duplicate. List results include each
child's state, model, snapshot facts, isolation facts, and worktree or skip
reason, so a client can render the same strip the Control UI shows.

## Failure recovery

| Symptom                                                                          | What to do                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent is still preparing its checkout                                           | Retry after the parent's first turn finishes.                                                                                                                                           |
| Parent workspace has no commits                                                  | Make an initial commit in the workspace, then retry.                                                                                                                                    |
| Snapshot is too large                                                            | Reduce the parent history or start from a new parent session; the snapshot is never truncated.                                                                                          |
| Close reports the child is active                                                | Wait for its run to settle, then retry close.                                                                                                                                           |
| Close reports the state was saved but the reminder was not                       | Retry close; it repairs the reminder without changing the transcript or checkout.                                                                                                       |
| Reopen reports the checkout could not be restored                                | Restore the repository checkout, or start a new side conversation; the child stays closed.                                                                                              |
| Merge reports a dirty parent, dirty child, detached parent, or merge in progress | Commit, stash, check out a branch, or finish the other merge, then retry. Nothing was merged.                                                                                           |
| Merge reports a conflict                                                         | Resolve the listed paths in a normal Git flow, commit the child work, and retry.                                                                                                        |
| Merge reports it landed but state was not recorded                               | Retry merge to record the landing commit; the branch is not merged twice.                                                                                                               |
| Abandon reports the branch already merged                                        | Retry merge to record it; that finishes the lifecycle as merged. A merged child cannot be abandoned.                                                                                    |
| Delete reports active work or cleanup pending                                    | Retry after the run settles. A deleted child reports leftover cleanup in the parent's list; preserved checkouts name their branch and path.                                             |
| Parent delete or archive reports a partial result                                | Settle the named child, then retry the parent action. A delete keeps the parent and unprocessed children intact; an archive may already have committed the parent and earlier children. |

## Related

<CardGroup cols={2}>
  <Card title="BTW side questions" href="/tools/btw" icon="comments">
    Detached side questions on channels and the TUI; the Control UI opens a side conversation.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Command routing and `/btw` aliases by surface.
  </Card>
  <Card title="Managed worktrees" href="/concepts/managed-worktrees" icon="git-branch">
    Worktree storage, snapshots, merge, and cleanup.
  </Card>
  <Card title="Session management" href="/concepts/session" icon="comments">
    Session keys, history, and persistence semantics.
  </Card>
</CardGroup>
