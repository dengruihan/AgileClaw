# @openclaw/llama-cpp-provider

Provider plugin for connecting OpenClaw to an already-running llama-server over
its OpenAI-compatible HTTP API.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Configure the
server URL and optional API key, or use the provider setup flow to discover
models from a running endpoint. OpenClaw does not download models or manage the
server process.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for authentication, router behavior, manual configuration, and troubleshooting.

## Package

- Plugin id: `llama-cpp`
- Provider id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
