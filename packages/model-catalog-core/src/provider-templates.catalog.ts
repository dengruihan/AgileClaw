// Model rows shared by the curated provider templates. Kept apart from
// provider-templates.ts so the files stay inside the lint line budget.
//
// Values mirror each source plugin catalog row; see provider-templates.ts,
// provider-templates.plugins.test.ts, and test/provider-templates.contract.test.ts
// for the owning facts and their guards.
import type { ProviderTemplateModel } from "./provider-templates.js";

export const ZAI_MODELS: ProviderTemplateModel[] = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 131072,
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "glm-5-turbo",
    name: "GLM-5-Turbo",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 131072,
  },
  {
    id: "glm-5v-turbo",
    name: "GLM-5V-Turbo",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 131072,
  },
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 131072,
    compat: {
      codeMode: "preferred",
    },
  },
];

export const MOONSHOT_MODELS: ProviderTemplateModel[] = [
  {
    id: "kimi-k3",
    name: "Kimi K3",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 1048576,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "max",
      max: "max",
    },
    compat: {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "high", "max"],
      codeMode: "preferred",
    },
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.95,
      output: 4,
      cacheRead: 0.19,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "kimi-k2.7-code-highspeed",
    name: "Kimi K2.7 Code HighSpeed",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.9,
      output: 8,
      cacheRead: 0.38,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 262144,
  },
];

export const KIMI_CODE_MODELS: ProviderTemplateModel[] = [
  {
    id: "k3",
    name: "Kimi K3",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "k3-256k",
    name: "Kimi K3 (256k)",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 131072,
    thinkingLevelMap: {
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "kimi-for-coding",
    name: "Kimi Code",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "kimi-for-coding-highspeed",
    name: "Kimi K2.7 Code HighSpeed",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 32768,
  },
];

export const MINIMAX_MODELS: ProviderTemplateModel[] = [
  {
    id: "MiniMax-M3",
    name: "MiniMax M3",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 131072,
    compat: {
      codeMode: "preferred",
    },
  },
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    },
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 Highspeed",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    },
    contextWindow: 204800,
    maxTokens: 131072,
  },
];

export const DEEPSEEK_MODELS: ProviderTemplateModel[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      codeMode: "preferred",
    },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      codeMode: "preferred",
    },
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Experimental)",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.44,
      output: 1.32,
      cacheRead: 0.014,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      codeMode: "preferred",
    },
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: 0,
    },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      codeMode: "preferred",
    },
  },
];
