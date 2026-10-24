// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import {
  modelReferences,
  modelRemovePatch,
  modelWritePatch,
  providerConnectionPatch,
  providerDeletePatch,
  providerReferenceSites,
} from "./provider-model-config.ts";

describe("provider model edits", () => {
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

  it("marks new additions separately from built-in overrides", () => {
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
  });

  it("deletes a model by removing its entry entirely, keeping siblings", () => {
    const patch = modelRemovePatch(config, "custom.proxy", "first");
    expect(patch).toEqual({
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
    const next = applyMergePatch(config, patch.raw, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(patch.replacePaths),
    }) as typeof config;
    expect(next.models.providers["custom.proxy"].models).toHaveLength(1);
    expect(config.models.providers["custom.proxy"].models).toHaveLength(2);
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

describe("provider deletion", () => {
  const config = {
    agents: {
      defaults: {
        model: {
          primary: "custom.proxy/first",
          fallbacks: ["other/sibling", "custom.proxy/second#work"],
        },
        utilityModel: "custom.proxy/second",
      },
    },
    models: {
      aliases: { fast: "custom.proxy/first" },
      providers: {
        "custom.proxy": {
          baseUrl: "https://models.example.test/v1",
          models: [
            { id: "first", name: "First" },
            { id: "second", name: "Second" },
          ],
        },
        other: { models: [{ id: "sibling", name: "Sibling" }] },
      },
    },
  };

  it("collects every reference site outside the provider definitions", () => {
    expect(providerReferenceSites(config, "custom.proxy").map((site) => site.path)).toEqual([
      "agents.defaults.model.primary",
      "agents.defaults.model.fallbacks[1]",
      "agents.defaults.utilityModel",
      "models.aliases.fast",
    ]);
    // Provider-adjacent ids must not match by prefix.
    expect(providerReferenceSites(config, "custom")).toEqual([]);
    expect(providerReferenceSites(config, "other").map((site) => site.path)).toEqual([
      "agents.defaults.model.fallbacks[0]",
    ]);
  });

  it("deletes a provider entry and clears scalar references without replace paths", () => {
    const sites = providerReferenceSites(
      {
        agents: { defaults: { utilityModel: "custom.proxy/second", decisionModel: null } },
        models: { providers: { "custom.proxy": { models: [] }, other: { models: [] } } },
      },
      "custom.proxy",
    );
    const patch = providerDeletePatch(config, "custom.proxy", sites);
    expect(patch).toEqual({
      raw: {
        agents: { defaults: { utilityModel: null } },
        models: { providers: { "custom.proxy": null } },
      },
      replacePaths: [],
    });
  });

  it("resets the whole model selection with its primary and filters fallbacks", () => {
    const patch = providerDeletePatch(
      config,
      "custom.proxy",
      providerReferenceSites(config, "custom.proxy"),
    );
    expect(patch.raw).toEqual({
      agents: { defaults: { model: null, utilityModel: null } },
      models: { aliases: { fast: null }, providers: { "custom.proxy": null } },
    });
    expect(patch.replacePaths).toEqual([]);
    const next = applyMergePatch(config, patch.raw, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(patch.replacePaths),
    }) as typeof config;
    expect(next.agents.defaults.model).toBeUndefined();
    expect(next.models.providers["custom.proxy"]).toBeUndefined();
    expect(next.models.providers.other).toEqual(config.models.providers.other);
  });

  it("keeps a primary from another provider and rebuilds only its fallback entries", () => {
    const mixed = {
      agents: {
        defaults: {
          model: { primary: "other/sibling", fallbacks: ["custom.proxy/first", "other/sibling"] },
        },
      },
      models: config.models,
    };
    const patch = providerDeletePatch(
      mixed,
      "custom.proxy",
      providerReferenceSites(mixed, "custom.proxy"),
    );
    expect(patch.raw).toEqual({
      agents: { defaults: { model: { fallbacks: ["other/sibling"] } } },
      models: { aliases: { fast: null }, providers: { "custom.proxy": null } },
    });
    expect(patch.replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
    const next = applyMergePatch(mixed, patch.raw, {
      mergeObjectArraysById: true,
      replaceArrayPaths: new Set(patch.replacePaths),
    }) as typeof mixed;
    expect(next.agents.defaults.model).toEqual({
      primary: "other/sibling",
      fallbacks: ["other/sibling"],
    });
  });

  it("clears per-agent model overrides alongside the provider entry", () => {
    const perAgent = {
      agents: { entries: { worker: { model: "custom.proxy/first" } } },
      models: config.models,
    };
    const patch = providerDeletePatch(
      perAgent,
      "custom.proxy",
      providerReferenceSites(perAgent, "custom.proxy"),
    );
    expect(patch.raw).toEqual({
      agents: { entries: { worker: { model: null } } },
      models: { aliases: { fast: null }, providers: { "custom.proxy": null } },
    });
  });
});
