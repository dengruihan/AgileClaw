import { isApiKeyModelApi } from "../config/model-config-vocabulary.js";
import type { ModelProviderConfigInput } from "../config/types.models.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import { buildManifestModelProviderConfig } from "./provider-catalog.js";

export type ProviderModelTemplate = {
  id: string;
  name: string;
  requiresApiKey: boolean;
  defaults: ModelProviderConfigInput;
};

function providerDisplayName(providerId: string): string {
  const knownNames: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google Gemini",
    ollama: "Ollama Cloud",
    openai: "OpenAI",
  };
  return (
    knownNames[providerId] ??
    providerId
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function buildCustomTemplate(): ProviderModelTemplate {
  return {
    id: "custom",
    name: "Custom provider",
    requiresApiKey: false,
    defaults: { api: "openai-completions", baseUrl: "", models: [] },
  };
}

function buildOllamaLocalTemplate(): ProviderModelTemplate {
  return {
    id: "ollama",
    name: "Ollama",
    requiresApiKey: false,
    defaults: {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      discovery: { endpointPath: "api/tags" },
      models: [],
    },
  };
}

function buildProviderTemplates(registry: PluginManifestRegistry): ProviderModelTemplate[] {
  const providers: ProviderModelTemplate[] = [];
  for (const plugin of registry.plugins) {
    if (plugin.origin !== "bundled" && plugin.trustedOfficialInstall !== true) {
      continue;
    }
    for (const [providerId, catalog] of Object.entries(plugin.modelCatalog?.providers ?? {})) {
      const discovery = catalog.discovery;
      if (!discovery || !catalog.baseUrl || !catalog.api || !isApiKeyModelApi(catalog.api)) {
        continue;
      }
      const defaults = buildManifestModelProviderConfig({ providerId, catalog });
      providers.push({
        id: providerId,
        name: providerDisplayName(providerId),
        requiresApiKey: discovery.requiresApiKey ?? true,
        defaults: {
          name: providerDisplayName(providerId),
          baseUrl: defaults.baseUrl,
          api: defaults.api,
          ...(defaults.headers ? { headers: defaults.headers } : {}),
          models: defaults.models.map((model) => ({
            ...model,
            metadataSource: "provider-discovery",
          })),
          discovery: {
            ...(discovery.endpointPath ? { endpointPath: discovery.endpointPath } : {}),
            ...(discovery.headers ? { headers: discovery.headers } : {}),
            ...(discovery.request ? { request: discovery.request } : {}),
          },
        },
      });
    }
  }
  return providers;
}

export function listProviderModelTemplates(
  registry: PluginManifestRegistry = loadPluginManifestRegistryCore(),
): { templates: ProviderModelTemplate[] } {
  const templates = buildProviderTemplates(registry);
  if (!templates.some((template) => template.id === "ollama")) {
    templates.push(buildOllamaLocalTemplate());
  }
  return {
    templates: [
      buildCustomTemplate(),
      ...templates.toSorted((left, right) => left.name.localeCompare(right.name)),
    ],
  };
}
