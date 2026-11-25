// @vitest-environment node
// Control UI tests cover chat model select state behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import { registerProviderIconConfigSource } from "../provider-icon-source.ts";
import {
  resolveChatModelUnavailableReason,
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  const sessionsResult =
    params.sessionsResult ?? createSessionsListResult({ model: null, modelProvider: null });
  return {
    activeSession: params.activeSession ?? sessionsResult.sessions[0],
    sessionKey: "main",
    modelOverrides: {},
    chatModelCatalog: [],
    sessionsResult,
    ...params,
  };
}

describe("chat-model-select-state", () => {
  it.each([
    { reason: "missing-auth", expected: "missing-auth" },
    { reason: "auth-failed", expected: "auth-failed" },
    { reason: "cooldown", expected: "cooldown" },
    { reason: undefined, expected: undefined },
  ] as const)("preserves the recorded $reason availability reason", ({ reason, expected }) => {
    const catalog = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: reason,
      },
    ];
    expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    expect(resolveChatModelUnavailableReason("other-model", "openai", catalog)).toBeUndefined();
  });

  it.each([
    { available: true, reason: undefined, expected: undefined },
    { available: undefined, reason: undefined, expected: undefined },
    { available: false, reason: undefined, expected: undefined },
    { available: false, reason: "cooldown", expected: "cooldown" },
    { available: false, reason: "missing-auth", expected: "auth-failed" },
  ] as const)(
    "does not let an auth-failed alias override a $reason/$available route",
    ({ available, reason, expected }) => {
      const catalog = [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "codex",
          available: false,
          unavailableReason: "auth-failed" as const,
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available,
          unavailableReason: reason,
        },
      ];
      expect(resolveChatModelUnavailableReason("gpt-5.6-luna", "openai", catalog)).toBe(expected);
    },
  );

  it("finds the active row across the legacy main alias window", () => {
    // Pre-hello (or legacy-alias) states select "main" while the row list
    // already carries the canonical agent:main:main key; a strict compare
    // missed the row and the picker fell back to the agent default.
    const sessionsResult = createSessionsListResult({
      model: "gpt-5.3-codex",
      modelProvider: "openai",
    });
    const session = expectDefined(sessionsResult.sessions[0], "alias fixture row");
    sessionsResult.sessions[0] = { ...session, key: "agent:main:main" };
    const value = resolveChatModelOverrideValue(
      createChatModelState({
        chatModelCatalog: DEFAULT_CHAT_MODEL_CATALOG,
        sessionsResult,
      }),
    );
    expect(value).toBe("openai/gpt-5.3-codex");
  });

  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("normalizes cached bare overrides to the matching catalog option", () => {
    const state = createChatModelState({
      modelOverrides: { main: "gpt-5-mini" },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("prefers catalog provider matches over stale session providers", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    });

    expect(resolveChatModelSelectState(state).currentOverride).toBe("deepseek/deepseek-chat");
  });

  it("keeps the active model value but does not synthesize a picker option when the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([]);
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("lists authored models with the selection and default retained when custom refs filter", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
        { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
        { id: "glm-5.3", name: "GLM-5.3", provider: "zai" },
      ),
      customModelRefs: new Set(["zai/glm-5.3"]),
      sessionsResult: createSessionsListResult({
        model: "gpt-5",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    // The authored zai entry lists; the catalog-only selection and default stay
    // visible so an in-use catalog model never disappears mid-session.
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "zai/glm-5.3", label: "GLM-5.3" },
    ]);
    expect(resolved.currentOverride).toBe("openai/gpt-5");
    expect(resolved.defaultModel).toBe("openai/gpt-5");
  });

  it("keeps configured unavailable catalog entries visible but disabled", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5.5", label: "GPT-5.5" },
      {
        value: "codex/gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        disabled: true,
      },
    ]);
  });

  it("keeps the configured model order instead of ranking available entries first", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "zeta",
          name: "Zeta",
          provider: "fixture",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "alpha",
          name: "Alpha",
          provider: "fixture",
          available: true,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "alpha",
        modelProvider: "fixture",
        defaultsModel: "alpha",
        defaultsProvider: "fixture",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options).toEqual([
      {
        value: "fixture/zeta",
        label: "Zeta",
        disabled: true,
        unavailableReason: "missing-auth",
      },
      { value: "fixture/alpha", label: "Alpha" },
    ]);
  });

  it.each([
    {
      name: "available",
      available: true,
      options: [{ value: "openai/gpt-5.5", label: "GPT-5.5" }],
    },
    {
      name: "indeterminate",
      available: undefined,
      options: [{ value: "openai/gpt-5.5", label: "GPT-5.5" }],
    },
    {
      name: "all-cold",
      available: false,
      options: [
        { value: "openai/gpt-5.5", label: "GPT-5.5 · OpenAI", disabled: true },
        { value: "codex/gpt-5.5", label: "GPT-5.5 · Codex", disabled: true },
      ],
    },
  ])(
    "preserves $name route labels and options beside a cold legacy alias",
    ({ available, options }) => {
      const state = createChatModelState({
        chatModelCatalog: createModelCatalog(
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            available,
          },
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "codex",
            available: false,
          },
        ),
        sessionsResult: createSessionsListResult({
          model: "gpt-5.5",
          modelProvider: "codex",
          defaultsModel: "gpt-5.5",
          defaultsProvider: "codex",
        }),
      });

      const resolved = resolveChatModelSelectState(state);
      expect(resolved.currentOverride).toBe("openai/gpt-5.5");
      expect(resolved.defaultModel).toBe("openai/gpt-5.5");
      expect(resolved.options).toEqual(options);
    },
  );

  it("preserves an exact available OpenAI route when a legacy route is also available", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          provider: "codex",
          available: true,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "openai",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.5");
    expect(resolved.defaultModel).toBe("openai/gpt-5.5");
  });

  it("keeps an all-cold default identity visible as a disabled option", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          provider: "openai",
          available: false,
          unavailableReason: "missing-auth",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolveChatModelUnavailableReason("gpt-5.6-sol", "openai", state.chatModelCatalog)).toBe(
      "missing-auth",
    );
    expect(resolved.options).toEqual([
      {
        value: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        disabled: true,
        unavailableReason: "missing-auth",
      },
      {
        value: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        disabled: true,
        unavailableReason: "missing-auth",
      },
    ]);
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog({
        id: "moonshotai/kimi-k2.5",
        alias: "Kimi K2.5 (NVIDIA)",
        name: "Kimi K2.5 (NVIDIA)",
        provider: "nvidia",
      }),
      sessionsResult: createSessionsListResult({
        model: "moonshotai/kimi-k2.5",
        modelProvider: "nvidia",
        defaultsModel: "moonshotai/kimi-k2.5",
        defaultsProvider: "nvidia",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toEqual([
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("keeps versioned catalog names visible for configured family aliases", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-opus-4-8",
          alias: "opus",
          name: "Opus 4.8",
          provider: "anthropic",
        },
        {
          id: "claude-sonnet-5",
          alias: "sonnet",
          name: "Sonnet 5",
          provider: "anthropic",
        },
        {
          id: "moonshotai/kimi-k2.5",
          alias: "Kimi K2.5 (NVIDIA)",
          name: "Kimi K2.5",
          provider: "nvidia",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-opus-4-8",
        modelProvider: "anthropic",
        defaultsModel: "claude-opus-4-8",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (Opus 4.8 · opus)");
    expect(resolved.options).toEqual([
      { value: "anthropic/claude-opus-4-8", label: "Opus 4.8 · opus" },
      { value: "anthropic/claude-sonnet-5", label: "Sonnet 5 · sonnet" },
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("uses the active agent model for the default label", () => {
    const state = createChatModelState({
      agentDefaultModel: "anthropic/claude-opus-4-5",
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
        },
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        model: "claude-opus-4-5",
        modelProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("anthropic/claude-opus-4-5");
    expect(resolved.defaultLabel).toBe("Default (Claude Opus 4.5)");
  });

  it("keeps a canonical agent default as one named picker option", () => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.defaultLabel).toBe("Default (GPT-5.6 Sol)");
    expect(resolved.options).toEqual([{ value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" }]);
  });

  // The session model equals the agent default in every case, so anything other than
  // the recorded marker would have to guess — and would always guess "inherited".
  it.each([
    { name: "inherited default", source: null, expected: null },
    { name: "user pin the default grew into", source: "user" as const, expected: "user" },
    { name: "automatic fallback", source: "auto" as const, expected: "auto" },
  ])("resolves $expected from provenance for $name", ({ source, expected }) => {
    const state = createChatModelState({
      agentDefaultModel: "openai/gpt-5.6-sol",
      chatModelCatalog: createModelCatalog({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
      }),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        modelOverrideSource: source,
        defaultsModel: "gpt-5.6-sol",
        defaultsProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.6-sol");
    expect(resolved.modelOverrideSource).toBe(expected);
  });

  it("reads pin provenance from a canonical main row when the route uses the alias key", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user",
      }),
    });
    // Route key stays the `main` alias while the Gateway reports the canonical row.
    expectDefined(state.sessionsResult?.sessions[0], "main session row").key = "agent:main:main";

    const resolved = resolveChatModelSelectState(state);

    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.modelOverrideSource).toBe("user");
  });

  // `currentOverride` already lets a pending local selection outrank the row, so
  // provenance has to follow it — otherwise the picker would report a model and an
  // origin belonging to two different points in time.
  it("keeps provenance and the effective model on the same in-flight selection", () => {
    const pendingPin = createChatModelState({
      modelOverrides: { main: "openai/gpt-5-mini" },
      sessionsResult: createSessionsListResult({
        model: "gpt-5",
        modelProvider: "openai",
        modelOverrideSource: null,
      }),
    });

    expect(resolveChatModelSelectState(pendingPin).currentOverride).toBe("openai/gpt-5-mini");
    expect(resolveChatModelSelectState(pendingPin).modelOverrideSource).toBe("user");

    const pendingReset = {
      ...pendingPin,
      modelOverrides: { main: null },
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
        modelOverrideSource: "user" as const,
      }),
    };

    expect(resolveChatModelSelectState(pendingReset).currentOverride).toBe("");
    expect(resolveChatModelSelectState(pendingReset).modelOverrideSource).toBeNull();
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · OpenRouter)");
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · Anthropic",
      },
      {
        value: "openrouter/claude-3-7-sonnet",
        label: "Claude Sonnet · OpenRouter",
      },
    ]);
  });

  it("suffixes a duplicate model name with the configured provider name", () => {
    onTestFinished(
      registerProviderIconConfigSource(() => ({
        models: { providers: { "custom-relay-eu-west-1-acme": { displayName: "Acme Relay" } } },
      })),
    );
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "custom-relay-eu-west-1-acme",
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.5",
        modelProvider: "custom-relay-eu-west-1-acme",
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options).toEqual([
      {
        value: "custom-relay-eu-west-1-acme/gpt-5.5",
        label: "GPT-5.5 · Acme Relay",
      },
      { value: "openrouter/gpt-5.5", label: "GPT-5.5 · OpenRouter" },
    ]);
    expect(resolved.defaultLabel).toBe("Default (GPT-5.5 · OpenRouter)");
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet-thinking",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      },
      {
        value: "anthropic/claude-3-7-sonnet-thinking",
        label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      },
    ]);
  });
});
