import { afterEach, describe, expect, it, vi } from "vitest";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import * as modelsConfigProviders from "./models-config.providers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("models-config planning", () => {
  it("treats an empty saved provider set as authoritative", async () => {
    const discovery = vi
      .spyOn(modelsConfigProviders, "resolveImplicitProviders")
      .mockResolvedValue({});
    const existingParsed = { providers: { stale: {} } };
    const plan = await planModelsJsonForTest({
      cfg: { models: { providers: {} } },
      agentDir: "/tmp/openclaw-models-config-env-vars-test",
      env: {},
      existingRaw: JSON.stringify(existingParsed),
      existingParsed,
    });
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed: { providers: Record<string, ProviderConfig> } = JSON.parse(plan.contents);
    expect(discovery).not.toHaveBeenCalled();
    expect(parsed.providers).toEqual({});
    expect(plan.pluginCatalogWrites).toEqual({});
  });
});
