# OpenClaw Radius Provider

Connect OpenClaw to Earendil's Radius gateway with an organization API key. The plugin discovers account-visible models and supports
native Pi message streaming, reasoning, images on supported models, and tool calls.

```bash
openclaw plugins install @openclaw/radius-provider
openclaw models auth paste-api-key --provider radius
openclaw models list --provider radius --refresh
```

`RADIUS_API_KEY` can supply the key from the environment.
Requests use the selected organization's credits and policies.

See [Radius setup and configuration](https://docs.openclaw.ai/providers/radius).
