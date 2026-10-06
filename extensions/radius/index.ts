import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const loadCatalog = createLazyRuntimeModule(() => import("./catalog.js"));
const loadStream = createLazyRuntimeModule(() => import("./stream.js"));

function defaultModel(catalog: ModelProviderConfig): string {
  const model = catalog.models.find((entry) => entry.id === "balanced") ?? catalog.models[0];
  if (!model) {
    throw new Error("Radius returned no available models. Check your organization's model access.");
  }
  return `radius/${model.id}`;
}

export default defineSingleProviderPluginEntry({
  id: "radius",
  name: "Radius Provider",
  description: "Radius model gateway with organization-scoped authentication and native streaming",
  manifest,
  provider: {
    label: "Radius",
    docsPath: "/providers/radius",
    manifestAuth: {
      noteTitle: "Radius",
      noteMessage:
        "Create an organization API key at https://radius.earendil.com. Requests use that organization's credits and policies.",
      resolveDefaultModel: async ({ apiKey, signal }) =>
        defaultModel(await (await loadCatalog()).fetchRadiusCatalog(apiKey, signal)),
    },
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderAuth("radius");
        if (!discoveryApiKey) {
          return null;
        }
        return await runLiveProviderCatalog({
          providerId: "radius",
          profileId,
          run: async () => ({
            provider: {
              ...(await (await loadCatalog()).fetchRadiusCatalog(discoveryApiKey)),
              apiKey,
            },
          }),
        });
      },
    },
    prepareDynamicModel: async (ctx) => {
      const { resolveApiKeyForProvider } =
        await import("openclaw/plugin-sdk/provider-auth-runtime");
      const { apiKey } = await resolveApiKeyForProvider({
        provider: "radius",
        cfg: ctx.config,
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspaceDir,
        ...(ctx.authProfileId ? { profileId: ctx.authProfileId, lockedProfile: true } : {}),
      });
      if (!apiKey) {
        return undefined;
      }
      const catalog = await (await loadCatalog()).fetchRadiusCatalog(apiKey);
      const model = catalog.models.find((entry) => entry.id === ctx.modelId);
      return model
        ? {
            id: model.id,
            name: model.name,
            provider: "radius",
            api: "pi-messages",
            baseUrl: catalog.baseUrl,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            thinkingLevelMap: model.thinkingLevelMap,
          }
        : undefined;
    },
    createStreamFn:
      () =>
      async (...args) =>
        (await loadStream()).createRadiusStreamFn()(...args),
    buildReplayPolicy: () => ({
      sanitizeToolCallIds: false,
      preserveSignatures: true,
      appendOnlyRuntimeContext: true,
      dropThinkingBlocks: false,
      dropReasoningFromHistory: false,
    }),
  },
});
