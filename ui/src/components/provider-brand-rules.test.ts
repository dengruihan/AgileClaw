// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyProviderIconChoice,
  applyProviderNameIcon,
  matchProviderBrand,
  PROVIDER_BRAND_ICONS,
  PROVIDER_BRAND_RULES,
} from "./provider-brand-rules.ts";

const iconsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/provider-icons",
);
const assetIcons = readdirSync(iconsDir)
  .filter((file) => /^ProviderIcon-.+\.svg$/.test(file))
  .map((file) => file.slice("ProviderIcon-".length, -".svg".length))
  .toSorted();

describe("matchProviderBrand", () => {
  it("matches brand names anywhere in the name (OpenAI's asset is codex)", () => {
    expect(matchProviderBrand("XGLM-7.5B")).toBe("zai");
    expect(matchProviderBrand("MyGPT")).toBe("codex");
    expect(matchProviderBrand("我的 MyGPT 代理")).toBe("codex");
    expect(matchProviderBrand("self-hosted-qwen")).toBe("alibaba");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(matchProviderBrand("  OPENAI  ")).toBe("codex");
    expect(matchProviderBrand("DeepSeek")).toBe("deepseek");
  });

  it("returns null when the kept matches span more than one company", () => {
    expect(matchProviderBrand("OpenAI Claude")).toBeNull();
    expect(matchProviderBrand("Gemini and Qwen")).toBeNull();
    expect(matchProviderBrand("OpenRouter + Together")).toBeNull();
  });

  it("keeps one company when several of its rules fire", () => {
    expect(matchProviderBrand("OpenAI GPT-4o")).toBe("codex");
    expect(matchProviderBrand("Google Gemini")).toBe("gemini");
  });

  it("keeps the longest of overlapping matches", () => {
    expect(matchProviderBrand("Ollama")).toBe("ollama");
    expect(matchProviderBrand("Ollama Cloud")).toBe("ollama");
    expect(matchProviderBrand("llama.cpp")).toBe("llamacpp");
    expect(matchProviderBrand("llama-cpp")).toBe("llamacpp");
    expect(matchProviderBrand("llama-3")).toBe("meta");
  });

  it("matches meta only as a whole word", () => {
    expect(matchProviderBrand("Meta")).toBe("meta");
    expect(matchProviderBrand("Meta AI")).toBe("meta");
    expect(matchProviderBrand("使用 meta 模型")).toBe("meta");
    expect(matchProviderBrand("metadata pipeline")).toBeNull();
    expect(matchProviderBrand("Metamax")).toBeNull();
  });

  it("matches poe only as a whole word", () => {
    expect(matchProviderBrand("Poe")).toBe("poe");
    expect(matchProviderBrand("Poe 中转")).toBe("poe");
    expect(matchProviderBrand("poe-relay")).toBe("poe");
    expect(matchProviderBrand("poem")).toBeNull();
    expect(matchProviderBrand("poetry")).toBeNull();
  });

  it("matches comfy only through the ComfyUI product name", () => {
    expect(matchProviderBrand("ComfyUI")).toBe("comfy");
    expect(matchProviderBrand("comfyui cloud")).toBe("comfy");
    expect(matchProviderBrand("Comfy Cloud")).toBeNull();
    expect(matchProviderBrand("Comfy")).toBeNull();
  });

  it("maps Abacus.AI, CrofAI, and CrossModel names to their own marks", () => {
    expect(matchProviderBrand("Abacus")).toBe("abacus");
    expect(matchProviderBrand("Abacus AI")).toBe("abacus");
    expect(matchProviderBrand("abacus.ai 中转")).toBe("abacus");
    expect(matchProviderBrand("Crof")).toBe("crof");
    expect(matchProviderBrand("CrofAI")).toBe("crof");
    expect(matchProviderBrand("crof-ai relay")).toBe("crof");
    expect(matchProviderBrand("CrossModel")).toBe("crossmodel");
    expect(matchProviderBrand("crossmodel.ai")).toBe("crossmodel");
    expect(matchProviderBrand("My CrossModel gateway")).toBe("crossmodel");
  });

  it("keeps near-miss names off the new rules", () => {
    expect(matchProviderBrand("Abaqus")).toBeNull();
    expect(matchProviderBrand("Mycroft")).toBeNull();
    expect(matchProviderBrand("Croft Analytics")).toBeNull();
    expect(matchProviderBrand("Microfono")).toBeNull();
    expect(matchProviderBrand("microfoon")).toBeNull();
    expect(matchProviderBrand("cross-model evaluation")).toBeNull();
    expect(matchProviderBrand("Cross Model Relay")).toBeNull();
  });

  it("leaves the generic LLM Proxy mark picker-only", () => {
    expect(matchProviderBrand("LLM Proxy")).toBeNull();
    expect(matchProviderBrand("LLM-API-Key-Proxy")).toBeNull();
    expect(matchProviderBrand("My LLM proxy")).toBeNull();
    const labels = new Map(PROVIDER_BRAND_ICONS.map((entry) => [entry.icon, entry.label]));
    expect(labels.get("llmproxy")).toBe("LLM Proxy");
  });

  it("matches Chinese brand names and leaves other Chinese names alone", () => {
    expect(matchProviderBrand("阿里云通义千问")).toBe("alibaba");
    expect(matchProviderBrand("豆包")).toBe("doubao");
    expect(matchProviderBrand("智谱清言")).toBe("zai");
    expect(matchProviderBrand("腾讯混元")).toBe("tencent");
    expect(matchProviderBrand("我的私人助手")).toBeNull();
  });

  it("returns null for empty or blank names", () => {
    expect(matchProviderBrand("")).toBeNull();
    expect(matchProviderBrand("   ")).toBeNull();
    expect(matchProviderBrand("\t\n")).toBeNull();
  });
});

describe("provider brand icon inventory", () => {
  it("covers every bundled provider icon asset exactly once", () => {
    expect(assetIcons.length).toBeGreaterThan(0);
    expect(PROVIDER_BRAND_ICONS.map((entry) => entry.icon).toSorted()).toEqual(assetIcons);
  });

  it("gives every rule an existing asset, a non-empty label, and a pattern", () => {
    const assets = new Set(assetIcons);
    for (const rule of PROVIDER_BRAND_RULES) {
      expect(assets.has(rule.icon), rule.icon).toBe(true);
      expect(rule.label.trim(), rule.icon).not.toBe("");
      expect(rule.pattern, rule.icon).toBeInstanceOf(RegExp);
    }
  });

  it("gives every picker entry a readable label", () => {
    for (const entry of PROVIDER_BRAND_ICONS) {
      expect(entry.label.trim(), entry.icon).not.toBe("");
    }
  });

  it("keeps agent and media marks selectable but never name-matched", () => {
    expect(matchProviderBrand("Cursor")).toBeNull();
    const labels = new Map(PROVIDER_BRAND_ICONS.map((entry) => [entry.icon, entry.label]));
    expect(labels.get("cursor")).toBeTruthy();
    expect(labels.get("comfy")).toBeTruthy();
  });
});

describe("provider brand draft edits", () => {
  it("writes the matched icon for an automatic provider name", () => {
    const draft = Object.freeze({ displayName: "OpenAI", baseUrl: "https://example.test/v1" });
    const update = applyProviderNameIcon(draft, "OpenAI");
    expect(update.changed).toBe(true);
    expect(update.changedFields).toEqual(["icon"]);
    expect(update.draft).toEqual({
      displayName: "OpenAI",
      baseUrl: "https://example.test/v1",
      icon: "codex",
    });
    expect(update.draft).not.toBe(draft);
    expect(draft).not.toHaveProperty("icon");
  });

  it("removes an automatic icon when the new name matches nothing", () => {
    const update = applyProviderNameIcon(
      { displayName: "Custom Relay", icon: "codex" },
      "Custom Relay",
    );
    expect(update.changed).toBe(true);
    expect(update.draft).not.toHaveProperty("icon");
  });

  it("reports no change when the automatic result is unchanged", () => {
    const update = applyProviderNameIcon({ displayName: "OpenAI", icon: "codex" }, "OpenAI GPT");
    expect(update.changed).toBe(false);
    expect(update.draft.icon).toBe("codex");
  });

  it("leaves manual choices, including manual removal, untouched on rename", () => {
    for (const draft of [
      { displayName: "OpenAI", icon: "mistral", iconManual: true },
      { displayName: "OpenAI", iconManual: true },
    ]) {
      const update = applyProviderNameIcon(draft, "Anthropic");
      expect(update.changed).toBe(false);
      expect(update.draft).toEqual(draft);
      expect(update.draft).not.toBe(draft);
    }
  });

  it("applies the icon, auto, and none picker choices", () => {
    const manual = applyProviderIconChoice(
      { displayName: "OpenAI" },
      { kind: "icon", icon: "mistral" },
    );
    expect(manual.draft).toEqual({ displayName: "OpenAI", icon: "mistral", iconManual: true });
    expect(manual.changedFields).toEqual(["icon", "iconManual"]);

    const auto = applyProviderIconChoice(
      { displayName: "Anthropic", icon: "mistral", iconManual: true },
      { kind: "auto" },
    );
    expect(auto.draft).toEqual({ displayName: "Anthropic", icon: "claude" });
    expect(auto.changedFields).toEqual(["icon", "iconManual"]);

    const none = applyProviderIconChoice(
      { displayName: "Anthropic", icon: "claude" },
      { kind: "none" },
    );
    expect(none.draft).toEqual({ displayName: "Anthropic", iconManual: true });
    expect(none.draft).not.toHaveProperty("icon");
    expect(none.changedFields).toEqual(["icon", "iconManual"]);
  });

  it("drops the icon when auto finds no match for the committed name", () => {
    const update = applyProviderIconChoice(
      { displayName: "My Internal Relay", icon: "codex" },
      { kind: "auto" },
    );
    expect(update.draft).toEqual({ displayName: "My Internal Relay" });
    expect(update.changed).toBe(true);
  });
});
