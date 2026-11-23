---
summary: "Ephemeral side questions with /btw"
read_when:
  - You want to ask a quick side question about the current session
  - You are implementing or debugging BTW behavior across clients
title: "BTW side questions"
---

`/btw` (alias `/side`) asks a quick side question about the **current
session** without adding it to that session's conversation history. It is
modeled after Claude Code's `/btw`, adapted to OpenClaw's Gateway and
multi-channel architecture.

The two side-question contracts are deliberately separate. BTW is a one-shot question on the session's actual model, preserving harness behavior and Codex thread-fork continuity for channel ingress (WhatsApp, Telegram, and Discord), the TUI, and embedded `tui --local`; the TUI stays on BTW by design. In the Control UI, `/btw` and `/side` open a persistent Side chat child session instead: it has its own transcript, model selection, and worktree, survives a reload, and settles through close, reopen, merge, or abandon. Channels cannot use Side chat because they do not have an RPC connection. See [Side conversations](/concepts/side-conversations) for that contract.

```text
/btw what changed?
/side what does this error mean?
```

## What the detached BTW path does

1. Snapshots the current session as background context (including any
   in-flight main-run prompt).
2. Runs a separate, one-shot side query telling the model to answer only the
   side question and not resume or steer the main task.
3. Delivers the answer as a live side result, not a normal assistant message.
4. Never writes the question or answer to the asking session's history or
   `chat.history`.

The main run, if one is active, is left untouched.

Images attached to the `/btw` message are sent with the side question on
direct-provider runtimes and on the Codex harness. This includes a photo with a
`/btw` caption, or media from the replied-to message when the channel supplies
it as reply context. Other harnesses receive the images as an optional input
and may ignore them. CLI runtimes receive a text note with the number of
omitted images instead. An image that media understanding already described is
not attached, because its description lives in the main conversation prompt,
not in the side question.

When their runtime supplies usage, completed direct-provider and harness side
questions report it through the configured [diagnostics pipeline](/gateway/opentelemetry).
This does not add the exchange to session history or session-derived `/usage cost` totals.

For Codex harness sessions, BTW forks the active Codex app-server thread into
an ephemeral child thread instead of running a separate provider call. This
keeps Codex OAuth and native tool/thread behavior intact, and the forked
thread keeps the parent thread's current approval policy, sandbox, and native
tool surface. The forked thread gets a boundary prompt telling the model that
everything before it is inherited reference context, not active instructions,
and that only messages after the boundary are live. `/btw` requires an
existing Codex thread; send a normal message first.

Eligible Codex side questions can use the same OpenClaw Gateway shell tools as
the main thread. Canceling a side question or reaching its timeout stops native
background terminals owned by the side thread before releasing it. Main-thread
terminals and OpenClaw-managed background jobs keep their existing lifetime.

For CLI runtime aliases, BTW invokes the owning CLI backend in one-shot
side-question mode: it seeds sanitized conversation context into a fresh CLI
invocation with tool bundling and reusable session state disabled, and adds
any no-resume/no-tools flags the backend supports. Direct (non-CLI) runtimes
use a direct one-shot provider call instead.

## What it does not do

`/btw` does not continue the unfinished main task. On channels and the TUI,
detached BTW results do not survive a reload and are not written to the main
transcript. In the Control UI, `/btw` and `/side` do not use the detached path:
they create a persistent hidden child session, and the question and answer live
in that child's own transcript. The child survives a reload, and close, merge,
or abandon keeps it until you delete it; its work is never written back to the
parent transcript. See [Side conversations](/concepts/side-conversations).

## Delivery model

Normal assistant chat uses the Gateway `chat` event. Detached BTW uses a
separate `chat.side_result` event so clients cannot mistake it for regular
conversation history. The Control UI does not consume that event; it creates a
hidden child through `sideConversations.*`, sends the first question with
`chat.send`, and renders the child's own transcript in the child pane.

## Surface behavior

| Surface           | Behavior                                                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI               | Rendered inline in the chat log, visibly distinct from a normal reply, dismissible with `Enter` or `Esc`.                                                                                                                                                      |
| External channels | Delivered as a clearly labeled one-off reply (Telegram, WhatsApp, Discord have no local ephemeral overlay).                                                                                                                                                    |
| Control UI / web  | Creates a persistent hidden child and opens it in a split pane. An empty command only opens the child composer. Closing keeps the child and, when it has changes, records a one-time reminder for the parent's next user message; merge or abandon settles it. |

## Selection popup (Control UI)

Highlighting text inside a chat message in the Control UI opens a small
selection popup with one action:

- **Ask in side chat** opens a new child pane with the quoted selection staged
  as an editable draft so you can type your question about the selection.

The action creates a normal side conversation: the question and answer belong
to the child, the parent transcript and main run are left untouched, and the
staged selection and comment are temporary input for that first question. See
[Side conversations](/concepts/side-conversations).

## When to use it

Use `/btw` for a quick clarification, a factual side answer while a long run
is still in progress, or a temporary answer that should not enter future
session context.

```text
/btw what file are we editing?
/btw summarize the current task in one sentence
/btw what is 17 * 19?
```

For anything you want to become part of the session's future working
context, ask normally in the main session instead.

## Related

<CardGroup cols={2}>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Native command catalog and chat directives.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the side-question model call.
  </Card>
  <Card title="Session" href="/concepts/session" icon="comments">
    Session keys, history, and persistence semantics.
  </Card>
  <Card title="Steer command" href="/tools/steer" icon="arrow-right">
    Inject a steering message into the active run without ending it.
  </Card>
</CardGroup>
