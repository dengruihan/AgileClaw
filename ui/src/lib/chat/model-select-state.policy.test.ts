// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { resolveChatModelSelectState } from "./model-select-state.ts";

describe("chat-model-select-state", () => {
  it("labels an automatic default without offering it as a choice", () => {
    const catalog = [
      {
        id: "automatic",
        name: "Automatic model",
        provider: "anthropic",
        manualSelectionAllowed: false,
      },
      { id: "manual", name: "Manual model", provider: "anthropic", manualSelectionAllowed: true },
      { id: "legacy", name: "Older server model", provider: "anthropic" },
    ];
    const sessionsResult = createSessionsListResult({
      model: "automatic",
      modelProvider: "anthropic",
      defaultsModel: "automatic",
      defaultsProvider: "anthropic",
    });
    const selection = resolveChatModelSelectState({
      activeSession: sessionsResult.sessions[0],
      sessionKey: "main",
      modelOverrides: {},
      chatModelCatalog: catalog,
      sessionsResult,
    });
    expect(selection.options.map((option) => option.value)).toEqual([
      "anthropic/manual",
      "anthropic/legacy",
    ]);
    expect(selection.defaultLabel).toContain("Automatic model");
  });
});
