// Binds the curated provider templates to the plugin builders and exported
// constants that own their exact endpoints, default models, and model rows.
// Each row also asserts the template's declared sourceProviderId against the
// plugin that supplies those builder facts, so the owner linkage cannot drift.
// This lives in the root test tree because core tsgo graphs must not include
// extension files (scripts/check-tsgo-core-boundary.mts); the package-level
// guard covers the manifest-owned facts instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from "@openclaw/model-catalog-core/provider-templates";
import { describe, expect, it } from "vitest";
import { DEEPSEEK_BASE_URL } from "../extensions/deepseek/models.js";
import { buildDeepSeekProvider } from "../extensions/deepseek/provider-catalog.js";
import {
  buildKimiCodingProvider,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
} from "../extensions/kimi-coding/provider-catalog.js";
import {
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
} from "../extensions/minimax/model-definitions.js";
import { buildMinimaxProvider } from "../extensions/minimax/provider-catalog.js";
import { MINIMAX_DEFAULT_MODEL_ID } from "../extensions/minimax/provider-models.js";
import {
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
} from "../extensions/moonshot/provider-catalog.js";
import {
  QWEN_CN_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
  QWEN_STANDARD_CN_BASE_URL,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_CN_BASE_URL,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
} from "../extensions/qwen/models.js";
import {
  buildQwenProvider,
  buildQwenTokenPlanProvider,
} from "../extensions/qwen/provider-catalog.js";
import {
  buildZaiCatalogModels,
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_DEFAULT_MODEL_ID,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
} from "../extensions/zai/model-definitions.js";

type ManifestCatalogProvider = {
  api?: string;
  defaultModel?: string;
};

type PluginManifest = {
  modelCatalog?: { providers?: Record<string, ManifestCatalogProvider> };
};

const EXTENSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions");

function readManifestCatalog(pluginDirectory: string, providerId: string): ManifestCatalogProvider {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSIONS_DIR, pluginDirectory, "openclaw.plugin.json"), "utf8"),
  ) as PluginManifest;
  const catalog = manifest.modelCatalog?.providers?.[providerId];
  if (!catalog) {
    throw new Error(
      `Missing modelCatalog.providers.${providerId} in extensions/${pluginDirectory}`,
    );
  }
  return catalog;
}

const zaiManifestCatalog = readManifestCatalog("zai", "zai");
const deepseekManifestCatalog = readManifestCatalog("deepseek", "deepseek");

/** Builder-owned model rows; every template is compared against these exactly. */
const moonshotProvider = buildMoonshotProvider();
const kimiCodingProvider = buildKimiCodingProvider();
const minimaxProvider = buildMinimaxProvider({});
const deepseekProvider = buildDeepSeekProvider();
const zaiModels = buildZaiCatalogModels();
const bailianCnProvider = buildQwenProvider({ baseUrl: QWEN_STANDARD_CN_BASE_URL });
const bailianIntlProvider = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });
const bailianCodingProvider = buildQwenProvider({ baseUrl: QWEN_CN_BASE_URL });
const tokenPlanProvider = buildQwenTokenPlanProvider({ baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL });

type OwnerModelRow = {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: readonly string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: unknown;
  compat?: unknown;
};

/** Normalizes builder and template rows onto the fields a template persists. */
function modelShape(model: OwnerModelRow) {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ["text"])],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap,
    compat: model.compat,
  };
}

type OwnerFacts = {
  /** Provider id the template must declare as its owner. */
  sourceProviderId: string;
  baseUrl: string;
  api: string | undefined;
  headers: Record<string, unknown> | undefined;
  defaultModel: string | undefined;
  models: readonly OwnerModelRow[];
};

const OWNER_FACTS: Record<string, OwnerFacts> = {
  "zhipu-coding-cn": {
    sourceProviderId: "zai",
    baseUrl: ZAI_CODING_CN_BASE_URL,
    api: zaiManifestCatalog.api,
    headers: undefined,
    defaultModel: ZAI_CODING_DEFAULT_MODEL_ID,
    models: zaiModels,
  },
  "zai-coding": {
    sourceProviderId: "zai",
    baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
    api: zaiManifestCatalog.api,
    headers: undefined,
    defaultModel: ZAI_CODING_DEFAULT_MODEL_ID,
    models: zaiModels,
  },
  "zhipu-api-cn": {
    sourceProviderId: "zai",
    baseUrl: ZAI_CN_BASE_URL,
    api: zaiManifestCatalog.api,
    headers: undefined,
    defaultModel: ZAI_DEFAULT_MODEL_ID,
    models: zaiModels,
  },
  "zai-api": {
    sourceProviderId: "zai",
    baseUrl: ZAI_GLOBAL_BASE_URL,
    api: zaiManifestCatalog.api,
    headers: undefined,
    defaultModel: ZAI_DEFAULT_MODEL_ID,
    models: zaiModels,
  },
  kimi: {
    sourceProviderId: "moonshot",
    baseUrl: MOONSHOT_BASE_URL,
    api: moonshotProvider.api,
    headers: undefined,
    defaultModel: MOONSHOT_DEFAULT_MODEL_ID,
    models: moonshotProvider.models,
  },
  "kimi-cn": {
    sourceProviderId: "moonshot",
    baseUrl: MOONSHOT_CN_BASE_URL,
    api: moonshotProvider.api,
    headers: undefined,
    defaultModel: MOONSHOT_DEFAULT_MODEL_ID,
    models: moonshotProvider.models,
  },
  "kimi-code": {
    sourceProviderId: "kimi",
    baseUrl: KIMI_CODING_BASE_URL,
    api: kimiCodingProvider.api,
    headers: kimiCodingProvider.headers,
    defaultModel: KIMI_CODING_DEFAULT_MODEL_ID,
    models: kimiCodingProvider.models,
  },
  minimax: {
    sourceProviderId: "minimax",
    baseUrl: MINIMAX_API_BASE_URL,
    api: minimaxProvider.api,
    headers: undefined,
    defaultModel: MINIMAX_DEFAULT_MODEL_ID,
    models: minimaxProvider.models,
  },
  "minimax-cn": {
    sourceProviderId: "minimax",
    baseUrl: MINIMAX_CN_API_BASE_URL,
    api: minimaxProvider.api,
    headers: undefined,
    defaultModel: MINIMAX_DEFAULT_MODEL_ID,
    models: minimaxProvider.models,
  },
  deepseek: {
    sourceProviderId: "deepseek",
    baseUrl: DEEPSEEK_BASE_URL,
    api: deepseekProvider.api,
    headers: undefined,
    defaultModel: deepseekManifestCatalog.defaultModel,
    models: deepseekProvider.models,
  },
  "bailian-cn": {
    sourceProviderId: "qwen",
    baseUrl: QWEN_STANDARD_CN_BASE_URL,
    api: bailianCnProvider.api,
    headers: undefined,
    defaultModel: QWEN_DEFAULT_MODEL_ID,
    models: bailianCnProvider.models,
  },
  "bailian-intl": {
    sourceProviderId: "qwen",
    baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
    api: bailianIntlProvider.api,
    headers: undefined,
    defaultModel: QWEN_DEFAULT_MODEL_ID,
    models: bailianIntlProvider.models,
  },
  "bailian-coding-cn": {
    sourceProviderId: "qwen",
    baseUrl: QWEN_CN_BASE_URL,
    api: bailianCodingProvider.api,
    headers: undefined,
    defaultModel: QWEN_DEFAULT_MODEL_ID,
    models: bailianCodingProvider.models,
  },
  "qwen-token-plan-cn": {
    sourceProviderId: "qwen",
    baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL,
    api: tokenPlanProvider.api,
    headers: undefined,
    defaultModel: QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
    models: tokenPlanProvider.models,
  },
};

function ownerFactsFor(templateId: string): OwnerFacts {
  const facts = OWNER_FACTS[templateId];
  if (!facts) {
    throw new Error(`No owner facts are mapped for provider template ${templateId}`);
  }
  return facts;
}

describe("provider templates match their owning plugin builders", () => {
  it("maps every template to exactly one owner fact set", () => {
    const templateIds = PROVIDER_TEMPLATES.map((template) => template.id).toSorted();

    expect(Object.keys(OWNER_FACTS).toSorted()).toEqual(templateIds);
  });

  it.each(PROVIDER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s",
    (id, template: ProviderTemplate) => {
      const owner = ownerFactsFor(id);

      expect(template.sourceProviderId, `${id} source provider`).toBe(owner.sourceProviderId);
      expect(template.provider.baseUrl, `${id} endpoint`).toBe(owner.baseUrl);
      expect(template.provider.api, `${id} api`).toBe(owner.api);
      expect(template.provider.headers, `${id} headers`).toEqual(owner.headers);
      expect(template.provider.defaultModel, `${id} default model`).toBe(owner.defaultModel);
      expect(template.provider.models.map(modelShape), `${id} models`).toEqual(
        owner.models.map(modelShape),
      );
    },
  );
});
