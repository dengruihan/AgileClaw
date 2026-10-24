// @vitest-environment node
import { describe, expect, it } from "vitest";
import { customModelRefs, filterCustomModelCatalog } from "./custom-model-refs.ts";

describe("custom model refs", () => {
  it("collects authored provider model refs and keeps empty rosters unfiltered", () => {
    expect(customModelRefs(null)).toBeNull();
    expect(customModelRefs(undefined)).toBeNull();
    expect(customModelRefs({})).toBeNull();
    expect(
      customModelRefs({
        models: {
          providers: {
            zai: { models: [{ id: "GLM-5.3 ", name: "GLM" }, { name: "no id" }] },
            remote: { baseUrl: "https://e.test" },
          },
        },
      }),
    ).toEqual(new Set(["zai/glm-5.3"]));
  });

  it("filters catalog rows to authored entries plus retained refs", () => {
    const models = [
      { provider: "zai", id: "glm-5.3" },
      { provider: "openai", id: "gpt-5" },
    ];
    const config = { models: { providers: { zai: { models: [{ id: "glm-5.3" }] } } } };
    expect(filterCustomModelCatalog(models, null)).toEqual(models);
    expect(filterCustomModelCatalog(models, config)).toEqual([{ provider: "zai", id: "glm-5.3" }]);
    expect(filterCustomModelCatalog(models, config, ["OPENAI/gpt-5"])).toEqual(models);
    expect(filterCustomModelCatalog(models, {})).toEqual(models);
  });
});
