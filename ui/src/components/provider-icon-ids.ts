// Bundled provider icon ids in picker order. Icon validation and the picker
// inventory both derive from this list, so an asset cannot be known to one and
// silently dropped by the other. Each id maps to
// ui/public/provider-icons/ProviderIcon-<id>.svg.

export const PROVIDER_ICON_IDS = [
  // Model vendors.
  "alibaba",
  "arcee",
  "claude",
  "codex",
  "cohere",
  "deepseek",
  "doubao",
  "gemini",
  "grok",
  "kimi",
  "longcat",
  "meta",
  "microsoft",
  "mimo",
  "minimax",
  "mistral",
  "nvidia",
  "perplexity",
  "sakana",
  "stepfun",
  "tencent",
  "zai",
  // Aggregating and hosting platforms.
  "baseten",
  "bedrock",
  "cerebras",
  "chutes",
  "clawrouter",
  "cloudflare",
  "deepinfra",
  "featherless",
  "fireworks",
  "groq",
  "huggingface",
  "litellm",
  "novita",
  "openrouter",
  "poe",
  "qianfan",
  "synthetic",
  "together",
  "venice",
  "vercel",
  // Local inference tools.
  "comfy",
  "llamacpp",
  "lmstudio",
  "ollama",
  "vllm",
  // Picker-only vendor products: ByteDance and Google keep one icon per company.
  "byteplus",
  "vertexai",
  "volcengine",
  // Coding agents, editors, and media tools.
  "abacus",
  "amp",
  "antigravity",
  "augment",
  "codebuff",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "devin",
  "elevenlabs",
  "factory",
  "fal",
  "jetbrains",
  "kilo",
  "kiro",
  "llmproxy",
  "manus",
  "opencode",
  "opencodego",
  "pi",
  "pixverse",
  "qoder",
  "runway",
  "t3chat",
  "warp",
  "windsurf",
  "zed",
] as const;

export type ProviderIconId = (typeof PROVIDER_ICON_IDS)[number];

const PROVIDER_ICON_ID_SET: ReadonlySet<string> = new Set(PROVIDER_ICON_IDS);

/** Whether a value names a bundled icon asset. */
export function isProviderIconId(value: string): boolean {
  return PROVIDER_ICON_ID_SET.has(value);
}
