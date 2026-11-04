import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ModelsAuthSetApiKeyParams,
  type ModelsAuthSetApiKeyResult,
  type ModelsAuthInspectApiKeyParams,
  type ModelsAuthInspectApiKeyResult,
  validateModelsAuthInspectApiKeyParams,
  validateModelsAuthInspectApiKeyResult,
  validateModelsAuthSetApiKeyParams,
  validateModelsAuthSetApiKeyResult,
} from "./index.js";
import { ProtocolSchemas } from "./schema.js";

describe("public models.authSetApiKey contract", () => {
  it("accepts existing wire fields and ignores request extensions", () => {
    const request = { provider: " Fixture ", apiKey: " synthetic-key " };
    expectTypeOf(request).toExtend<ModelsAuthSetApiKeyParams>();
    for (const agentId of [undefined, "", "writer"]) {
      expect(validateModelsAuthSetApiKeyParams({ ...request, agentId, futureField: true })).toBe(
        true,
      );
    }
    expect(ProtocolSchemas.ModelsAuthSetApiKeyParams).toBeDefined();
    expect(ProtocolSchemas.ModelsAuthSetApiKeyResult).toBeDefined();
  });

  it.each([
    {},
    { provider: "fixture" },
    { provider: 1, apiKey: "key" },
    { provider: " ", apiKey: "key" },
    { provider: "fixture", apiKey: false },
    { provider: "fixture", apiKey: "\n\t" },
    { provider: "fixture", apiKey: "key", agentId: null },
  ])("rejects malformed request %j", (request) => {
    expect(validateModelsAuthSetApiKeyParams(request)).toBe(false);
  });

  it("describes saved keys with and without a refresh warning", () => {
    const result = { provider: "fixture", profileId: "fixture:manual" };
    expectTypeOf(result).toExtend<ModelsAuthSetApiKeyResult>();
    expect(validateModelsAuthSetApiKeyResult(result)).toBe(true);
    expect(validateModelsAuthSetApiKeyResult({ ...result, warning: "Restart to apply." })).toBe(
      true,
    );
    expect(validateModelsAuthSetApiKeyResult({ provider: "fixture" })).toBe(false);
    expect(validateModelsAuthSetApiKeyResult({ ...result, warning: false })).toBe(false);
  });
});

describe("public models.authInspectApiKey contract", () => {
  it("registers a closed, revision-bound inspection request", () => {
    const request = { provider: "fixture", baseHash: "config-hash", reveal: true };
    expectTypeOf(request).toExtend<ModelsAuthInspectApiKeyParams>();
    expect(validateModelsAuthInspectApiKeyParams(request)).toBe(true);
    expect(validateModelsAuthInspectApiKeyParams({ ...request, agentId: "writer" })).toBe(true);
    expect(ProtocolSchemas.ModelsAuthInspectApiKeyParams).toBeDefined();
    expect(ProtocolSchemas.ModelsAuthInspectApiKeyResult).toBeDefined();
    for (const malformed of [
      {},
      { ...request, baseHash: "" },
      { ...request, provider: " " },
      { ...request, reveal: "yes" },
      { ...request, futureField: true },
    ]) {
      expect(validateModelsAuthInspectApiKeyParams(malformed)).toBe(false);
    }
  });

  it("validates hidden and revealed results for every disclosed source", () => {
    const result = {
      provider: "fixture",
      agentId: "main",
      baseHash: "config-hash",
      configured: true,
      source: "profile",
    } satisfies ModelsAuthInspectApiKeyResult;
    for (const source of [
      "literal",
      "profile",
      "environment",
      "reference",
      "none",
      "unsupported",
    ]) {
      expect(validateModelsAuthInspectApiKeyResult({ ...result, source })).toBe(true);
    }
    expect(validateModelsAuthInspectApiKeyResult({ ...result, key: "synthetic-key" })).toBe(true);
    expect(validateModelsAuthInspectApiKeyResult({ ...result, profileId: "fixture:manual" })).toBe(
      true,
    );
    expect(validateModelsAuthInspectApiKeyResult({ ...result, source: "unknown" })).toBe(false);
    expect(validateModelsAuthInspectApiKeyResult({ ...result, key: 42 })).toBe(false);
    expect(validateModelsAuthInspectApiKeyResult({ ...result, futureField: true })).toBe(false);
  });
});
