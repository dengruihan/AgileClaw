# AgileClaw

**A self-hosted, multi-channel AI assistant platform.**

AgileClaw runs a single Gateway on your own hardware and meets you in the chat apps you already use: the web Control UI, native desktop and mobile apps, Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Matrix, Microsoft Teams, and more. It supports multiple model providers, plugins, skills, scheduling, and companion apps without a hosted service in the middle.

AgileClaw started from the [OpenClaw](https://github.com/openclaw/openclaw) codebase and is now maintained independently. It is not affiliated with or endorsed by OpenClaw or the OpenClaw Foundation. The `openclaw` CLI and package name are retained for compatibility with existing configs, installs, and integrations.

## Highlights

- **One Gateway, many surfaces** — browser Control UI, CLI/TUI, and native macOS, iOS, Android, and Linux apps.
- **Channels** — Discord, Telegram, Slack, WhatsApp, Signal, iMessage, Matrix, Microsoft Teams, and more through bundled extensions.
- **Any model** — Anthropic, OpenAI, Google, local providers, and OpenAI-compatible endpoints.
- **Extensible** — 170+ bundled extensions, skills, MCP tools, webhooks, and cron/heartbeat automations.
- **Local-first** — config, sessions, and memory live on your machine; there is no hosted service in the middle.
- **Operator-controlled security** — scoped tool approvals, secret storage, and explicit risky paths.

## Requirements

- Node.js **24.16+** or **26.1+** (Node 26 is recommended)
- pnpm **12.5.1** (declared in `package.json`)

## Quick start from source

```bash
pnpm install
pnpm build
pnpm openclaw onboard
pnpm openclaw gateway run
```

Open the Control UI at <http://127.0.0.1:18789/>. To reopen it later, run:

```bash
pnpm openclaw dashboard
```

The Gateway keeps running in the foreground until you press Ctrl+C. To install it as a background service on macOS, Linux, or Windows, run `pnpm openclaw gateway install`.

## Repository layout

- `src/` — Gateway, agents, channels, CLI, and core runtime
- `ui/` — web Control UI
- `apps/` — native apps for macOS, iOS, Android, and Linux, plus shared code
- `extensions/` — bundled channels, providers, tools, and plugins
- `packages/` — shared workspace packages and public SDKs
- `crates/` — Rust Gateway client and node host
- `skills/` — bundled product skills
- `custodian-skills/` — release-versioned operational playbooks
- `.agents/skills/` — repository maintenance skills for coding agents
- `docs/` — documentation source
- `scripts/` — build, test, release, and QA tooling

## Development

```bash
pnpm install
pnpm build
pnpm check
pnpm lint
```

Run the CLI through `pnpm openclaw ...` (or `pnpm dev`) so the repository toolchain resolves correctly.

For a targeted test run:

```bash
pnpm test <path/to/test.ts> --maxWorkers=1
```

The full suite is large; prefer focused tests while iterating. See `AGENTS.md` for agent instructions.

## Documentation

- Documentation index: `pnpm docs:list`
- Start here: `docs/start/getting-started.md`
- Channels: `docs/channels/`
- Control UI: `docs/web/control-ui.md`
- Configuration: `docs/gateway/configuration.md` and `docs/gateway/configuration-reference.md`

## License

Apache-2.0. See [`LICENSE`](LICENSE). Third-party components retain their original notices; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Star History

<a href="https://www.star-history.com/?repos=dengruihan%2FAgileClaw&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=dengruihan/AgileClaw&type=date&legend=top-left&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=dengruihan/AgileClaw&type=date&legend=top-left" />
    <img alt="Star History Chart for dengruihan/AgileClaw" src="https://api.star-history.com/svg?repos=dengruihan/AgileClaw&type=date&legend=top-left" />
  </picture>
</a>
