import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_API_KEY_LABEL = "OpenAI API Key";
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "OpenAI API key",
} as const;
const CODEX_API_KEY_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai:api-key",
  credentialKind: "api_key",
} as const;

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        run: noopAuth,
        credentialImport: CODEX_API_KEY_IMPORT,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          onboardingFeatured: true,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      },
    ],
  };
}
