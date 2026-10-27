import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  formatThinkingCommandOptionsForSession,
  isThinkingLevelOptionForSession,
  resolveChatThinkingSelectState,
  resolveCurrentThinkingLevel,
  resolvePendingModelThinkingTarget,
  resolveThinkingCommandArgOptionsForSession,
  resolveThinkingLevelInput,
} from "./thinking.ts";

describe("chat thinking helpers", () => {
  it("keeps an explicitly empty session profile and its saved override", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [
        {
          id: "model",
          provider: "openai",
          name: "Model",
          thinkingLevels: [{ id: "high", label: "High" }],
          thinkingDefault: "high",
        },
      ],
      session: {
        model: "model",
        modelProvider: "openai",
        thinkingLevels: [],
        thinkingLevel: "off",
      },
      sessionKey: "main",
      sessionsResult: null,
    });
    expect(state.options).toEqual([]);
    expect(state.inherited.value).toBe("");
    expect(state.selection).toMatchObject({ source: "override", value: "off" });
  });

  it("does not combine a session model with another provider from defaults", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [
        {
          id: "model",
          provider: "openai",
          name: "Model",
          thinkingLevels: [{ id: "high", label: "High" }],
          thinkingDefault: "high",
        },
      ],
      session: { model: "model" },
      defaults: { model: "other", modelProvider: "openai", contextTokens: null },
      sessionKey: "main",
      sessionsResult: null,
    });
    expect(state.options).toEqual([]);
    expect(state.inherited.value).toBe("");
  });

  it("reports unknown capability without inventing thinking choices or a default", () => {
    const session = { modelProvider: "thinking-fixture", model: "unpublished" };
    const state = resolveChatThinkingSelectState({
      catalog: [],
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect(state.options).toEqual([]);
    expect(state.inherited.value).toBe("");
    expect(resolveCurrentThinkingLevel(session, undefined, [])).toBe("Unknown");
    expect(formatThinkingCommandOptionsForSession(session, undefined, [])).toBe("Unknown");
    expect(isThinkingLevelOptionForSession(session, undefined, "high")).toBeUndefined();
  });

  it("keeps the selected empty profile distinct from an inherited profile", () => {
    const session = {
      modelProvider: "thinking-fixture",
      model: "no-effort",
      thinkingLevels: [],
    };
    const defaults = {
      modelProvider: session.modelProvider,
      model: session.model,
      contextTokens: null,
      thinkingLevels: [{ id: "high", label: "High" }],
      thinkingDefault: "high",
    };
    const state = resolveChatThinkingSelectState({
      catalog: [],
      defaults,
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect(state.options).toEqual([]);
    expect(state.inherited.value).toBe("");
    expect(resolveCurrentThinkingLevel(session, defaults, [])).toBe("Unknown");
    expect(formatThinkingCommandOptionsForSession(session, defaults, [])).toBe("none");
    expect(isThinkingLevelOptionForSession(session, defaults, "high")).toBe(false);
  });

  it("keeps a ready empty thinking profile empty for the selected model", () => {
    const model: ModelCatalogEntry = {
      provider: "metadata-fixture",
      id: "no-effort",
      name: "No selectable effort",
      reasoning: true,
      agentRuntime: { id: "openclaw", source: "model" },
      thinkingLevels: [],
    };
    const session = {
      modelProvider: model.provider,
      model: model.id,
      agentRuntime: model.agentRuntime,
      thinkingLevels: model.thinkingLevels,
      thinkingOptions: [],
    };
    const state = resolveChatThinkingSelectState({
      catalog: [model],
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect({
      options: state.options.map((option) => option.value),
      acceptsHigh: isThinkingLevelOptionForSession(session, undefined, "high", [model]),
      inherited: state.inherited.value,
    }).toEqual({ options: [], acceptsHigh: false, inherited: "" });
    expect(formatThinkingCommandOptionsForSession(session, undefined, [model])).toBe("none");
    expect(resolveThinkingCommandArgOptionsForSession(session, undefined, [model])).toEqual([]);
  });

  it.each(["catalog", "defaults", "session labels", "default labels"] as const)(
    "preserves explicitly empty %s metadata",
    (source) => {
      const model: ModelCatalogEntry = {
        provider: "metadata-fixture",
        id: "no-effort",
        name: "No selectable effort",
        reasoning: true,
        agentRuntime: { id: "openclaw", source: "model" },
        ...(source === "catalog" ? { thinkingLevels: [] } : {}),
      };
      const session = {
        modelProvider: model.provider,
        model: model.id,
        agentRuntime: model.agentRuntime,
        ...(source === "session labels" ? { thinkingOptions: [] } : {}),
      };
      const defaults = {
        modelProvider: model.provider,
        model: model.id,
        agentRuntime: model.agentRuntime,
        contextTokens: null,
        ...(source === "defaults" ? { thinkingLevels: [] } : {}),
        ...(source === "default labels" ? { thinkingOptions: [] } : {}),
      };
      const state = resolveChatThinkingSelectState({
        catalog: [model],
        defaults,
        session,
        sessionKey: "agent:main:main",
        sessionsResult: null,
      });

      expect(state.options).toEqual([]);
      expect(isThinkingLevelOptionForSession(session, defaults, "high", [model])).toBe(false);
    },
  );

  it("keeps non-reasoning Off-only metadata distinct from an empty profile", () => {
    const model: ModelCatalogEntry = {
      provider: "metadata-fixture",
      id: "plain",
      name: "Plain model",
      reasoning: false,
      thinkingLevels: [{ id: "off", label: "off" }],
      thinkingDefault: "off",
    };
    const session = { modelProvider: model.provider, model: model.id, thinkingLevel: "off" };
    const state = resolveChatThinkingSelectState({
      catalog: [model],
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect(state.options).toEqual([]);
    expect(state.selection).toMatchObject({ source: "default", value: "off" });
    expect(isThinkingLevelOptionForSession(session, undefined, "off", [model])).toBe(true);
    expect(isThinkingLevelOptionForSession(session, undefined, "high", [model])).toBe(false);
  });

  const lunaModel: ModelCatalogEntry = {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    reasoning: true,
    agentRuntime: { id: "openclaw", source: "model" },
    thinkingLevels: [
      { id: "max", label: "max" },
      { id: "ultra", label: "ultra" },
    ],
    thinkingDefault: "ultra",
  };

  it("normalizes canonical Ultra command input", () => {
    expect(
      resolveThinkingLevelInput(
        "ultra",
        {
          thinkingLevels: [{ id: "ultra", label: "Ultra" }],
        },
        undefined,
      ),
    ).toBe("ultra");
  });

  it("does not promote an unsupported persisted Ultra override into a slider stop", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [],
      sessionKey: "agent:main:main",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            thinkingLevel: "ultra",
            thinkingLevels: [{ id: "max", label: "max" }],
          },
        ],
      },
    });

    expect(state.selection).toEqual({
      kind: "unanchored",
      source: "override",
      value: "ultra",
      displayLabel: "Ultra",
    });
    expect(state.options.map((option) => option.value)).toEqual(["max"]);
  });

  it.each([false, true])(
    "does not inherit same-model thinking metadata from a different runtime (catalog: %s)",
    (includeCatalog) => {
      const state = resolveChatThinkingSelectState({
        catalog: includeCatalog ? [lunaModel] : [],
        sessionKey: "agent:main:main",
        sessionsResult: {
          ts: 1,
          path: "",
          count: 1,
          defaults: {
            modelProvider: "openai",
            model: "gpt-5.6-luna",
            contextTokens: null,
            agentRuntime: { id: "openclaw", source: "model" },
            thinkingLevels: lunaModel.thinkingLevels,
            thinkingDefault: lunaModel.thinkingDefault,
          },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              modelProvider: "openai",
              model: "gpt-5.6-luna",
              agentRuntime: { id: "codex", source: "session-key" },
            },
          ],
        },
      });

      expect(state.options.map((option) => option.value)).not.toContain("ultra");
      expect(state.inherited.value).not.toBe("ultra");
    },
  );

  it.each([
    { sessionRuntime: "openclaw", catalogRuntime: "openclaw" },
    { sessionRuntime: undefined, catalogRuntime: "openclaw" },
    { sessionRuntime: "codex", catalogRuntime: undefined },
  ])(
    "inherits catalog thinking metadata when runtimes do not conflict ($sessionRuntime / $catalogRuntime)",
    ({ sessionRuntime, catalogRuntime }) => {
      const state = resolveChatThinkingSelectState({
        catalog: [
          {
            ...lunaModel,
            agentRuntime: catalogRuntime ? { id: catalogRuntime, source: "model" } : undefined,
          },
        ],
        sessionKey: "agent:main:main",
        session: {
          modelProvider: "openai",
          model: "gpt-5.6-luna",
          agentRuntime: sessionRuntime ? { id: sessionRuntime, source: "session-key" } : undefined,
        },
        sessionsResult: null,
      });

      expect(state.options.map((option) => option.value)).toEqual(["max", "ultra"]);
      expect(state.inherited.value).toBe("ultra");
    },
  );
});

describe("pending model thinking targets", () => {
  const row = {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    thinkingLevels: [
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ],
    thinkingLevel: "high",
  };
  const pendingCatalog: ModelCatalogEntry[] = [
    {
      id: "claude-opus",
      name: "Claude Opus",
      provider: "anthropic",
      thinkingLevels: [
        { id: "minimal", label: "minimal" },
        { id: "max", label: "max" },
      ],
      thinkingDefault: "max",
    },
  ];
  const selectStateBase = {
    catalog: pendingCatalog,
    sessionKey: "main",
    sessionsResult: null,
  };

  it("keeps the row authoritative without a pending selection", () => {
    const target = resolvePendingModelThinkingTarget({
      catalog: pendingCatalog,
      modelOverrides: {},
      session: row,
      sessionKey: "main",
    });
    expect(target).toBeUndefined();
  });

  it("rebases options onto the pending model's catalog levels", () => {
    const target = expectDefined(
      resolvePendingModelThinkingTarget({
        catalog: pendingCatalog,
        modelOverrides: { main: "anthropic/claude-opus" },
        session: row,
        sessionKey: "main",
      }),
    );
    expect(target.model).toBe("claude-opus");
    expect(target.modelProvider).toBe("anthropic");
    expect(resolveThinkingCommandArgOptionsForSession(target, undefined, pendingCatalog)).toEqual([
      "default",
      "minimal",
      "max",
    ]);
  });

  it("follows a null pending selection to the defaults model", () => {
    const target = expectDefined(
      resolvePendingModelThinkingTarget({
        catalog: pendingCatalog,
        defaults: { model: "claude-opus", modelProvider: "anthropic", contextTokens: null },
        modelOverrides: { main: null },
        session: row,
        sessionKey: "main",
      }),
    );
    expect(target.model).toBe("claude-opus");
    expect(resolveThinkingCommandArgOptionsForSession(target, undefined, pendingCatalog)).toEqual([
      "default",
      "minimal",
      "max",
    ]);
  });

  it("fails closed when the pending model is not in the catalog", () => {
    const target = expectDefined(
      resolvePendingModelThinkingTarget({
        catalog: pendingCatalog,
        modelOverrides: { main: "anthropic/claude-unknown" },
        session: row,
        sessionKey: "main",
      }),
    );
    expect(resolveThinkingCommandArgOptionsForSession(target, undefined, pendingCatalog)).toEqual(
      [],
    );
    expect(resolveChatThinkingSelectState({ ...selectStateBase, session: target }).options).toEqual(
      [],
    );
  });

  it("prefers a qualified pending value over a router provider's same-text deep id", () => {
    const target = expectDefined(
      resolvePendingModelThinkingTarget({
        catalog: [
          {
            id: "anthropic/claude-x",
            name: "Claude X via router",
            provider: "openrouter",
            thinkingLevels: [{ id: "router-low", label: "router-low" }],
          },
          {
            id: "claude-x",
            name: "Claude X",
            provider: "anthropic",
            thinkingLevels: [
              { id: "minimal", label: "minimal" },
              { id: "max", label: "max" },
            ],
          },
        ],
        modelOverrides: { main: "anthropic/claude-x" },
        session: row,
        sessionKey: "main",
      }),
    );
    expect(target.model).toBe("claude-x");
    expect(target.modelProvider).toBe("anthropic");
  });

  it("keeps a null pending selection on the defaults row's own thinking facts", () => {
    const defaults = {
      model: "gpt-default",
      modelProvider: "openai",
      contextTokens: null,
      thinkingLevels: [{ id: "low", label: "low" }],
      thinkingDefault: "low",
    };
    const target = expectDefined(
      resolvePendingModelThinkingTarget({
        catalog: [],
        defaults,
        modelOverrides: { main: null },
        session: row,
        sessionKey: "main",
      }),
    );
    expect(target.model).toBe("gpt-default");
    expect(target.modelProvider).toBe("openai");
    expect(resolveThinkingCommandArgOptionsForSession(target, defaults, [])).toEqual([
      "default",
      "low",
    ]);
  });
});
