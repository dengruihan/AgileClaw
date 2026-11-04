---
summary: "One rolling conversation across all your channels: the personal-agent default"
read_when:
  - You want to understand where your agent "lives"
  - You expect the same context whether you write on Telegram, WhatsApp, or the web
  - You want your agent to know what happens in groups and side threads
title: "The main session"
---

OpenClaw is a personal agent first. Out of the box, every direct message you
send it — from Telegram, WhatsApp, iMessage, Slack DMs, the web app, anywhere —
lands in **one rolling conversation**: the main session. Ask something on your
phone, follow up from your laptop, and the agent has the same context in both
places. There is one brain, and this is where it thinks.

Under the hood the main session is an ordinary session with the canonical key
`agent:<agentId>:main` (for example `agent:main:main`). The suffix is fixed;
custom `session.mainKey` values are ignored. What makes it special
is that the default DM scope collapses all direct messages into it, and that
the rest of the system treats it as the agent's root: heartbeats wake it,
background work reports back to it, and activity elsewhere flows up to it.

## The web app

Opening the Control UI starts a new, unsent draft. Nothing is stored until you
send the first message, so a reload restores the same draft instead of creating
an empty session. Explicit session links still open that session directly.

There is no separate Home page or main-session type in the web app. The rolling
main session appears in the sidebar as one ordinary session row alongside every
other conversation: you can rename it, move it into a custom group, pin it, or
open it like any session. Group chats and coding sessions use the same rows and
the same custom groups; assigning a group to a session replaces its automatic
zone. Empty system-owned anchors stay hidden by the normal system-row rule,
while an anchor with real direct-message history stays reachable as a row.

The Gateway keeps the internal routing anchor for direct messages, heartbeats,
cron targets, and background work, so channel behavior and history do not
change. That anchor is an implementation detail, not a user-facing category.

Conversation docks are still available for plugin pages and explicit sessions;
the sidebar no longer offers a built-in Home conversation.

## What flows into the main session

The main session is not just a chat log; it is the place where your agent's
world converges:

- **New sessions.** By default, creating a session queues a system notice in its
  agent's main session with the session key and available title, creator,
  and creation source. The agent sees it on its next turn or scheduled heartbeat;
  creation does not trigger an extra wake-up. Set `session.notifyOnCreate: false`
  to opt out. The main session, drafts, incognito sessions, hidden internal sessions,
  and scheduled cron runs are excluded. Resetting or reopening an existing
  session does not send another creation notice. These notices use the bounded,
  in-memory system-event queue and do not subscribe the main session to future activity.
- **Group activity.** Under `session.groupScope: "per-group"` (the default),
  group and room sessions stay isolated while the main session automatically watches them.
  Activity queues up as compact notices — coalesced per conversation, never
  one wake-up per message — and the agent sees them the next time it runs: on
  your next message or on a scheduled heartbeat. Under `tools.sessions.visibility: "all"`
  (the default), the main session can use [session tools](/concepts/session-tool) across the Gateway,
  with cross-agent access governed by `tools.agentToAgent` and on by default;
  its system prompt names watched groups so it knows where recent activity happened.
- **Background work.** Sub-agents and spawned sessions announce their results
  back to the session that started them, so work the agent kicked off from
  the main session reports back to the main session.
- **Heartbeats.** Scheduled heartbeats target the main session, which is what
  turns queued notices into awareness even when you have not written anything.

## Memory across resets and conversations

The rolling conversation is bounded by the model's context window, so
continuity comes from layers around it:

- `MEMORY.md`, the agent's curated long-term memory, is loaded into every
  fresh session. Daily notes (`memory/YYYY-MM-DD.md`) are searchable on demand
  and recent ones are re-primed after a `/new` or `/reset`. Before compaction,
  the agent flushes durable facts into the daily notes so long conversations
  do not silently lose them.
- **Memory recall across conversations** lets the agent recall content from
  its other private sessions. On personal setups — global
  `session.dmScope` resolving to `main` with no per-binding DM overrides — it
  is enabled by default; any configured DM isolation turns it off unless you
  opt in explicitly. See [Memory configuration](/reference/memory-config).

## A rolling session with durable history

The main session rolls forward through resets and compaction rather than
making the model carry its entire history at once:

- By default there is no automatic reset; compaction keeps the active context
  bounded while preserving the rolling session. Daily and idle resets are
  opt-in (see [Session management](/concepts/session)). On `/new` and `/reset`,
  the tail of the ending conversation is saved to daily memory notes, and the
  next session re-primes recent notes. Reset assigns a new live session id but
  keeps the previous SQLite transcript searchable under the same main-session
  key.
- When the conversation approaches the context window, compaction summarizes
  and continues in place — the transcript history stays in the session store.
- Session lists show the current live conversation, not every historical
  session id behind it.
- When the per-agent store's physical database, WAL, and session artifacts
  exceed the disk budget (`session.maintenance.maxDiskBytes`, default `10gb` —
  see [Session maintenance](/reference/session-management-compaction/maintenance)),
  OpenClaw extracts the oldest unreferenced history to a verified compressed
  archive before removing its database rows. Live, routed, and in-flight
  sessions are never budget victims.

## When you want isolation instead

The shared main session is the right default for an agent that only you talk
to. If several people can message your agent, isolate DMs:

```json5
{
  session: {
    dmScope: "per-channel-peer",
  },
}
```

With an isolating scope, each sender gets their own session and
cross-conversation memory recall defaults off. Group watching remains controlled
independently by `session.groupScope`: `per-group` keeps ambient main-session
visibility, while `main` puts the room in the main conversation directly.
`openclaw security audit` recommends DM isolation when it detects multiple
senders. The full scope matrix, identity linking, and per-route overrides are
covered in [Session management](/concepts/session) and [Channel routing](/channels/channel-routing).

Groups and rooms use separate sessions by default. To make selected trusted
team rooms part of the rolling main conversation, set
`bindings[].session.groupScope: "main"` on their route bindings. This changes
the session key and shared context; mention gating and reply routing still use
the originating room. See [Session management](/concepts/session#group-and-room-routing).

## Related

- [Session management](/concepts/session) — routing, scopes, resets
- [Channel routing](/channels/channel-routing) — how agents and sessions are selected
- [Memory](/concepts/memory) — durable memory layers
- [Multi-agent](/concepts/multi-agent) — running several isolated agents
- [Session management deep dive](/reference/session-management-compaction) — the disk budget, archival, and compaction keys
