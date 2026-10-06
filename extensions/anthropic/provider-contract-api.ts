import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createAnthropicAuthMethods() {
  return {
    apiKey: {
      id: "api-key",
      kind: "api_key" as const,
      label: "Anthropic API key",
      hint: "Direct Anthropic API key",
      run: async () => ({ profiles: [] }),
      wizard: {
        choiceId: "apiKey",
        choiceLabel: "Anthropic API key",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        groupHint: "API key",
      },
    },
  };
}

export function createAnthropicProvider(): ProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic",
    docsPath: "/providers/models",
    envVars: ["ANTHROPIC_API_KEY"],
    auth: Object.values(createAnthropicAuthMethods()),
  };
}
