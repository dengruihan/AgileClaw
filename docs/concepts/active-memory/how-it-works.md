---
summary: "The escalation flow, which surfaces run active memory, the two targeting paths, and the session types the advanced path allows."
read_when:
  - You want to understand the deep-recall flow
  - You are checking whether a conversation is eligible
title: "How active memory works"
---

## How it works

```mermaid
flowchart LR
  U["User Message"] --> D["Deterministic Trigger Recall"]
  D -->|strong trusted match| I["Inject Bounded Hidden Context"]
  D -->|weak or empty| H["Check Recall Intent"]
  H -->|no| O["Inject Bounded Recall Outcome"]
  H -->|yes| R["Active Memory Deep Recall Sub-Agent"]
  R -->|NONE| M
  R -->|unavailable| O
  R -->|relevant summary| I
  O --> M["Main Reply"]
  I --> M
```

The deep-recall sub-agent can call only the configured memory recall tools (see
[Memory tools](/concepts/active-memory/memory-tools#memory-tools)). If the connection between the query and
available memory is weak, it returns `NONE` and the main reply proceeds without
extra context. Intentional no-intent skips and unavailable recall add only a
fixed, bounded outcome note.

Active memory is a conversational enrichment feature, not a platform-wide
inference feature:

| Surface                                                             | Runs active memory?                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| Control UI / web chat persistent sessions                           | Yes, when either activation path targets the agent       |
| Other interactive channel sessions on the same persistent chat path | Yes, when either activation path allows the conversation |
| Headless one-shot runs                                              | No                                                       |
| Heartbeat/background runs                                           | No                                                       |
| Generic internal `agent-command` paths                              | No                                                       |
| Sub-agent/internal helper execution                                 | No                                                       |

Inter-session messages and child completion deliveries do not run Active
Memory, even when they arrive in a visible conversation. OpenClaw uses their
typed delivery origin to skip recall. Later human messages in that same
conversation remain eligible under the usual targeting and session rules.

Use it when the session is persistent and user-facing, the agent has
meaningful long-term memory to search, and continuity/personalization matter
more than raw prompt determinism: stable preferences, recurring habits,
long-term context that should surface naturally. It is a poor fit for
automation, internal workers, one-shot API tasks, or anywhere hidden
personalization would be surprising.

## When it runs

Active Memory has two targeting paths for the deep-recall lane:

1. **Remember across conversations** automatically targets agents whose
   effective `memory.search.rememberAcrossConversations` setting is enabled, but
   only for private direct or persistent explicit UI conversations.
2. **Advanced Active Memory** targets agent IDs listed in
   `plugins.entries.active-memory.config.agents` and applies the plugin's chat
   type and chat ID controls.

Both paths require the plugin to be enabled and an eligible interactive
persistent conversation. A session-scoped `/active-memory off` pauses both
paths for that conversation. If any condition fails, active memory does not run
for that turn, and the main reply is unaffected.

`config.mode` controls when a targeted turn starts the blocking sub-agent:

| Mode       | Behavior                                                                |
| ---------- | ----------------------------------------------------------------------- |
| `escalate` | Default. Run only for recall intent when lane 1 has no strong hit.      |
| `always`   | Preserve the previous behavior and run on every eligible targeted turn. |
| `off`      | Disable deep recall without unloading the plugin.                       |

The deterministic trusted-trigger lane remains available in `off` mode.
`rememberAcrossConversations` is unchanged: it still controls whether deep
recall may search other private conversations.

### Parallel execution (experimental)

`config.execution` selects how recall runs:

| Execution  | Behavior                                                            |
| ---------- | ------------------------------------------------------------------- |
| `blocking` | Default. The recall lanes above run before the reply starts.        |
| `parallel` | A background sidecar extracts queries while the main agent answers. |

With `execution: "parallel"`, eligible ordinary turns do not wait for the
deterministic or deep-recall lanes. A small extractor model (configured via
`parallel.extractorModel`, otherwise the required utility model) builds bounded
search queries from the current request and the answer text so far, the
selected memory provider runs its existing search, and eligible hits are added
to the model's context at the next model call as a hidden
`openclaw.background-context` message. If the main agent is about to finish
while new material is still unconsumed, the turn gets one bounded same-turn
continuation (at most one per user input, `parallel.terminalWaitMs` extra wait,
default 2000 ms) so late memory can still produce a correction or addition.
Already-visible answer text is never retracted.

Parallel recall needs the built-in runtime's authorized prompt-build phase and
an admitted read contract for the selected memory backend: a native provider
declares its recall tools, a legacy backend (the default) uses its deterministic
recall tool — both are checked against the turn's tool policy before the
sidecar starts, and both search through the same neutral provider facade.
Each memory is queued as its own whole block and admitted against the model's
context budget at the real model-call boundary. When headroom runs out, the
host keeps the entries that fit and drops the rest without truncating history.
Each accepted block carries a delivery receipt that
distinguishes queued, leased, installed, submitted, dropped, and uncertain
provider dispatches. Persisted blocks enter replay only with a submission
receipt; revoked or uncertain material stays available as transcript evidence
without entering later model requests. Each input has a 50,000 token ceiling for
new material, including wrapping and the continuation instruction; this ceiling
does not increase the model's context window or the sidecar's existing hit and
excerpt limits. Nonempty runs log accepted, submitted, and dropped contribution
counts plus drop reasons without logging memory text. When a new user input is
admitted mid-run (steering), the previous input's sidecar stops and the new
input gets its own sidecar and budgets along its preparation boundary.
Turns that need protected Remember-across-conversations recall or run on
unsupported harnesses keep the whole-turn blocking path, with the reason
recorded in the log. A missing extractor model skips parallel recall and records
the reason while the foreground reply continues. In parallel mode the
`escalate` recall-intent gate does not apply to the sidecar (ordinary eligible
turns extract too); `mode: "off"` disables the sidecar as well.

### Session types

`config.allowedChatTypes` controls which kinds of conversations may run the
advanced Active Memory path. It cannot widen Remember across conversations:
that product setting remains private-only even when advanced Active Memory is
allowed in groups or channels. Default:

```json5
allowedChatTypes: ["direct"]
```

Valid values: `direct`, `group`, `channel`, `explicit` (portal-style sessions
with an opaque session id, for example `agent:main:explicit:portal-123`).
Direct-message sessions run by default; group, channel, and explicit sessions
need to be opted in:

```json5
allowedChatTypes: ["direct", "group"]
allowedChatTypes: ["direct", "group", "channel"]
```

For narrower rollout inside an allowed chat type, add
`config.allowedChatIds` and `config.deniedChatIds`:

- `allowedChatIds` is an allowlist of resolved conversation ids. When
  non-empty, active memory only runs for sessions whose conversation id is in
  the list — this narrows **every** allowed chat type at once, including
  direct messages. To keep all direct messages while narrowing only groups,
  add the direct peer ids to `allowedChatIds` too, or keep `allowedChatTypes`
  scoped to the group/channel rollout you are testing.
- `deniedChatIds` is a denylist that always wins over `allowedChatTypes` and
  `allowedChatIds`.

Ids come from the persistent channel session key (for example Feishu
`chat_id`/`open_id`, Telegram chat id, Slack channel id). Matching is
case-insensitive. If `allowedChatIds` is non-empty and OpenClaw cannot
resolve a conversation id for the session, active memory skips the turn
instead of guessing.

```json5
allowedChatTypes: ["direct", "group"],
allowedChatIds: ["ou_operator_open_id", "oc_small_ops_group"],
deniedChatIds: ["oc_large_public_group"]
```
