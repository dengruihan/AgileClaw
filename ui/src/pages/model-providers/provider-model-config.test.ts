// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  modelReferences,
  providerConnectionPatch,
  refreshProviderModels,
} from "./provider-model-config.ts";

describe("provider draft model refresh", () => {
  it("replaces discovered rows while manual rows win collisions at the same effective URL", () => {
    const current = [
      { id: "removed", name: "Old discovery", metadataSource: "provider-discovery" },
      { id: "same", name: "My edit", metadataSource: "models-add" },
      { id: "local", name: "Manual model" },
      { id: "same", name: "Other endpoint", baseUrl: "https://other.example.test/v1" },
    ];
    expect(
      refreshProviderModels(
        current,
        [
          { id: "same", name: "Remote default" },
          { id: "new", name: "New model" },
          { id: "new", name: "New model" },
        ],
        "https://models.example.test/v1/",
      ),
    ).toEqual([
      current[1],
      { id: "new", name: "New model", metadataSource: "provider-discovery" },
      current[2],
      current[3],
    ]);
    expect(current[0]?.id).toBe("removed");
  });
  it("finds selected and allowlisted references without confusing profile or version suffixes", () => {
    expect(
      modelReferences(
        {
          agents: {
            defaults: {
              model: {
                primary: "custom/model@work",
                fallbacks: ["custom/model-extra", "custom/model@20260930"],
              },
              models: { "custom/model": { alias: "selected" } },
            },
            list: [{ id: "research", utilityModel: "custom/model" }],
          },
          models: { providers: { custom: { models: [{ id: "model", name: "custom/model" }] } } },
        },
        "custom",
        "model",
      ),
    ).toEqual([
      "agents.defaults.model.primary",
      'agents.defaults.models["custom/model"]',
      "agents.list[0].utilityModel",
    ]);
  });
});

describe("provider connection edits", () => {
  it("removes nested headers and replaces shortened arrays without rewriting untouched siblings", () => {
    const original = {
      baseUrl: "http://localhost:11434",
      headers: { "X-Remove": "old", "X-Keep": "keep" },
      request: { retries: { statuses: [429, 503] }, timeoutMs: 5000 },
    };
    const patch = providerConnectionPatch(
      original,
      {
        ...original,
        headers: { "X-Keep": "keep" },
        request: { ...original.request, retries: { statuses: [429] } },
      },
      new Set(["headers", "request"]),
      "custom.proxy",
    );
    expect(patch).toEqual({
      raw: {
        models: {
          providers: {
            "custom.proxy": {
              headers: { "X-Remove": null },
              request: { retries: { statuses: [429] } },
            },
          },
        },
      },
      replacePaths: ["models.providers.custom.proxy.request.retries.statuses"],
    });
    expect(
      applyMergePatch(
        {
          models: {
            providers: {
              "custom.proxy": {
                ...original,
                headers: { ...original.headers, "X-Keep": "updated elsewhere" },
                request: { ...original.request, timeoutMs: 10000 },
              },
            },
          },
        },
        patch.raw,
        { mergeObjectArraysById: true, replaceArrayPaths: new Set(patch.replacePaths) },
      ),
    ).toEqual({
      models: {
        providers: {
          "custom.proxy": {
            baseUrl: original.baseUrl,
            headers: { "X-Keep": "updated elsewhere" },
            request: { retries: { statuses: [429] }, timeoutMs: 10000 },
          },
        },
      },
    });
  });
});
