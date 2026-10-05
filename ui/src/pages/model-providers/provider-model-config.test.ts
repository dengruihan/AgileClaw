// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  modelEntryHasAuthorFields,
  modelEntryHidden,
  modelEntryWithoutHidden,
  modelReferences,
  modelRemovePatch,
  modelWritePatch,
  providerConnectionPatch,
} from "./provider-model-config.ts";

describe("provider model edits", () => {
  describe("provider model hide markers", () => {
    it("detects hidden entries and authored fields beyond the hide marker", () => {
      expect(modelEntryHidden({ id: "a", name: "A", hidden: true })).toBe(true);
      expect(modelEntryHidden({ id: "a", name: "A" })).toBe(false);
      expect(modelEntryHidden(undefined)).toBe(false);
      expect(modelEntryHasAuthorFields({ id: "a", name: "A", hidden: true })).toBe(false);
      expect(modelEntryHasAuthorFields({ id: "a", name: "A", hidden: true, reasoning: true })).toBe(
        true,
      );
      expect(modelEntryHasAuthorFields({ id: "a", name: "A", metadataSource: "models-add" })).toBe(
        true,
      );
    });

    it("strips the hide marker while keeping the rest of the entry", () => {
      expect(modelEntryWithoutHidden({ id: "a", name: "A", hidden: true })).toEqual({
        id: "a",
        name: "A",
      });
    });

    it("writes a hide override without the user-added marker", () => {
      const config = {
        models: {
          providers: {
            zai: { models: [{ id: "glm-5.3", name: "GLM-5.3" }] },
          },
        },
      };
      const patch = modelWritePatch(
        config,
        "zai",
        { id: "glm-5.3", name: "GLM-5.3", hidden: true },
        "glm-5.3",
      );
      const next = applyMergePatch(config, patch.raw, {
        replacePaths: patch.replacePaths,
      });
      const entry = next.models.providers.zai.models.find((row) => row.id === "glm-5.3");
      expect(entry).toEqual({ id: "glm-5.3", name: "GLM-5.3", hidden: true });
    });
  });

  const config = {
    models: {
      mode: "merge",
      providers: {
        "custom.proxy": {
          baseUrl: "https://models.example.test/v1",
          headers: { "X-Trace": "keep" },
          models: [
            { id: "first", name: "First", compat: { supportsStore: false } },
            { id: "second", name: "Second", metadataSource: "models-add" },
          ],
        },
        other: { models: [{ id: "sibling", name: "Sibling" }] },
      },
    },
  };

  it("renames one model in place while limiting array replacement to its provider", () => {
    const patch = modelWritePatch(
      config,
      "custom.proxy",
      { id: "renamed", name: "Renamed" },
      "first",
    );
    expect(patch).toEqual({
      raw: {
        models: {
          providers: {
            "custom.proxy": {
              models: [
                { id: "renamed", name: "Renamed" },
                { id: "second", name: "Second", metadataSource: "models-add" },
              ],
            },
          },
        },
      },
      replacePaths: ["models.providers.custom.proxy.models"],
    });
    expect(config.models.providers["custom.proxy"].models[0]?.id).toBe("first");
  });

  it("marks new additions separately from built-in overrides and preserves siblings on removal", () => {
    const added = modelWritePatch(config, "custom.proxy", { id: "third", name: "Third" });
    expect(added.raw).toMatchObject({
      models: {
        providers: {
          "custom.proxy": {
            models: expect.arrayContaining([
              { id: "third", name: "Third", metadataSource: "models-add" },
            ]),
          },
        },
      },
    });
    const overridden = modelWritePatch(
      config,
      "custom.proxy",
      { id: "built-in", name: "Override" },
      "built-in",
    );
    expect(overridden.raw).toMatchObject({
      models: {
        providers: {
          "custom.proxy": {
            models: expect.arrayContaining([{ id: "built-in", name: "Override" }]),
          },
        },
      },
    });
    expect(modelRemovePatch(config, "custom.proxy", "first")).toEqual({
      raw: {
        models: {
          providers: {
            "custom.proxy": {
              models: [{ id: "second", name: "Second", metadataSource: "models-add" }],
            },
          },
        },
      },
      replacePaths: ["models.providers.custom.proxy.models"],
    });
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
      localService: { args: ["serve", "--verbose"], env: { MODE: "original" } },
    };
    const patch = providerConnectionPatch(
      original,
      {
        ...original,
        headers: { "X-Keep": "keep" },
        localService: { ...original.localService, args: ["serve"] },
      },
      new Set(["headers", "localService"]),
      "custom.proxy",
    );
    expect(patch).toEqual({
      raw: {
        models: {
          providers: {
            "custom.proxy": {
              headers: { "X-Remove": null },
              localService: { args: ["serve"] },
            },
          },
        },
      },
      replacePaths: ["models.providers.custom.proxy.localService.args"],
    });
    expect(
      applyMergePatch(
        {
          models: {
            providers: {
              "custom.proxy": {
                ...original,
                headers: { ...original.headers, "X-Keep": "updated elsewhere" },
                localService: { ...original.localService, env: { MODE: "updated elsewhere" } },
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
            localService: { args: ["serve"], env: { MODE: "updated elsewhere" } },
          },
        },
      },
    });
  });
});
