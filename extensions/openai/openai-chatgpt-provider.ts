import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildFirstTemplateModel,
  buildManifestModelProviderConfig,
  DEFAULT_CONTEXT_TOKENS,
  matchesExactOrPrefix,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import {
  OPENAI_CHATGPT_MODERN_MODEL_IDS,
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID as OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
  OPENAI_GPT_54_LEGACY_MODEL_ID as OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID as OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID as OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID as OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID as OPENAI_CODEX_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID as OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_VARIANT_MODEL_IDS as OPENAI_CODEX_GPT_56_MODEL_IDS,
  OPENAI_GPT_6_MODEL_IDS,
} from "./model-route-contract.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS } from "./shared.js";
import { fetchOpenAIUsage, resolveOpenAIUsageAuth } from "./usage.js";

const PROVIDER_ID = "openai";
const OPENAI_MANIFEST_MODELS = buildManifestModelProviderConfig({
  providerId: PROVIDER_ID,
  catalog: manifest.modelCatalog.providers.openai,
}).models;
const OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP = {
  off: null,
  xhigh: "xhigh",
  max: "max",
} as const;
const OPENAI_CODEX_GPT_56_NATIVE_CONTEXT_TOKENS = 372_000;
const OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS = 400_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_MINI_COST = {
  input: 0.75,
  output: 4.5,
  cacheRead: 0.075,
  cacheWrite: 0,
} as const;
const OPENAI_CODEX_FORWARD_COMPAT_PATCHES = new Map<string, Partial<ProviderRuntimeModel>>([
  [
    OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
    {
      contextWindow: 1_000_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  [
    OPENAI_CODEX_GPT_54_MODEL_ID,
    {
      contextWindow: 1_050_000,
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    },
  ],
  [
    OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
    {
      contextWindow: 1_050_000,
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  [
    OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
    {
      contextWindow: 400_000,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    },
  ],
  [
    OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
    {
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
    },
  ],
]);
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex"] as const;
/** Legacy codex rows first; fall back to catalog `gpt-5.4` when the API omits 5.3/5.2. */
const OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS = [
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
  OPENAI_CODEX_GPT_54_MODEL_ID,
] as const;
const OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
] as const;
const OPENAI_CODEX_IMAGE_CAPABLE_MODEL_IDS = [
  ...OPENAI_GPT_6_MODEL_IDS,
  ...OPENAI_CODEX_GPT_56_MODEL_IDS,
  OPENAI_CODEX_GPT_55_MODEL_ID,
  OPENAI_CODEX_GPT_55_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_PRO_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
] as const;

function isOpenAIProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === PROVIDER_ID;
}

function normalizeCodexTransportFields(params: {
  api?: ProviderRuntimeModel["api"] | null;
  baseUrl?: string;
}): {
  api?: ProviderRuntimeModel["api"];
  baseUrl?: string;
} {
  const useCodexTransport =
    !params.baseUrl || isOpenAIApiBaseUrl(params.baseUrl) || isOpenAICodexBaseUrl(params.baseUrl);
  const api =
    useCodexTransport &&
    (!params.api || params.api === "openai-responses" || params.api === "openai-completions")
      ? "openai-chatgpt-responses"
      : (params.api ?? undefined);
  const baseUrl =
    api === "openai-chatgpt-responses" && useCodexTransport
      ? OPENAI_CODEX_RESPONSES_BASE_URL
      : params.baseUrl;
  return { api, baseUrl };
}

function matchesOpenAICodexImageCapableModel(modelId: string, modelName?: string): boolean {
  return [modelId, modelName]
    .filter((value): value is string => typeof value === "string")
    .some((candidate) => matchesExactOrPrefix(candidate, OPENAI_CODEX_IMAGE_CAPABLE_MODEL_IDS));
}

// Older persisted rows can omit image input; restore it before chat.send chooses claim-check URIs.
function applyOpenAICodexImageInputCapability(params: {
  modelId: string;
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  if (Array.isArray(params.model.input) && params.model.input.includes("image")) {
    return undefined;
  }
  if (!matchesOpenAICodexImageCapableModel(params.modelId, params.model.name)) {
    return undefined;
  }
  return {
    ...params.model,
    input: ["text", "image"],
  };
}

function normalizeCodexTransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const lowerModelId = normalizeLowercaseStringOrEmpty(model.id);
  const canonicalModelId =
    lowerModelId === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : model.id;
  const canonicalName =
    normalizeLowercaseStringOrEmpty(model.name) === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID
      ? OPENAI_CODEX_GPT_54_MODEL_ID
      : model.name;
  const normalizedTransport = normalizeCodexTransportFields({
    api: model.api,
    baseUrl: model.baseUrl,
  });
  const api = normalizedTransport.api ?? model.api;
  const baseUrl = normalizedTransport.baseUrl ?? model.baseUrl;
  if (
    api === model.api &&
    baseUrl === model.baseUrl &&
    canonicalModelId === model.id &&
    canonicalName === model.name
  ) {
    return model;
  }
  return {
    ...model,
    id: canonicalModelId,
    name: canonicalName,
    api,
    baseUrl,
  };
}

function resolveCodexForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const synthBaseUrl = ctx.providerConfig?.baseUrl ?? OPENAI_CODEX_RESPONSES_BASE_URL;

  if (OPENAI_GPT_6_MODEL_IDS.some((modelId) => modelId === lower)) {
    // Discovery owns account-specific limits; the manifest supplies offline metadata.
    const catalogModel = OPENAI_MANIFEST_MODELS.find((model) => model.id === lower);
    if (!catalogModel || catalogModel.contextWindow === undefined) {
      return undefined;
    }
    return {
      ...catalogModel,
      contextWindow: catalogModel.contextWindow,
      input: catalogModel.input.filter(
        (item): item is "text" | "image" => item === "text" || item === "image",
      ),
      ...ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId),
      id: trimmedModelId,
      provider: PROVIDER_ID,
      api: "openai-chatgpt-responses",
      baseUrl: synthBaseUrl,
    };
  }

  const isGpt56 = OPENAI_CODEX_GPT_56_MODEL_IDS.some((modelId) => modelId === lower);
  if (isGpt56 || lower === OPENAI_CODEX_GPT_55_MODEL_ID) {
    const contextWindow = isGpt56
      ? OPENAI_CODEX_GPT_56_NATIVE_CONTEXT_TOKENS
      : OPENAI_CODEX_GPT_55_CODEX_CONTEXT_TOKENS;
    const registeredModel = withDefaultCodexContextMetadata({
      model: ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId),
      baseUrl: synthBaseUrl,
      contextWindow,
      contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
    });
    const model: ProviderRuntimeModel = registeredModel ?? {
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-chatgpt-responses",
      provider: PROVIDER_ID,
      baseUrl: synthBaseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
    };
    return isGpt56
      ? {
          ...model,
          thinkingLevelMap: registeredModel
            ? { ...OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP, ...registeredModel.thinkingLevelMap }
            : OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP,
        }
      : model;
  }

  let templateIds: readonly string[];
  let patch: Parameters<typeof buildFirstTemplateModel>[0]["patch"];
  const knownPatch = OPENAI_CODEX_FORWARD_COMPAT_PATCHES.get(
    lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : lower,
  );
  if (knownPatch) {
    templateIds =
      lower === OPENAI_CODEX_GPT_55_PRO_MODEL_ID
        ? OPENAI_CODEX_GPT_55_PRO_TEMPLATE_MODEL_IDS
        : OPENAI_CODEX_GPT_54_CATALOG_SYNTH_TEMPLATE_MODEL_IDS;
    patch = {
      contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
      ...knownPatch,
      ...(knownPatch.input ? { input: [...knownPatch.input] } : {}),
    };
  } else if (
    ctx.agentRuntimeId === "codex" &&
    ctx.authProfileId === undefined &&
    ctx.authProfileMode === undefined &&
    ctx.providerConfig?.auth === undefined
  ) {
    // Codex owns its account-scoped model catalog. When that catalog is not yet
    // available, keep the requested identity intact and let the native runtime
    // decide whether the account can actually use it.
    templateIds = OPENAI_CODEX_GPT_56_MODEL_IDS;
    patch = {
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: OPENAI_CODEX_GPT_56_THINKING_LEVEL_MAP,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    };
  } else {
    return undefined;
  }
  patch = {
    ...patch,
    api: "openai-chatgpt-responses",
    baseUrl: synthBaseUrl,
  };

  const canonicalModelId =
    lower === OPENAI_CODEX_GPT_54_LEGACY_MODEL_ID ? OPENAI_CODEX_GPT_54_MODEL_ID : trimmedModelId;
  return (
    buildFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: canonicalModelId,
      templateIds,
      ctx,
      patch,
    }) ?? {
      id: canonicalModelId,
      name: canonicalModelId,
      api: "openai-chatgpt-responses",
      provider: PROVIDER_ID,
      baseUrl: synthBaseUrl,
      reasoning: true,
      input: patch?.input ?? ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      contextTokens: patch?.contextTokens,
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      ...(patch?.thinkingLevelMap ? { thinkingLevelMap: patch.thinkingLevelMap } : {}),
      ...(patch?.compat ? { compat: patch.compat } : {}),
    }
  );
}

function withDefaultCodexContextMetadata(params: {
  model: ProviderRuntimeModel | undefined;
  baseUrl: string;
  contextWindow: number;
  contextTokens: number;
}): ProviderRuntimeModel | undefined {
  if (!params.model) {
    return undefined;
  }
  const contextTokens =
    typeof params.model.contextTokens === "number"
      ? params.model.contextTokens
      : typeof params.model.contextWindow === "number" && params.model.contextWindow > 0
        ? Math.min(params.contextTokens, params.model.contextWindow)
        : params.contextTokens;
  const input = params.model.input?.includes("image")
    ? params.model.input
    : uniqueValues<"text" | "image">([...(params.model.input ?? ["text"]), "image"]);
  return {
    ...params.model,
    api: "openai-chatgpt-responses",
    baseUrl: params.baseUrl,
    input,
    contextWindow: params.contextWindow,
    contextTokens,
  };
}

export function buildOpenAICodexProviderHooks(): Required<
  Pick<
    ProviderPlugin,
    | "resolveDynamicModel"
    | "preferRuntimeResolvedModel"
    | "normalizeResolvedModel"
    | "normalizeTransport"
    | "resolveUsageAuth"
    | "fetchUsageSnapshot"
  >
> {
  return {
    resolveDynamicModel: resolveCodexForwardCompatModel,
    preferRuntimeResolvedModel: (ctx) => {
      if (!isOpenAIProvider(ctx.provider)) {
        return false;
      }
      const id = ctx.modelId.trim().toLowerCase();
      return OPENAI_CHATGPT_MODERN_MODEL_IDS.some((modelId) => modelId === id);
    },
    normalizeResolvedModel: (ctx) => {
      if (!isOpenAIProvider(ctx.provider)) {
        return undefined;
      }
      const transportNormalized = normalizeCodexTransport(ctx.model);
      const imageCapable =
        applyOpenAICodexImageInputCapability({
          modelId: ctx.modelId,
          model: transportNormalized,
        }) ?? transportNormalized;
      return imageCapable === ctx.model ? undefined : imageCapable;
    },
    normalizeTransport: ({ provider, api, baseUrl }) => {
      if (!isOpenAIProvider(provider)) {
        return undefined;
      }
      const normalized = normalizeCodexTransportFields({ api, baseUrl });
      if (normalized.api === api && normalized.baseUrl === baseUrl) {
        return undefined;
      }
      return normalized;
    },
    resolveUsageAuth: resolveOpenAIUsageAuth,
    fetchUsageSnapshot: fetchOpenAIUsage,
  };
}
