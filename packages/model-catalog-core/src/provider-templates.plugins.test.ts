// Guards the curated provider templates against the plugin manifests that own
// their endpoint sets, API, headers, default models, and model rows. Each row
// selects the manifest catalog that owns it (including the distinct Token Plan
// catalog) and applies the manifest's own suppressions, so endpoint/model
// variants cannot silently cross over. Builder-owned facts (exact coding/API
// endpoint constants, MiniMax's model rows) are guarded in the root contract
// test, because core tsgo graphs must not include extension files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from "@openclaw/model-catalog-core/provider-templates";
import { describe, expect, it } from "vitest";

type ManifestCatalogModel = {
  id: string;
};

type ManifestCatalogProvider = {
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  defaultModel?: string;
  models?: ManifestCatalogModel[];
};

type ManifestSuppression = {
  provider: string;
  model: string;
  when?: { baseUrlHosts?: string[] };
};

type PluginManifest = {
  modelCatalog?: {
    providers?: Record<string, ManifestCatalogProvider>;
    suppressions?: ManifestSuppression[];
  };
  providerEndpoints?: Array<{ baseUrls?: string[]; hosts?: string[] }>;
};

const EXTENSIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions",
);

const manifestCache = new Map<string, PluginManifest>();

function readManifest(pluginDirectory: string): PluginManifest {
  const cached = manifestCache.get(pluginDirectory);
  if (cached) {
    return cached;
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSIONS_DIR, pluginDirectory, "openclaw.plugin.json"), "utf8"),
  ) as PluginManifest;
  manifestCache.set(pluginDirectory, manifest);
  return manifest;
}

/** Which manifest fact declares the template's endpoint. */
type EndpointOwnership =
  | { kind: "catalogBaseUrl" }
  | { kind: "declaredBaseUrl" }
  | { kind: "host" };

type TemplateManifestFacts = {
  /** Extension whose manifest owns the facts for this template. */
  pluginDirectory: string;
  /** Manifest catalog provider that owns the model rows, api, headers, and default model. */
  catalogProviderId: string | undefined;
  endpoint: EndpointOwnership;
  /** Catalog-declared default model; omitted when only the plugin builder owns it. */
  ownDefaultModel?: boolean;
};

const TEMPLATE_MANIFEST_FACTS: Record<string, TemplateManifestFacts> = {
  "zhipu-coding-cn": {
    pluginDirectory: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
  },
  "zai-coding": {
    pluginDirectory: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
  },
  "zhipu-api-cn": {
    pluginDirectory: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
    ownDefaultModel: true,
  },
  "zai-api": {
    pluginDirectory: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  kimi: {
    pluginDirectory: "moonshot",
    catalogProviderId: "moonshot",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  "kimi-cn": {
    pluginDirectory: "moonshot",
    catalogProviderId: "moonshot",
    endpoint: { kind: "declaredBaseUrl" },
    ownDefaultModel: true,
  },
  "kimi-code": {
    pluginDirectory: "kimi-coding",
    catalogProviderId: "kimi",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  minimax: {
    pluginDirectory: "minimax",
    catalogProviderId: undefined,
    endpoint: { kind: "host" },
  },
  "minimax-cn": {
    pluginDirectory: "minimax",
    catalogProviderId: undefined,
    endpoint: { kind: "host" },
  },
  deepseek: {
    pluginDirectory: "deepseek",
    catalogProviderId: "deepseek",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  "bailian-cn": {
    pluginDirectory: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "bailian-intl": {
    pluginDirectory: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "bailian-coding-cn": {
    pluginDirectory: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "qwen-token-plan-cn": {
    pluginDirectory: "qwen",
    catalogProviderId: "qwen-token-plan",
    endpoint: { kind: "declaredBaseUrl" },
  },
};

function factsFor(templateId: string): TemplateManifestFacts {
  const facts = TEMPLATE_MANIFEST_FACTS[templateId];
  if (!facts) {
    throw new Error(`No manifest facts are mapped for provider template ${templateId}`);
  }
  return facts;
}

function endpointHost(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

function expectDeclaredEndpoint(
  baseUrl: string,
  manifest: PluginManifest,
  catalog: ManifestCatalogProvider | undefined,
  ownership: EndpointOwnership,
) {
  if (ownership.kind === "catalogBaseUrl") {
    expect(baseUrl).toBe(catalog?.baseUrl);
    return;
  }
  const endpoints = manifest.providerEndpoints ?? [];
  if (ownership.kind === "declaredBaseUrl") {
    expect(endpoints.some((endpoint) => endpoint.baseUrls?.includes(baseUrl))).toBe(true);
    return;
  }
  // Host-only declarations cannot bind a variant path; the exact endpoint
  // constants are guarded in the root contract test.
  expect(endpoints.some((endpoint) => endpoint.hosts?.includes(endpointHost(baseUrl)))).toBe(true);
}

describe("provider templates match their owning plugin manifests", () => {
  it("maps every template to exactly one manifest fact set", () => {
    const templateIds = PROVIDER_TEMPLATES.map((template) => template.id).toSorted();

    expect(Object.keys(TEMPLATE_MANIFEST_FACTS).toSorted()).toEqual(templateIds);
  });

  it.each(PROVIDER_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s",
    (id, template: ProviderTemplate) => {
      const facts = factsFor(id);
      const manifest = readManifest(facts.pluginDirectory);
      const catalog =
        facts.catalogProviderId === undefined
          ? undefined
          : manifest.modelCatalog?.providers?.[facts.catalogProviderId];

      expectDeclaredEndpoint(template.provider.baseUrl, manifest, catalog, facts.endpoint);

      if (!catalog) {
        expect(template.provider.headers, `${id} headers`).toBeUndefined();
        return;
      }

      const host = endpointHost(template.provider.baseUrl);
      const suppressedIds = new Set(
        (manifest.modelCatalog?.suppressions ?? [])
          .filter(
            (suppression) =>
              suppression.provider === facts.catalogProviderId &&
              suppression.when?.baseUrlHosts?.includes(host),
          )
          .map((suppression) => suppression.model),
      );
      const modelIds = (catalog.models ?? []).map((model) => model.id);
      const expectedIds = modelIds.filter((modelId) => !suppressedIds.has(modelId));

      expect(template.provider.api, `${id} api`).toBe(catalog.api);
      expect(template.provider.headers, `${id} headers`).toEqual(catalog.headers);
      expect(
        template.provider.models.map((model) => model.id),
        `${id} models`,
      ).toEqual(expectedIds);
      if (facts.ownDefaultModel) {
        expect(template.provider.defaultModel, `${id} default model`).toBe(catalog.defaultModel);
      }
    },
  );
});
