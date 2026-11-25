import {
  PROVIDER_TEMPLATE_GROUPS,
  PROVIDER_TEMPLATES,
} from "@openclaw/model-catalog-core/provider-templates";
// Guards the curated provider template table the Control UI seeds its provider
// editor with: rows must stay well-formed and claim distinct endpoint keys.
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_APIS } from "./model-catalog-types.js";
import { buildEndpointIdFromUrl, normalizeEndpointId } from "./provider-id.js";

function providerKey(template: (typeof PROVIDER_TEMPLATES)[number]): string {
  return template.keySeed ?? buildEndpointIdFromUrl(template.provider.baseUrl);
}

describe("provider template groups", () => {
  it("declares unique group ids with both locale names", () => {
    const ids = PROVIDER_TEMPLATE_GROUPS.map((group) => group.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const group of PROVIDER_TEMPLATE_GROUPS) {
      expect(Number.isInteger(group.order)).toBe(true);
      expect(group.name.en.trim()).not.toBe("");
      expect(group.name.zhCN.trim()).not.toBe("");
    }
  });
});

describe("provider templates", () => {
  it("keeps ids, group references, and in-group orders unique", () => {
    const ids = PROVIDER_TEMPLATES.map((template) => template.id);
    const groupIds = new Set(PROVIDER_TEMPLATE_GROUPS.map((group) => group.id));
    const positions = PROVIDER_TEMPLATES.map((template) => `${template.group}:${template.order}`);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(positions).size).toBe(positions.length);
    for (const template of PROVIDER_TEMPLATES) {
      expect(groupIds.has(template.group), `${template.id} references ${template.group}`).toBe(
        true,
      );
      expect(Number.isInteger(template.order)).toBe(true);
      expect(template.auth).toBe("api-key");
      expect(template.sourceProviderId.trim()).not.toBe("");
      expect(template.icon.trim()).not.toBe("");
      expect(template.name.en.trim()).not.toBe("");
      expect(template.name.zhCN.trim()).not.toBe("");
    }
  });

  it("declares https endpoints with a supported API and unique model rows", () => {
    for (const template of PROVIDER_TEMPLATES) {
      const url = new URL(template.provider.baseUrl);
      const modelIds = template.provider.models.map((model) => model.id);

      expect(url.protocol, template.id).toBe("https:");
      expect(MODEL_CATALOG_APIS).toContain(template.provider.api);
      expect(modelIds.length).toBeGreaterThan(0);
      expect(new Set(modelIds).size, template.id).toBe(modelIds.length);
      for (const model of template.provider.models) {
        expect(model.id.trim()).not.toBe("");
        expect(model.name.trim()).not.toBe("");
      }
      if (template.provider.defaultModel !== undefined) {
        expect(modelIds, template.id).toContain(template.provider.defaultModel);
      }
    }
  });

  it("derives distinct custom keys and keeps declared seeds verbatim", () => {
    const keys = PROVIDER_TEMPLATES.map(providerKey);

    expect(new Set(keys).size).toBe(keys.length);
    for (const template of PROVIDER_TEMPLATES) {
      expect(providerKey(template)).toMatch(/^custom-/u);
      if (template.keySeed !== undefined) {
        expect(normalizeEndpointId(template.keySeed), template.id).toBe(template.keySeed);
      }
    }
  });
});
