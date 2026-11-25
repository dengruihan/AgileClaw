// Provider brand rules: one table mapping a provider name to one bundled brand
// mark, plus the icon-picker inventory and the draft edits the provider editor
// applies. Icon ids come from provider-icon-ids.ts; assets live in
// ui/public/provider-icons/ProviderIcon-<icon>.svg.
//
// Matching runs once when a name is committed and the result is stored in
// models.providers.<id>.icon, so display surfaces only read saved icons. Agent
// tools and media tools are picker-only: their names must not steal an icon from
// a model vendor or hosting platform.

import { PROVIDER_ICON_IDS, type ProviderIconId } from "./provider-icon-ids.ts";

/** One bundled brand mark and, when it names a brand, its name rule. */
export type ProviderBrandIcon = {
  /** Asset id: `ProviderIcon-<icon>.svg` in ui/public/provider-icons. */
  icon: ProviderIconId;
  /** Readable label for the icon picker. */
  label: string;
  /**
   * Case-insensitive substring rule. Rules are intentionally broad (a model
   * family names its vendor); a few brands need a narrower form: "meta",
   * "poe", and "crof" match as whole words so "metadata", "poem"/"poetry",
   * "Mycroft", and the "microfono"/"microfoon" microphone words keep no icon,
   * "crossmodel" only matches the joined brand spelling so the generic phrase
   * "cross model" does not claim it, and comfy only matches the ComfyUI product
   * name.
   */
  pattern?: RegExp;
};

type ProviderBrandIconMeta = Omit<ProviderBrandIcon, "icon">;

// One row per bundled asset, keyed by the shared icon id list. A row without a
// pattern is picker-only: either the asset belongs to a company whose matches
// point at another icon (ByteDance → doubao, Google → gemini), or it is an
// agent/media/misc mark that must not drive automatic selection.
const BRAND_ICON_META: Record<ProviderIconId, ProviderBrandIconMeta> = {
  // Model vendors.
  alibaba: {
    label: "Alibaba Qwen",
    pattern: /alibaba|qwen|tongyi|qianwen|阿里云|通义|千问/i,
  },
  arcee: { label: "Arcee AI", pattern: /arcee/i },
  claude: { label: "Claude (Anthropic)", pattern: /anthropic|claude/i },
  codex: {
    // CodexBar ships the OpenAI knot under this asset name; it is OpenAI's mark.
    label: "OpenAI (Codex)",
    pattern: /open[\s_-]?ai|chatgpt|gpt/i,
  },
  cohere: { label: "Cohere", pattern: /cohere|command[\s_-]?r\b/i },
  deepseek: {
    label: "DeepSeek",
    pattern: /deep[\s_-]?seek|深度求索/i,
  },
  doubao: {
    label: "Doubao",
    // ByteDance products all resolve to its model brand; the byteplus and
    // volcengine assets stay picker-only for that reason.
    pattern:
      /doubao|bytedance|byte[\s_-]?dance|byte[\s_-]?plus|volcengine|volcano[\s_-]?engine|豆包|字节跳动|字节|火山引擎/i,
  },
  gemini: {
    label: "Gemini (Google)",
    // Google products all resolve to Gemini, including Vertex AI.
    pattern: /google|gemini|gemma|bard|vertex[\s_-]?ai|谷歌/i,
  },
  grok: { label: "Grok (xAI)", pattern: /grok|xai|x\.ai/i },
  kimi: { label: "Kimi (Moonshot)", pattern: /moonshot|kimi|月之暗面/i },
  longcat: {
    label: "LongCat",
    pattern: /long[\s_-]?cat|龙猫|美团/i,
  },
  meta: {
    label: "Meta (Llama)",
    // Whole-word meta avoids "metadata"; Llama is Meta's model family, and the
    // longer ollama/llama.cpp rules win before this one can claim those names.
    pattern: /\bmeta\b|llama/i,
  },
  microsoft: {
    label: "Microsoft",
    pattern: /microsoft|azure|微软/i,
  },
  mimo: { label: "Xiaomi MiMo", pattern: /xiaomi|mimo|小米/i },
  minimax: {
    label: "MiniMax",
    pattern: /minimax|abab|稀宇/i,
  },
  mistral: {
    label: "Mistral AI",
    pattern: /mistral|mixtral|codestral|devstral|pixtral/i,
  },
  nvidia: {
    label: "NVIDIA",
    pattern: /nvidia|nemotron|英伟达/i,
  },
  perplexity: { label: "Perplexity", pattern: /perplexity/i },
  sakana: { label: "Sakana AI", pattern: /sakana/i },
  stepfun: {
    label: "StepFun",
    pattern: /step[\s_-]?fun|阶跃/i,
  },
  tencent: {
    label: "Tencent Hunyuan",
    pattern: /tencent|hunyuan|腾讯|混元/i,
  },
  zai: {
    label: "Z.ai (GLM)",
    pattern: /zai|z\.ai|zhipu|glm|chatglm|智谱/i,
  },

  // Aggregating and hosting platforms. Abacus.AI is the ChatLLM/RouteLLM
  // platform; "abacus" does not appear inside another product name.
  abacus: { label: "Abacus.AI", pattern: /abacus/i },
  baseten: { label: "Baseten", pattern: /baseten/i },
  bedrock: {
    label: "Amazon Bedrock",
    pattern: /bedrock|amazon/i,
  },
  cerebras: { label: "Cerebras", pattern: /cerebras/i },
  chutes: { label: "Chutes", pattern: /chutes/i },
  clawrouter: {
    label: "ClawRouter",
    pattern: /clawrouter|claw[\s_-]?router/i,
  },
  cloudflare: { label: "Cloudflare AI Gateway", pattern: /cloudflare/i },
  // Whole-word crof keeps "Mycroft", "croft" and the "microfono"/"microfoon"
  // microphone words off CrofAI's mark; the joined "crofai" form still matches.
  crof: { label: "Crof", pattern: /\bcrof\b|crof[\s._-]?ai/i },
  // Joined spelling only: "cross model" is a generic phrase, not the brand.
  crossmodel: { label: "Crossmodel", pattern: /crossmodel/i },
  deepinfra: {
    label: "DeepInfra",
    pattern: /deep[\s_-]?infra/i,
  },
  featherless: {
    label: "Featherless AI",
    pattern: /featherless/i,
  },
  fireworks: {
    label: "Fireworks AI",
    pattern: /fireworks/i,
  },
  groq: { label: "Groq", pattern: /groq/i },
  huggingface: {
    label: "Hugging Face",
    pattern: /huggingface|hugging[\s_-]?face/i,
  },
  litellm: {
    label: "LiteLLM",
    pattern: /litellm|lite[\s_-]?llm/i,
  },
  novita: { label: "Novita AI", pattern: /novita/i },
  openrouter: {
    label: "OpenRouter",
    pattern: /openrouter|open[\s_-]?router/i,
  },
  // Whole-word poe keeps "poem" and "poetry" from claiming the writing platform.
  poe: { label: "Poe", pattern: /\bpoe\b/i },
  qianfan: {
    label: "Baidu Qianfan",
    pattern: /qianfan|百度|千帆/i,
  },
  synthetic: { label: "Synthetic", pattern: /synthetic/i },
  together: { label: "Together AI", pattern: /together/i },
  venice: { label: "Venice AI", pattern: /venice/i },
  vercel: { label: "Vercel AI Gateway", pattern: /vercel/i },

  // Local inference tools. ComfyUI is the one media-adjacent tool with a rule
  // because its product name is unique enough to be safe.
  comfy: { label: "ComfyUI", pattern: /comfyui/i },
  llamacpp: {
    label: "llama.cpp",
    pattern: /llama[\s._-]?cpp/i,
  },
  lmstudio: { label: "LM Studio", pattern: /lm[\s_-]?studio/i },
  ollama: { label: "Ollama", pattern: /ollama/i },
  vllm: { label: "vLLM", pattern: /vllm/i },

  // Picker-only vendor products: ByteDance and Google keep one icon per company.
  byteplus: { label: "BytePlus" },
  vertexai: { label: "Vertex AI (Google)" },
  volcengine: { label: "Volcengine" },

  // Coding agents, editors, media tools, and the generic LLM Proxy mark:
  // selectable, never name-matched.
  amp: { label: "Amp" },
  antigravity: { label: "Antigravity (Google)" },
  augment: { label: "Augment Code" },
  codebuff: { label: "Codebuff" },
  commandcode: { label: "CommandCode" },
  copilot: { label: "GitHub Copilot" },
  cursor: { label: "Cursor" },
  deepgram: { label: "Deepgram" },
  devin: { label: "Devin" },
  elevenlabs: { label: "ElevenLabs" },
  factory: { label: "Factory" },
  fal: { label: "fal" },
  jetbrains: { label: "JetBrains" },
  kilo: { label: "Kilo Code" },
  kiro: { label: "Kiro (AWS)" },
  // Not a company: the mark covers any LLM-API-Key-Proxy-compatible /v1/quota-stats
  // endpoint, whose base URL each operator supplies, so a name rule would claim
  // every self-hosted relay called "LLM Proxy".
  llmproxy: { label: "LLM Proxy" },
  manus: { label: "Manus" },
  opencode: { label: "OpenCode" },
  opencodego: { label: "OpenCode Go" },
  pi: { label: "Pi" },
  pixverse: { label: "PixVerse" },
  qoder: { label: "Qoder" },
  runway: { label: "Runway" },
  t3chat: { label: "T3 Chat" },
  warp: { label: "Warp" },
  windsurf: { label: "Windsurf" },
  zed: { label: "Zed" },
};

/** Every bundled brand mark in picker order, including picker-only rows. */
export const PROVIDER_BRAND_ICONS: readonly ProviderBrandIcon[] = PROVIDER_ICON_IDS.map((icon) => {
  const meta = BRAND_ICON_META[icon];
  return meta.pattern
    ? { icon, label: meta.label, pattern: meta.pattern }
    : { icon, label: meta.label };
});

export type ProviderBrandRule = ProviderBrandIcon & { pattern: RegExp };

/** The name rules; every row carries the icon it selects plus its picker label. */
export const PROVIDER_BRAND_RULES: readonly ProviderBrandRule[] = PROVIDER_BRAND_ICONS.filter(
  (entry): entry is ProviderBrandRule => entry.pattern !== undefined,
);

type BrandMatch = { start: number; end: number; icon: ProviderIconId };

function collectBrandMatches(name: string): BrandMatch[] {
  const matches: BrandMatch[] = [];
  for (const rule of PROVIDER_BRAND_RULES) {
    // matchAll needs a stateless global expression; rules are shared, so clone.
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    for (const match of name.matchAll(pattern)) {
      if (match[0]) {
        matches.push({
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
          icon: rule.icon,
        });
      }
    }
  }
  return matches;
}

/**
 * Brand icon for a provider name, or null when no name rule fires or the rules
 * resolve to more than one company.
 *
 * Longest match wins first (earlier start breaks ties), and a kept span blocks
 * shorter overlapping ones, so "Ollama" stays Ollama rather than Meta's Llama
 * and "llama.cpp" resolves to the local runtime. After the greedy pass exactly
 * one company must remain.
 */
export function matchProviderBrand(name: string): string | null {
  if (!name.trim()) {
    return null;
  }
  const ranked = collectBrandMatches(name).toSorted(
    (left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start,
  );
  const kept: BrandMatch[] = [];
  for (const candidate of ranked) {
    if (kept.some((span) => candidate.start < span.end && span.start < candidate.end)) {
      continue;
    }
    kept.push(candidate);
  }
  const companies = new Set(kept.map((span) => span.icon));
  return companies.size === 1 ? ([...companies][0] ?? null) : null;
}

/** Draft leaves the icon rules write. */
export type ProviderIconField = "icon" | "iconManual";

export type ProviderBrandDraftUpdate = {
  /** Copy of the input draft with brand icon fields applied. */
  draft: Record<string, unknown>;
  /** Whether `icon` or `iconManual` differs from the input draft. */
  changed: boolean;
  /**
   * Leaves the caller must mark touched for its config patch to include them.
   * Only real changes are reported, so a rename never writes an absent leaf.
   */
  changedFields: readonly ProviderIconField[];
};

function changedIconFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): ProviderIconField[] {
  return (["icon", "iconManual"] as const).filter(
    (field) =>
      before[field] !== after[field] ||
      Object.hasOwn(before, field) !== Object.hasOwn(after, field),
  );
}

function committedName(draft: Readonly<Record<string, unknown>>): string {
  return typeof draft.displayName === "string" ? draft.displayName : "";
}

/** Draft copy carrying the name's automatic icon and no manual flag. */
function automaticIconDraft(
  draft: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const next = { ...draft };
  const icon = matchProviderBrand(name);
  if (icon) {
    next.icon = icon;
  } else {
    delete next.icon;
  }
  delete next.iconManual;
  return next;
}

function iconUpdate(
  draft: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): ProviderBrandDraftUpdate {
  const changedFields = changedIconFields(draft, next);
  return { draft: { ...next }, changed: changedFields.length > 0, changedFields };
}

/**
 * Applies the name's automatic icon to a provider draft. A manual choice (or a
 * manual removal) is left alone. When no rule fires the auto icon is removed,
 * and a non-manual `iconManual` leaf is dropped. Returns a new draft; the input
 * is never mutated.
 */
export function applyProviderNameIcon(
  draft: Readonly<Record<string, unknown>>,
  name: string,
): ProviderBrandDraftUpdate {
  if (draft.iconManual === true) {
    return { draft: { ...draft }, changed: false, changedFields: [] };
  }
  return iconUpdate(draft, automaticIconDraft(draft, name));
}

export type ProviderIconChoice =
  | { kind: "icon"; icon: string }
  | { kind: "auto" }
  | { kind: "none" };

/**
 * Applies one explicit picker choice to a provider draft. "auto" re-runs the
 * rule against the committed `displayName` (not the live name field) and drops
 * the manual flag; "none" keeps the manual flag without an icon so a rename
 * cannot bring an icon back. Returns a new draft; the input is never mutated.
 */
export function applyProviderIconChoice(
  draft: Readonly<Record<string, unknown>>,
  choice: ProviderIconChoice,
): ProviderBrandDraftUpdate {
  if (choice.kind === "icon") {
    return iconUpdate(draft, { ...draft, icon: choice.icon, iconManual: true });
  }
  if (choice.kind === "none") {
    const next = { ...draft };
    delete next.icon;
    next.iconManual = true;
    return iconUpdate(draft, next);
  }
  return iconUpdate(draft, automaticIconDraft(draft, committedName(draft)));
}
