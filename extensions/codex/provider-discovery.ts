/** Native login facts belong to Codex, never to an OpenClaw bearer profile. */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const codexProviderDiscovery: ProviderPlugin = {
  id: "codex",
  label: "Codex",
  auth: [],
};

export default codexProviderDiscovery;
