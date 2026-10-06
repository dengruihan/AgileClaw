import type {
  OpenClawPluginApi,
  OpenClawConfig,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMiniMaxModernModelId,
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_TEXT_MODEL_ORDER,
} from "./api.js";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import {
  buildMinimaxModelDiscovery,
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
  resolveMinimaxCatalogBaseUrl,
} from "./provider-catalog.js";
import {
  createMinimaxPortalProvider,
  createMinimaxProvider,
  minimaxAuthMethodMetadata,
} from "./provider-contract-api.js";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
type MiniMaxRegion = "cn" | "global";
const MINIMAX_USAGE_ENV_VAR_KEYS = [
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_API_KEY",
] as const;
const MINIMAX_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "hybrid-anthropic-openai",
    anthropicModelDropThinkingBlocks: true,
  }),
  ...buildProviderStreamFamilyHooks("minimax-fast-mode"),
  resolveReasoningOutputMode: () => "native" as const,
  resolveThinkingProfile: ({ modelId }: { modelId: string }) =>
    resolveMinimaxThinkingProfile(modelId),
};

function getProviderBaseUrl(cfg: OpenClawConfig, providerId: string): string | undefined {
  return normalizeOptionalString(cfg.models?.providers?.[providerId]?.baseUrl);
}

function resolveMinimaxUsageBaseUrl(cfg: OpenClawConfig): string | undefined {
  return getProviderBaseUrl(cfg, PORTAL_PROVIDER_ID) ?? getProviderBaseUrl(cfg, API_PROVIDER_ID);
}

function resolveMinimaxDynamicModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const normalizedModelId = params.ctx.modelId.trim().toLowerCase();
  const catalogModelId = MINIMAX_TEXT_MODEL_ORDER.find(
    (id) => id.toLowerCase() === normalizedModelId,
  );
  if (!catalogModelId) {
    return undefined;
  }
  return normalizeModelCompat({
    ...buildMinimaxApiModelDefinition(catalogModelId),
    provider: params.providerId,
    api: "anthropic-messages",
    baseUrl:
      normalizeOptionalString(params.ctx.providerConfig?.baseUrl) ?? resolveMinimaxCatalogBaseUrl(),
  });
}

async function resolveApiCatalog(ctx: ProviderCatalogContext) {
  const auth = ctx.resolveProviderApiKey(API_PROVIDER_ID);
  if (!auth.apiKey) {
    return null;
  }
  const defaults = buildMinimaxProvider(ctx.env);
  const providerConfig = {
    ...defaults,
    baseUrl: getProviderBaseUrl(ctx.config, API_PROVIDER_ID) ?? defaults.baseUrl,
    api: ctx.config.models?.providers?.[API_PROVIDER_ID]?.api ?? defaults.api,
  };
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: API_PROVIDER_ID,
    providerConfig,
    apiKey: auth.apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
    modelDiscovery: buildMinimaxModelDiscovery(providerConfig),
  });
}

async function resolvePortalCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
  const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
  const auth = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID);
  const explicitApiKey = normalizeOptionalString(explicitProvider?.apiKey);
  const apiKey = auth.apiKey ?? explicitApiKey;
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl);

  const providerConfig = {
    ...buildMinimaxPortalProvider(),
    baseUrl: explicitBaseUrl || buildMinimaxPortalProvider(ctx.env).baseUrl,
    apiKey,
  };
  return await buildOpenAICompatibleLiveProviderCatalog({
    discoveryMode: "strict",
    providerId: PORTAL_PROVIDER_ID,
    providerConfig,
    apiKey,
    discoveryApiKey: auth.discoveryApiKey,
    profileId: auth.profileId,
    modelDiscovery: buildMinimaxModelDiscovery(providerConfig, "api_key"),
  });
}

function createMinimaxApiKeyMethod(region: MiniMaxRegion) {
  const metadata = minimaxAuthMethodMetadata(region);
  const isCn = region === "cn";
  return createProviderApiKeyAuthMethod({
    providerId: API_PROVIDER_ID,
    methodId: metadata.id,
    label: metadata.label,
    hint: metadata.hint,
    optionKey: "minimaxApiKey",
    flagName: "--minimax-api-key",
    envVar: "MINIMAX_API_KEY",
    promptMessage: isCn
      ? "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key"
      : "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
    profileId: isCn ? "minimax:cn" : "minimax:global",
    allowProfile: false,
    defaultModel: `${API_PROVIDER_ID}/${MINIMAX_DEFAULT_MODEL_ID}`,
    expectedProviders: isCn ? ["minimax", "minimax-cn"] : ["minimax"],
    applyConfig: (cfg) => (isCn ? applyMinimaxApiConfigCn(cfg) : applyMinimaxApiConfig(cfg)),
    wizard: metadata.wizard,
  });
}

function buildMinimaxApiProviderPlugin(): ProviderPlugin {
  return {
    ...createMinimaxProvider(),
    auth: [createMinimaxApiKeyMethod("global"), createMinimaxApiKeyMethod("cn")],
    catalog: {
      order: "simple",
      run: resolveApiCatalog,
    },
    staticCatalog: {
      order: "simple",
      run: async (ctx) => ({ providers: { [API_PROVIDER_ID]: buildMinimaxProvider(ctx.env) } }),
    },
    resolveUsageAuth: async (ctx) => {
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
        envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name]),
      });
      return apiKey ? { token: apiKey } : null;
    },
    ...MINIMAX_PROVIDER_HOOKS,
    resolveDynamicModel: (ctx) => resolveMinimaxDynamicModel({ providerId: API_PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
    fetchUsageSnapshot: async (ctx) =>
      await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn, {
        baseUrl: resolveMinimaxUsageBaseUrl(ctx.config),
      }),
  };
}

function buildMinimaxPortalProviderPlugin(): ProviderPlugin {
  return {
    ...createMinimaxPortalProvider(),
    catalog: {
      run: resolvePortalCatalog,
    },
    staticCatalog: {
      run: async (ctx) => ({
        providers: { [PORTAL_PROVIDER_ID]: buildMinimaxPortalProvider(ctx.env) },
      }),
    },
    auth: [],
    ...MINIMAX_PROVIDER_HOOKS,
    resolveDynamicModel: (ctx) =>
      resolveMinimaxDynamicModel({ providerId: PORTAL_PROVIDER_ID, ctx }),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
  };
}

export function registerMinimaxProviders(api: OpenClawPluginApi) {
  api.registerProvider(buildMinimaxApiProviderPlugin());
  api.registerProvider(buildMinimaxPortalProviderPlugin());
}
