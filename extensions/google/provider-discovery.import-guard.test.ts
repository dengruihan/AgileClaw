import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", () => {
  throw new Error("Static Google discovery must not load live catalog runtime");
});
vi.mock("./provider-models.js", () => {
  throw new Error("Static Google discovery must not load runtime model resolution");
});
vi.mock("./vertex-adc.js", () => {
  throw new Error("Static Google discovery must not load token refresh runtime");
});

describe("Google provider discovery entry", () => {
  it("publishes Studio metadata without live catalog or token runtime", async () => {
    const { default: provider } = await import("./provider-discovery.js");
    const ctx: ProviderCatalogContext = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await provider.staticCatalog?.run(ctx);
    if (!result || !("providers" in result)) {
      throw new Error("expected Google static provider catalogs");
    }
    const studio = result.providers.google;
    expect(studio?.api).toBe("google-generative-ai");
    expect(studio?.models.length).toBeGreaterThan(0);
    expect(studio?.models[0]?.input).toContain("video");
    expect(provider.resolveConfigApiKey?.({ provider: "google-vertex", env: {} })).toBeUndefined();
  });
});
