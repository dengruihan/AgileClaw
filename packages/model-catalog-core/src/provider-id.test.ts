// Model Catalog Core tests cover the shared custom-provider config-key rule that
// both CLI onboarding and the Control UI claim their provider keys from.
import { describe, expect, it } from "vitest";
import {
  buildEndpointIdFromUrl,
  claimEndpointId,
  endpointIdOccupancy,
  normalizeEndpointId,
} from "./provider-id.js";

function claim(params: {
  seed: string;
  providers?: Record<string, unknown>;
  reserved?: Iterable<string>;
  reclaimSeed?: (occupiedBaseUrl: string | undefined) => boolean;
}) {
  return claimEndpointId({
    seed: params.seed,
    occupied: endpointIdOccupancy(params.providers),
    ...(params.reserved ? { isReserved: (id) => new Set(params.reserved).has(id) } : {}),
    ...(params.reclaimSeed ? { reclaimSeed: params.reclaimSeed } : {}),
  });
}

describe("normalizeEndpointId", () => {
  it("lowercases and slugs a requested key", () => {
    expect(normalizeEndpointId("My Proxy")).toBe("my-proxy");
    expect(normalizeEndpointId("  Kimi.K3  ")).toBe("kimi-k3");
  });

  it("yields nothing for a name with no ASCII letters or digits", () => {
    expect(normalizeEndpointId("公司内部模型")).toBe("");
    expect(normalizeEndpointId("///")).toBe("");
  });
});

describe("buildEndpointIdFromUrl", () => {
  it("derives the key from the endpoint host and port", () => {
    expect(buildEndpointIdFromUrl("https://models.example.test/v1")).toBe(
      "custom-models-example-test",
    );
    expect(buildEndpointIdFromUrl("http://127.0.0.1:11434/v1")).toBe("custom-127-0-0-1-11434");
  });

  it("falls back to the generic key when the URL is unusable", () => {
    expect(buildEndpointIdFromUrl("not a url")).toBe("custom");
  });
});

describe("endpointIdOccupancy", () => {
  it("reads the stored base URL per key and treats a blank one as absent", () => {
    const occupancy = endpointIdOccupancy({
      Lab: { baseUrl: "https://a.example/v1" },
      overlay: { apiKey: "synthetic" },
      blank: { baseUrl: "" },
    });
    expect([...occupancy]).toEqual([
      ["lab", "https://a.example/v1"],
      ["overlay", undefined],
      ["blank", undefined],
    ]);
  });
});

describe("claimEndpointId", () => {
  it("claims an unused key without reporting a rename", () => {
    expect(claim({ seed: "custom-lab" })).toEqual({ providerId: "custom-lab" });
  });

  it("appends the next free suffix instead of overwriting a different endpoint", () => {
    const claimed = claim({
      seed: "custom-lab",
      providers: {
        "custom-lab": { baseUrl: "https://one.example/v1" },
        "custom-lab-2": { baseUrl: "https://two.example/v1" },
      },
    });
    expect(claimed).toEqual({ providerId: "custom-lab-3", renamedFrom: "custom-lab" });
  });

  it("treats a differently cased existing key as taken", () => {
    const claimed = claim({
      seed: "custom-lab",
      providers: { "Custom-Lab": { baseUrl: "https://one.example/v1" } },
    });
    expect(claimed.providerId).toBe("custom-lab-2");
  });

  it("skips keys owned by bundled overlays and plugin capabilities", () => {
    const claimed = claim({
      seed: "custom-lab",
      reserved: ["custom-lab", "custom-lab-2"],
    });
    expect(claimed).toEqual({ providerId: "custom-lab-3", renamedFrom: "custom-lab" });
  });

  it("never reclaims a reserved key even when the caller allows reuse", () => {
    const claimed = claim({
      seed: "ollama",
      reserved: ["ollama"],
      reclaimSeed: () => true,
    });
    expect(claimed.providerId).toBe("ollama-2");
  });

  it("reuses the key for the endpoint it already serves when re-onboarding", () => {
    const reclaimSameUrl = (existing: string | undefined) =>
      !existing || existing === "https://models.example.test/v1";
    expect(
      claim({
        seed: "custom-models-example-test",
        providers: {
          "custom-models-example-test": { baseUrl: "https://models.example.test/v1" },
        },
        reclaimSeed: reclaimSameUrl,
      }),
    ).toEqual({ providerId: "custom-models-example-test" });
    // An entry with no authored endpoint (a bundled overlay) keeps its own key too.
    expect(
      claim({
        seed: "custom-models-example-test",
        providers: { "custom-models-example-test": { apiKey: "x" } },
        reclaimSeed: reclaimSameUrl,
      }),
    ).toEqual({ providerId: "custom-models-example-test" });
  });

  it("claims a fresh key for a new provider over the same endpoint", () => {
    expect(
      claim({
        seed: "custom-models-example-test",
        providers: {
          "custom-models-example-test": { baseUrl: "https://models.example.test/v1" },
        },
      }),
    ).toEqual({
      providerId: "custom-models-example-test-2",
      renamedFrom: "custom-models-example-test",
    });
  });

  it("keeps the key ASCII when only the display name is non-ASCII", () => {
    const seed = buildEndpointIdFromUrl("https://relay.example.test/v1");
    expect(normalizeEndpointId("公司内部模型") || seed).toBe("custom-relay-example-test");
    expect(claim({ seed: "公司内部模型" }).providerId).toBe("custom");
  });
});
