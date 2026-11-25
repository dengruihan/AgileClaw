// Guards the curated provider templates against the plugin manifests that own
// their endpoint sets, API, headers, default models, and model rows. The plugin
// manifest is resolved from each template's declared sourceProviderId and the
// declared owner is asserted, so the owner linkage cannot drift. Each row then
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

const PLUGIN_DIRECTORY_BY_PROVIDER: Record<string, string> = {
  deepseek: "deepseek",
  kimi: "kimi-coding",
  minimax: "minimax",
  moonshot: "moonshot",
  qwen: "qwen",
  zai: "zai",
};

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

/** Resolves the manifest from the template's declared owner, not from test bookkeeping. */
function readManifestForSourceProvider(sourceProviderId: string): PluginManifest {
  const pluginDirectory = PLUGIN_DIRECTORY_BY_PROVIDER[sourceProviderId];
  if (!pluginDirectory) {
    throw new Error(`No plugin directory is mapped for source provider ${sourceProviderId}`);
  }
  return readManifest(pluginDirectory);
}

function requireCatalog(
  manifest: PluginManifest,
  catalogProviderId: string,
  templateId: string,
): ManifestCatalogProvider {
  const catalog = manifest.modelCatalog?.providers?.[catalogProviderId];
  if (!catalog) {
    throw new Error(
      `${templateId} source provider does not declare modelCatalog.providers.${catalogProviderId}`,
    );
  }
  return catalog;
}

/** Which manifest fact declares the template's endpoint. */
type EndpointOwnership =
  | { kind: "catalogBaseUrl" }
  | { kind: "declaredBaseUrl" }
  | { kind: "host" };

type TemplateManifestFacts = {
  /** Provider id the template must declare as its owner. */
  sourceProviderId: string;
  /**
   * Manifest catalog key that owns the model rows, api, headers, and default
   * model; differs from sourceProviderId only for the Token Plan catalog. Null
   * means the manifest has no catalog (MiniMax), so only hosts are checkable here.
   */
  catalogProviderId: string | null;
  endpoint: EndpointOwnership;
  /** Catalog-declared default model; omitted when only the plugin builder owns it. */
  ownDefaultModel?: boolean;
};

const TEMPLATE_MANIFEST_FACTS: Record<string, TemplateManifestFacts> = {
  "zhipu-coding-cn": {
    sourceProviderId: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
  },
  "zai-coding": {
    sourceProviderId: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
  },
  "zhipu-api-cn": {
    sourceProviderId: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "host" },
    ownDefaultModel: true,
  },
  "zai-api": {
    sourceProviderId: "zai",
    catalogProviderId: "zai",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  kimi: {
    sourceProviderId: "moonshot",
    catalogProviderId: "moonshot",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  "kimi-cn": {
    sourceProviderId: "moonshot",
    catalogProviderId: "moonshot",
    endpoint: { kind: "declaredBaseUrl" },
    ownDefaultModel: true,
  },
  "kimi-code": {
    sourceProviderId: "kimi",
    catalogProviderId: "kimi",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  minimax: {
    sourceProviderId: "minimax",
    catalogProviderId: null,
    endpoint: { kind: "host" },
  },
  "minimax-cn": {
    sourceProviderId: "minimax",
    catalogProviderId: null,
    endpoint: { kind: "host" },
  },
  deepseek: {
    sourceProviderId: "deepseek",
    catalogProviderId: "deepseek",
    endpoint: { kind: "catalogBaseUrl" },
    ownDefaultModel: true,
  },
  "bailian-cn": {
    sourceProviderId: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "bailian-intl": {
    sourceProviderId: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "bailian-coding-cn": {
    sourceProviderId: "qwen",
    catalogProviderId: "qwen",
    endpoint: { kind: "declaredBaseUrl" },
  },
  "qwen-token-plan-cn": {
    sourceProviderId: "qwen",
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

      expect(template.sourceProviderId, `${id} source provider`).toBe(facts.sourceProviderId);
      const manifest = readManifestForSourceProvider(template.sourceProviderId);
      const catalog =
        facts.catalogProviderId === null
          ? undefined
          : requireCatalog(manifest, facts.catalogProviderId, id);

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
