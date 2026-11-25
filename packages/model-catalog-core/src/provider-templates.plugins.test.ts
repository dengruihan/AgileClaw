// Guards the curated provider templates against the plugin manifests that own
// their endpoint and model facts. Manifest-backed rows must not drift; the
// MiniMax rows track a builder because that plugin's manifest has no model
// catalog, so only its endpoint hosts and empty headers are checkable there.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from "@openclaw/model-catalog-core/provider-templates";
import { describe, expect, it } from "vitest";

type ManifestCatalogProvider = {
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: Array<{ id: string; status?: string }>;
};

type PluginManifest = {
  modelCatalog?: { providers?: Record<string, ManifestCatalogProvider> };
  providerEndpoints?: Array<{ baseUrls?: string[]; hosts?: string[] }>;
};

const EXTENSIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions",
);

const PLUGIN_DIRECTORY_BY_PROVIDER: Record<string, string> = {
  deepseek: "deepseek",
  kimi: "kimi-coding",
  minimax: "minimax",
  moonshot: "moonshot",
  qwen: "qwen",
  zai: "zai",
};

const manifestCache = new Map<string, PluginManifest>();

function readManifest(providerId: string): PluginManifest {
  const cached = manifestCache.get(providerId);
  if (cached) {
    return cached;
  }
  const directory = PLUGIN_DIRECTORY_BY_PROVIDER[providerId];
  if (!directory) {
    throw new Error(`No plugin directory is mapped for source provider ${providerId}`);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSIONS_DIR, directory, "openclaw.plugin.json"), "utf8"),
  ) as PluginManifest;
  manifestCache.set(providerId, manifest);
  return manifest;
}

function endpointIsDeclared(
  manifest: PluginManifest,
  catalog: ManifestCatalogProvider | undefined,
  baseUrl: string,
): boolean {
  if (catalog?.baseUrl === baseUrl) {
    return true;
  }
  const host = new URL(baseUrl).hostname;
  return (manifest.providerEndpoints ?? []).some(
    (endpoint) => endpoint.baseUrls?.includes(baseUrl) || endpoint.hosts?.includes(host),
  );
}

describe("provider templates match their source plugin manifests", () => {
  it.each(PROVIDER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s",
    (_id, template: ProviderTemplate) => {
      const manifest = readManifest(template.sourceProviderId);
      const catalog = manifest.modelCatalog?.providers?.[template.sourceProviderId];

      expect(
        endpointIsDeclared(manifest, catalog, template.provider.baseUrl),
        `${template.id} endpoint is not declared by ${template.sourceProviderId}`,
      ).toBe(true);
      expect(template.provider.headers).toEqual(catalog?.headers);

      if (!catalog) {
        // MiniMax publishes its model rows from a builder, not the manifest.
        expect(manifest.providerEndpoints?.length ?? 0).toBeGreaterThan(0);
        return;
      }

      expect(template.provider.api).toBe(catalog.api);
      const catalogModelIds = new Set((catalog.models ?? []).map((model) => model.id));
      for (const model of template.provider.models) {
        expect(catalogModelIds.has(model.id), `${template.id} model ${model.id}`).toBe(true);
      }
      if (template.provider.defaultModel !== undefined) {
        expect(
          catalogModelIds.has(template.provider.defaultModel),
          `${template.id} default model ${template.provider.defaultModel}`,
        ).toBe(true);
      }
    },
  );
});
