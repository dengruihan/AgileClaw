import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { CHUTES_DEFAULT_MODEL_REF, applyChutesApiKeyConfig } from "./onboard.js";
import { buildChutesProvider, buildStaticChutesProvider } from "./provider-catalog.js";

const PROVIDER_ID = "chutes";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Chutes Provider",
  description: "Bundled Chutes.ai provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Chutes",
      docsPath: "/providers/chutes",
      envVars: ["CHUTES_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Chutes API key",
          hint: "Open-source models including Llama, DeepSeek, and more",
          optionKey: "chutesApiKey",
          flagName: "--chutes-api-key",
          envVar: "CHUTES_API_KEY",
          promptMessage: "Enter Chutes API key",
          noteTitle: "Chutes",
          noteMessage: [
            "Chutes provides access to leading open-source models including Llama, DeepSeek, and more.",
            "Get your API key at: https://chutes.ai/settings/api-keys",
          ].join("\n"),
          defaultModel: CHUTES_DEFAULT_MODEL_REF,
          expectedProviders: ["chutes"],
          applyConfig: applyChutesApiKeyConfig,
          wizard: {
            choiceId: "chutes-api-key",
            choiceLabel: "Chutes API key",
            groupId: "chutes",
            groupLabel: "Chutes",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "profile",
        run: async (ctx) => {
          const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return await runLiveProviderCatalog({
            providerId: PROVIDER_ID,
            profileId: discoveryApiKey ? profileId : undefined,
            run: async () => ({
              provider: {
                ...(await buildChutesProvider(discoveryApiKey, { discoveryMode: "strict" })),
                apiKey,
              },
            }),
          });
        },
      },
      staticCatalog: {
        order: "profile",
        run: async () => ({
          provider: buildStaticChutesProvider(),
        }),
      },
    });
  },
});
