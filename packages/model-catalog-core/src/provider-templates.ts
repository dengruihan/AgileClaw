// Curated provider templates for the Control UI "add provider" flow.
//
// Each row is a hand-written projection of a source plugin catalog: endpoint,
// header, and model facts come from extensions/<plugin>/openclaw.plugin.json or
// the plugin builder that owns them. provider-templates.plugins.test.ts checks
// the manifest-owned facts and test/provider-templates.contract.test.ts binds
// the plugin builders, so update the affected row (and its model table)
// whenever a source plugin catalog changes.
//
// Templates are editor draft seeds only. A created provider is an ordinary
// custom-<host> config entry with no template linkage, so nothing here widens
// the config schema.
import type {
  ModelCatalogApi,
  ModelCatalogCompatConfig,
  ModelCatalogCost,
  ModelCatalogThinkingLevelMap,
} from "./model-catalog-types.js";
import {
  DEEPSEEK_MODELS,
  KIMI_CODE_MODELS,
  MINIMAX_MODELS,
  MOONSHOT_MODELS,
  ZAI_MODELS,
} from "./provider-templates.catalog.js";
import {
  QWEN_CODING_MODELS,
  QWEN_MODELS,
  QWEN_TOKEN_PLAN_MODELS,
} from "./provider-templates.qwen.js";

/** Bilingual display name; consumers pick the locale at render time. */
export type ProviderTemplateName = {
  en: string;
  zhCN: string;
};

/** Input modality accepted by a curated model, matching the config model schema. */
export type ProviderTemplateModelInput = "text" | "image" | "video" | "audio";

/** Model row written to models.providers.<key>.models when a template is created. */
export type ProviderTemplateModel = {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ProviderTemplateModelInput[];
  cost?: ModelCatalogCost;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: ModelCatalogThinkingLevelMap;
  compat?: ModelCatalogCompatConfig;
};

/** Endpoint facts a template pre-fills; mirrors the source plugin catalog entry. */
export type ProviderTemplateProvider = {
  baseUrl: string;
  api: ModelCatalogApi;
  headers?: Record<string, string>;
  defaultModel?: string;
  models: ProviderTemplateModel[];
};

/** One curated provider row of the template picker. */
export type ProviderTemplate = {
  /** Template identity for UI keys and guards; never written to config. */
  id: string;
  /** Group id from PROVIDER_TEMPLATE_GROUPS. */
  group: string;
  /** Sort order inside the group; lower comes first. */
  order: number;
  name: ProviderTemplateName;
  /** Control UI icon asset id (PROVIDER_ICON_IDS); written verbatim as icon. */
  icon: string;
  provider: ProviderTemplateProvider;
  /** Authentication mode offered by the template; OAuth entries are out of scope. */
  auth: "api-key";
  /** Plugin provider id whose manifest or builder owns these endpoint and model facts. */
  sourceProviderId: string;
  /**
   * Endpoint key seed for templates that share a host with another template;
   * absent means the key derives from the base URL host via buildEndpointIdFromUrl.
   */
  keySeed?: string;
};

/** Picker section that rows reference by id. */
export type ProviderTemplateGroup = {
  id: string;
  order: number;
  name: ProviderTemplateName;
};

export const PROVIDER_TEMPLATE_GROUPS: readonly ProviderTemplateGroup[] = [
  {
    id: "zhipu",
    order: 10,
    name: {
      en: "Zhipu",
      zhCN: "智谱",
    },
  },
  {
    id: "other",
    order: 20,
    name: {
      en: "Other",
      zhCN: "其他",
    },
  },
];

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: "zhipu-coding-cn",
    group: "zhipu",
    order: 10,
    name: { en: "BigModel Coding Plan", zhCN: "BigModel Coding Plan" },
    icon: "zai",
    provider: {
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      api: "openai-completions",
      defaultModel: "glm-5.3",
      models: ZAI_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "zai",
    keySeed: "custom-open-bigmodel-cn-coding",
  },
  {
    id: "zai-coding",
    group: "zhipu",
    order: 20,
    name: { en: "Z.ai Coding Plan", zhCN: "Z.ai Coding Plan" },
    icon: "zai",
    provider: {
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      defaultModel: "glm-5.3",
      models: ZAI_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "zai",
    keySeed: "custom-api-z-ai-coding",
  },
  {
    id: "zhipu-api-cn",
    group: "zhipu",
    order: 30,
    name: { en: "BigModel API", zhCN: "BigModel API" },
    icon: "zai",
    provider: {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      api: "openai-completions",
      defaultModel: "glm-5.2",
      models: ZAI_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "zai",
  },
  {
    id: "zai-api",
    group: "zhipu",
    order: 40,
    name: { en: "Z.ai API", zhCN: "Z.ai API" },
    icon: "zai",
    provider: {
      baseUrl: "https://api.z.ai/api/paas/v4",
      api: "openai-completions",
      defaultModel: "glm-5.2",
      models: ZAI_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "zai",
  },
  {
    id: "kimi",
    group: "other",
    order: 10,
    name: { en: "Kimi", zhCN: "Kimi" },
    icon: "kimi",
    provider: {
      baseUrl: "https://api.moonshot.ai/v1",
      api: "openai-completions",
      defaultModel: "kimi-k3",
      models: MOONSHOT_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "moonshot",
  },
  {
    id: "kimi-cn",
    group: "other",
    order: 20,
    name: { en: "Kimi (China)", zhCN: "Kimi（中国）" },
    icon: "kimi",
    provider: {
      baseUrl: "https://api.moonshot.cn/v1",
      api: "openai-completions",
      defaultModel: "kimi-k3",
      models: MOONSHOT_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "moonshot",
  },
  {
    id: "kimi-code",
    group: "other",
    order: 30,
    name: { en: "Kimi Code", zhCN: "Kimi Code" },
    icon: "kimi",
    provider: {
      baseUrl: "https://api.kimi.com/coding/",
      api: "anthropic-messages",
      headers: { "User-Agent": "claude-code/0.1.0" },
      defaultModel: "kimi-for-coding",
      models: KIMI_CODE_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "kimi",
  },
  {
    id: "minimax",
    group: "other",
    order: 40,
    name: { en: "MiniMax", zhCN: "MiniMax" },
    icon: "minimax",
    provider: {
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      defaultModel: "MiniMax-M3",
      models: MINIMAX_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "minimax",
  },
  {
    id: "minimax-cn",
    group: "other",
    order: 50,
    name: { en: "MiniMax M Plan (China)", zhCN: "MiniMax M Plan（中国）" },
    icon: "minimax",
    provider: {
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      defaultModel: "MiniMax-M3",
      models: MINIMAX_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "minimax",
  },
  {
    id: "deepseek",
    group: "other",
    order: 60,
    name: { en: "DeepSeek", zhCN: "DeepSeek" },
    icon: "deepseek",
    provider: {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      defaultModel: "deepseek-v4-pro",
      models: DEEPSEEK_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "deepseek",
  },
  {
    id: "bailian-cn",
    group: "other",
    order: 70,
    name: { en: "Alibaba Cloud Bailian (China)", zhCN: "阿里云百炼（中国）" },
    icon: "alibaba",
    provider: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      defaultModel: "qwen3.5-plus",
      models: QWEN_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "qwen",
  },
  {
    id: "bailian-intl",
    group: "other",
    order: 80,
    name: { en: "Alibaba Cloud Bailian (International)", zhCN: "阿里云百炼（国际）" },
    icon: "alibaba",
    provider: {
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      defaultModel: "qwen3.5-plus",
      models: QWEN_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "qwen",
  },
  {
    id: "bailian-coding-cn",
    group: "other",
    order: 90,
    name: {
      en: "Alibaba Cloud Bailian Coding Plan (China)",
      zhCN: "阿里云百炼 Coding Plan（中国）",
    },
    icon: "alibaba",
    provider: {
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      api: "openai-completions",
      defaultModel: "qwen3.5-plus",
      models: QWEN_CODING_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "qwen",
  },
  {
    id: "qwen-token-plan-cn",
    group: "other",
    order: 100,
    name: { en: "Bailian Token Plan (China)", zhCN: "阿里云百炼 Token Plan（中国）" },
    icon: "alibaba",
    provider: {
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      api: "openai-completions",
      defaultModel: "qwen3.7-plus",
      models: QWEN_TOKEN_PLAN_MODELS,
    },
    auth: "api-key",
    sourceProviderId: "qwen",
  },
];
