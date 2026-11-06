---
summary: "Allowlist node commands, point exec at a node, and invoke commands directly"
read_when:
  - Routing exec tool calls to a paired node
  - Allowlisting node commands or binding exec to one node
  - Invoking a node command over raw RPC
title: "Run commands on a node"
sidebarTitle: "Node exec"
---

## Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host in
`~/.openclaw/state/openclaw.sqlite#exec_approvals_config`.

## Point exec at the node

Configure defaults (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.mode allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Or per session:

```text
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the node allowlist/approvals).

`host=auto` will not implicitly choose the node on its own. An explicit per-call `host=node` request is allowed from `auto` only when no sandbox runtime is active; while a sandbox runtime is active, `auto` rejects it. To run on a node from a sandboxed session, or to make node exec the session default, set `tools.exec.host=node` or `/exec host=node ...` explicitly.

Related:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Channel and subagent context

Nodes advertising `system.run.execution-context.v1` receive optional
`executionContext` on both `system.run.prepare` and `system.run`. Its only fields
are `senderId`, `chatId` (nonempty strings), and `subagent` (`true` when present).
The node injects `OPENCLAW_CHANNEL_CONTEXT` with the sender/chat identity JSON and
`OPENCLAW_SUBAGENT_EXEC=1` into the child environment. These routing hints do not
grant session, turn, or command approval authority, and do not modify approved argv.
When context is present, it replaces both routing markers, including inherited
values. Omitted fields do not retain a previous channel or subagent hint. Requests
without typed context keep their existing environment behavior.

Custom `env` overrides still follow the node's existing restrictions. Supporting
this context does not enable arbitrary environment overrides on Windows companion
nodes that reject them. A node must support the context through its preparation,
approval, and launch paths before advertising the capability.

Update both the Gateway and node to use this transport, and approve an updated
node capability surface in **Devices** if requested after reconnecting. Older Gateways keep sending
the markers through `env`; newer Gateways do the same for nodes without the
capability. That compatibility path preserves existing behavior, including
`custom-env-not-supported` on older Windows companions. The Gateway does not omit
markers to bypass that rejection. An unsupported context request is rejected
before dispatch; reconnecting a node without the capability does not silently
downgrade a prepared request. No protocol-version or configuration change is needed.

For `openclaw agent --local` connected to a remote Gateway, the CLI also checks the
Gateway's advertised capability. An older Gateway selects the existing `env`
transport even with an updated node. A Gateway downgrade after discovery rejects
the typed request before dispatch rather than dropping its context.

## Invoking commands

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.info --params '{}'
```

`nodes invoke` blocks `system.run` and `system.run.prepare`; those commands only run through the `exec` tool with `host=node` (see above). Higher-level helpers exist for the common "give the agent a MEDIA attachment" workflows (camera, screen, location: see [Node device commands](/nodes/device-commands)).

Long-running streaming node commands use additive `node.invoke.progress`
events. Each event carries the invoke ID, a zero-based sequence number, and a
bounded UTF-8 text chunk; the Gateway orders chunks before delivering them to
the caller. The existing `node.invoke.result` remains the single terminal
response. Streaming callers can set an inactivity deadline that starts with the
first progress event and resets after later progress while retaining the
invoke's separate hard timeout during approval and execution. Result, hard
timeout, inactivity timeout, and node disconnect all discard pending stream
state. Caller cancellation emits `node.invoke.cancel` with the published
`NodeInvokeCancelEvent` payload (`invokeId` and `nodeId`); the node host then
terminates the matching process tree. Existing request/response commands are unchanged.

## Session device occupancy

A session that uses a device as its executor holds an **occupancy lease**. The
node host is the sole authority for that lease: it decides who holds the device,
records the holder, and rejects every mismatched call. The Gateway only relays
results and surfaces the rejection text.

The holder is the root session (`sessionKey`, `sessionId`, optional `agentId`)
plus the run and turn IDs of the acquiring turn. Exactly one holder exists at a
time; the whole session tree routes through the root session identity.

The invoke envelope's `sessionKey` is authoritative. A command that names a
session in its parameters must match the envelope, and a session can only
acquire, renew, release, or revoke its own lease. Operator invokes carry no
envelope session identity. Because lease mutations change who controls the
device, the Gateway requires admin scope for them on the direct `node.invoke`
RPC; an agent session acquires its lease through Gateway device routing, not by
calling the command itself.

Node commands, all on the existing `node.invoke` channel:

| Command                | Params                                                                         | Success payload                        |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `occupancy.acquire.v1` | `sessionKey`, `sessionId`, `runId`, `leaseToken`, optional `agentId`, `turnId` | `holder`, `leaseToken`, `acquiredAtMs` |
| `occupancy.renew.v1`   | `sessionKey`, `leaseToken`                                                     | `holder` with `renewedAtMs`            |
| `occupancy.release.v1` | `sessionKey`, `leaseToken`                                                     | `released` (idempotent)                |
| `occupancy.status.v1`  | none                                                                           | `occupied`, optional `holder`          |
| `occupancy.revoke.v1`  | `sessionKey` and `leaseToken` for a session call; none for an operator call    | `revoked`, `holder`, `killedProcesses` |

Rejections carry a structured code:

- `DEVICE_OCCUPIED` names the current holder (`sessionKey`, `sessionId`, `agentId`, acquire time) so the rejected session can report who owns the device.
- `LEASE_TOKEN_MISMATCH` means the caller is the holder session but presented a stale token, usually because a newer turn re-acquired the lease.
- `DEVICE_UNOCCUPIED` means no session holds the lease.
- `INVALID_REQUEST` covers a claimed session that does not match the invoking session and a missing required identity.

Lease tokens never appear in `occupancy.status.v1`, in status events, or in the
node's durable occupancy row. The row under
`openclaw.sqlite#config_machine_state` (`nodeHost.occupancy.v1`) mirrors the
holder identity for diagnostics and is cleared on node boot. A session reading
`occupancy.status.v1` sees the holder identity only for its own lease; other
sessions learn only that the device is occupied, and an operator invoke sees the
full status.

### Per-call admission

While a lease is held, every execution command is admitted per call: the invoke
must carry the holder's `sessionKey` in the invoke's session field and the
current `leaseToken` inside its parameters. This covers `system.run`, `system.which`,
file and directory commands, browser proxy commands, and computer control. The
`occupancy.*` lifecycle commands and the operator approval commands
(`system.execApprovals.get` / `system.execApprovals.set`) do not require the
lease: approval policy governs the device, so the Gateway's approvals UI and CLI
stay usable while a session holds it.

Exec and file commands keep running in parallel. Interactive control commands
(`browser.proxy*`, `screen.snapshot`, `computer.act`, `worker.desktop.*`)
serialize through one FIFO gate, because they share one browser or desktop.

### Lease lifecycle

- **Turn start** acquires the lease automatically; a newer turn of the same root session re-acquires and invalidates the previous token.
- **Disconnect** tree-kills the holder's attached processes, waits for their process trees to be extinct, and clears occupancy.
- **Node exec is foreground.** A lease-tagged exec holds the lease until its whole process tree is extinct: a command that backgrounds a child (`sh -c 'sleep 30 &'`) has that child killed before the invoke settles. Detached spawn is not supported yet; the owner's detached-process bookkeeping is a tested extension path for a future detached command.
- **Revoke** force-clears occupancy and kills the holder's processes. A session-dispatched revoke names its session (envelope or parameters) and must present the current token; an operator invoke without session identity can force-clear a stuck lease.
- **Node restart** clears occupancy, because the holder's processes died with the previous node process.

## Use Device and tool routing

`use_device` is a Gateway tool that switches the session's **placement** scope.
It is the only model-facing way to move execution; the direct `node.invoke` RPC
cannot mutate occupancy because lease mutations are admin-only there.

| Surface                                                   | Where it runs                                  |
| --------------------------------------------------------- | ---------------------------------------------- |
| `use_device`, `sessions_*`, `portal`, other Gateway tools | Always the Gateway                             |
| `exec`, `process`                                         | Scoped device (exec) or the Gateway            |
| `read`, `write`, `edit`, `apply_patch`, `ls`              | Scoped device (file commands) or the Gateway   |
| `browser`, `computer`, `screen`                           | Gateway only today; a device-scoped call fails |

Scope rules:

- A session holds at most one device. Switches write `scopeDeviceId` on the
  session row; `use_device device="gateway"` clears it.
- Scope belongs to the session-tree root. Subagents share the root's device and
  present the root session identity on every device call; call `use_device` from
  the root session. A fork is a new root with its own switch and its own lease.
- The tool catalog never changes. Device-scoped tools keep their names and
  schemas; a tool with no device adapter fails per call instead of running on
  the Gateway.
- Scope changes apply to subsequent calls at the next step boundary. `use_device`
  must be the only placement-affecting call in its step.

Lease behavior:

- The Gateway validates the device first: it must be paired with the node role,
  enabled, connected, and advertising the executor surface (`system.run` plus the
  occupancy commands).
- A successful switch acquires the device's occupancy lease for the session-tree
  root and mirrors the grant. Every device call carries the root session key in
  the invoke envelope and the lease token in its command params, so the node can
  reject a call that does not belong to the holder.
- `DEVICE_OCCUPIED` fails the switch immediately and names the holder. Nothing
  queues, nothing falls back to the Gateway, and the session keeps its previous
  scope.
- The lease is per turn. A turn that used the device releases it when the turn
  ends; a failed release is recorded as a warning and never fails the turn,
  because a disconnected node clears its own occupancy.
- Stop, archive, and delete release the lease at the node too, so a stopped or
  removed session never keeps the device reserved for other sessions. Stop also
  cancels the session's scoped background processes.
- Disabling a device revokes its occupancy through the Gateway's operator
  invoke: the node tree-kills the holder's processes and clears occupancy, and
  the Gateway mirror is dropped even when the node is already gone. A node that
  reports `occupancy.status` as released clears the mirror as well; a stale
  mirror never proves the device is free.

Device exec is foreground: `background`, `yieldMs`, `pty`, and `elevated` are
rejected under device scope, and output is truncated at 32 KB with an explicit
marker. When the caller accepts streaming updates, device exec also forwards
live output chunks to the tool's progress callback over the bounded
`node.invoke.progress` channel (16 KB frames, a 32 KB forwarding budget, and a
rolling tail); the final result remains the single authoritative outcome, and
cancel or timeout still terminates the command's process tree. Device file
tools run under the file-transfer policy configured for that device
(`allowReadPaths` / `allowWritePaths`); exec runs under the device's own exec
approval policy. Device-scoped execution requires a Gateway-hosted session,
because the Gateway owns the lease.

Device `edit` and `apply_patch` reuse the Gateway's edit planning and patch
envelope parser over the device `file.stat`, `file.fetch`, and `file.write`
commands: the stat-resolved canonical path pins the write target, the content
hash proves integrity, and a post-write stat verifies the persisted size.
Whole-file edits are capped at the 16 MB device ceiling. The node command
surface has no delete or move, so `*** Delete File` and `*** Move to` hunks
fail per call with a pointer to the gateway-scoped alternative; patch paths
must be absolute device paths.

## Codex sessions on a node

A session host using the Codex runtime also needs the `codex` plugin installed and
enabled in the **node host's** OpenClaw configuration. `--session-host` alone does not
install or enable this plugin. On the node, install it if missing, then enable it:

```bash
openclaw plugins install @openclaw/codex
openclaw plugins enable codex
openclaw node restart
```

If you run `openclaw node run` in the foreground, stop and restart that process
instead. Approve the node's updated command surface after it reconnects. The Gateway
must also allow `codex.exec-server.stdio.v1` in `gateway.nodes.commands.allow` without
a matching deny entry. Codex execution keeps its separate placement approval; enabling
the plugin does not grant that approval.

`environments.list` with `runtimeId: "codex"` reports a `requiredNodeCommand` state and
an actionable `message` when the node does not advertise the command, awaits pairing
approval, or is blocked by Gateway policy. A missing node advertisement requires
installing and enabling the plugin on the node; changing the Gateway allowlist alone
cannot add it. See [Install plugins](/cli/plugins/install) for installation sources.

See [Codex paired-device placement](/plugins/codex-harness/placement#run-codex-on-a-paired-device).

## Exec node binding

With no node target set, `exec host=node` selects the sole paired, connected node that supports `system.run`. Other paired devices do not make the selection ambiguous. If multiple executable nodes are connected, choose a target per call or bind exec to a specific node; the active Canvas target does not select the exec host. A bound or explicit target that is offline or cannot execute commands is rejected rather than redirected to another node.

A binding sets the default node for `exec host=node` and can be overridden per agent.

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.entries
openclaw config set 'agents.entries.main.tools.exec.node' "node-id-or-name"
```

Unset the binding to use the sole eligible node, or choose a target per call when multiple eligible nodes are connected:

```bash
openclaw config unset tools.exec.node
openclaw config unset 'agents.entries.main.tools.exec.node'
```
