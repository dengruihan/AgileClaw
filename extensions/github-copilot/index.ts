import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseGithubCopilotApiKey } from "./api-key.js";
import { resolveGithubCopilotDomain } from "./domain.js";
import { createGithubCopilotDynamicModelHooks } from "./dynamic-models.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { PROVIDER_ID } from "./models.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import {
  buildGithubCopilotReplayPolicy,
  sanitizeGithubCopilotReplayHistory,
} from "./replay-policy.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VAR = "COPILOT_GITHUB_TOKEN";
async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}

export default definePluginEntry({
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  register(api) {
    const dynamicModels = createGithubCopilotDynamicModelHooks();

    api.registerEmbeddingProvider(githubCopilotMemoryEmbeddingProviderAdapter);

    api.registerProvider({
      id: PROVIDER_ID,
      label: "GitHub Copilot",
      docsPath: "/providers/models",
      envVars: [COPILOT_ENV_VAR],
      auth: [],
      catalog: {
        order: "late",
        run: dynamicModels.runCatalog,
      },
      prepareDynamicModel: dynamicModels.prepareDynamicModel,
      resolveDynamicModel: dynamicModels.resolveDynamicModel,
      preferRuntimeResolvedModel: dynamicModels.preferRuntimeResolvedModel,
      wrapStreamFn: wrapCopilotProviderStream,
      buildReplayPolicy: buildGithubCopilotReplayPolicy,
      sanitizeReplayHistoryAsync: sanitizeGithubCopilotReplayHistory,
      resolveThinkingProfile,
      prepareRuntimeAuth: async (ctx) => {
        const source = parseGithubCopilotApiKey(ctx.apiKey);
        const { resolveCopilotRuntimeAuth } = await loadGithubCopilotRuntime();
        const auth = await resolveCopilotRuntimeAuth({
          githubToken: source.githubToken,
          env: ctx.env,
          githubDomain: resolveGithubCopilotDomain({
            env: ctx.env,
            config: ctx.config,
          }),
        });
        return {
          apiKey: auth.apiKey,
          baseUrl: auth.baseUrl,
          request: {
            headers: buildCopilotRuntimeHeaders({ config: ctx.config, headers: ctx.model.headers }),
          },
        };
      },
    });
  },
});
