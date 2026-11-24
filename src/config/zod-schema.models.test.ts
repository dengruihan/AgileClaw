import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
  it("preserves a SecretRef-only bundled overlay without custom provider fields", () => {
    const apiKey = { source: "file", provider: "x", id: "/runway" };
    const parsed = ModelsConfigSchema.parse({ providers: { runway: { apiKey } } });
    expect(parsed?.providers?.runway?.apiKey).toEqual(apiKey);
  });

  it("requires the legacy bailian-token-plan owner to remain an exact custom provider", () => {
    expect(
      ModelsConfigSchema.safeParse({
        providers: { "bailian-token-plan": { timeoutSeconds: 600 } },
      }).success,
    ).toBe(false);
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "bailian-token-plan": {
            api: "anthropic-messages",
            baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
            models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts a per-model hidden flag and rejects non-boolean values", () => {
    const parsed = ModelsConfigSchema.parse({
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://custom.example/v1",
          models: [{ id: "model-a", name: "Model A", hidden: true }],
        },
      },
    });
    expect(parsed?.providers?.custom?.models?.[0]?.hidden).toBe(true);
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://custom.example/v1",
            models: [{ id: "model-a", name: "Model A", hidden: "yes" }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("persists an authored provider display name without touching its key", () => {
    const parsed = ModelsConfigSchema.parse({
      providers: {
        "custom-relay": {
          baseUrl: "https://relay.example.test/v1",
          displayName: "我的中转站",
          models: [{ id: "model-a", name: "Model A" }],
        },
      },
    });
    expect(parsed?.providers?.["custom-relay"]?.displayName).toBe("我的中转站");
    // A blank name is not a value: the field clears the leaf instead, so the
    // derived label returns.
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "custom-relay": {
            baseUrl: "https://relay.example.test/v1",
            displayName: "",
            models: [],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("preserves an authored provider icon and manual flag", () => {
    const parsed = ModelsConfigSchema.parse({
      providers: {
        "custom-relay": {
          baseUrl: "https://relay.example.test/v1",
          displayName: "Custom Relay",
          icon: "cloudflare",
          iconManual: true,
          models: [{ id: "model-a", name: "Model A" }],
        },
      },
    });
    expect(parsed?.providers?.["custom-relay"]?.icon).toBe("cloudflare");
    expect(parsed?.providers?.["custom-relay"]?.iconManual).toBe(true);
  });

  it("accepts a manual no-icon choice and rejects malformed icon ids", () => {
    // `iconManual` without `icon` records the explicit "no icon" choice.
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "custom-relay": {
            baseUrl: "https://relay.example.test/v1",
            iconManual: true,
            models: [],
          },
        },
      }).success,
    ).toBe(true);
    for (const icon of ["OpenAI", "open_ai", "", "a".repeat(33)]) {
      expect(
        ModelsConfigSchema.safeParse({
          providers: {
            "custom-relay": {
              baseUrl: "https://relay.example.test/v1",
              icon,
              models: [],
            },
          },
        }).success,
      ).toBe(false);
    }
    // Icon ids are lowercase letters, digits, and hyphens; a leading digit or
    // hyphen is valid even though every bundled asset currently starts with a letter.
    for (const icon of ["4o", "-leading", "a".repeat(32)]) {
      expect(
        ModelsConfigSchema.safeParse({
          providers: {
            "custom-relay": {
              baseUrl: "https://relay.example.test/v1",
              icon,
              models: [],
            },
          },
        }).success,
      ).toBe(true);
    }
  });

  it("accepts and preserves declared model compatibility settings", () => {
    const compat = {
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsTemperature: false,
      supportsInstructions: false,
      openRouterRouting: {
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        enforce_distillable_text: true,
        order: ["anthropic", "openai"],
        only: ["anthropic"],
        ignore: ["openai"],
        quantizations: ["fp16"],
        sort: { by: "latency", partition: null },
        max_price: { prompt: "0.5", completion: 1, image: 2, audio: 3, request: 4 },
        preferred_min_throughput: { p50: 10, p75: 20, p90: 30, p99: 40 },
        preferred_max_latency: 5,
      },
      vercelGatewayRouting: { only: ["anthropic"], order: ["anthropic", "openai"] },
      zaiToolStream: true,
      cacheControlFormat: "anthropic",
      sendSessionAffinityHeaders: true,
      sendSessionIdHeader: true,
      supportsEagerToolInputStreaming: true,
      supportsLongCacheRetention: true,
    };
    const parsed = ModelsConfigSchema.parse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, compat }],
        },
      },
    });
    expect(parsed?.providers?.["my-proxy"]?.models?.[0]?.compat).toEqual(compat);
  });
});
