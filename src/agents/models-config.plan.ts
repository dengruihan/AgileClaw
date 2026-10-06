/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to project the saved provider config into models.json while
 * preserving source-managed secrets.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isWritableProviderConfig } from "./models-config.merge.js";
import {
  enforceSourceManagedProviderSecrets,
  materializeConfiguredProviderCatalogModels,
  normalizeProviderCatalogModelsForConfig,
  normalizeProviders,
  type ProviderConfig,
} from "./models-config.providers.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";

export type PreparedModelsConfigContext = Readonly<{
  cfg: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  envFingerprint: NodeJS.ProcessEnv | string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<
    PluginMetadataSnapshot,
    "index" | "manifestRegistry" | "owners" | "pluginIds"
  >;
}>;

/**
 * Planned models.json result. When present, pluginCatalogWrites is the complete
 * replacement set; omission means the plan is non-authoritative for plugin catalogs.
 */
type ModelsJsonPlan =
  | {
      action: "skip" | "noop";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "write";
      contents: string;
      pluginCatalogWrites?: Record<string, string>;
    };

function splitProvidersByPluginOwner(params: {
  providers: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): {
  rootProviders: Record<string, ProviderConfig>;
  pluginProviders: Record<string, Record<string, ProviderConfig>>;
} {
  const rootProviders: Record<string, ProviderConfig> = {};
  const pluginProviders: Record<string, Record<string, ProviderConfig>> = {};
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const pluginId = resolvePluginModelCatalogOwnerPluginId({
      providerId,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    });
    if (!pluginId) {
      rootProviders[providerId] = provider;
      continue;
    }
    const pluginCatalog = (pluginProviders[pluginId] ??= {});
    pluginCatalog[providerId] = provider;
  }
  return { rootProviders, pluginProviders };
}

function buildPluginCatalogWrites(
  pluginProviders: Record<string, Record<string, ProviderConfig>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pluginProviders).map(([pluginId, providers]) => [
      encodePluginModelCatalogRelativePath(pluginId),
      `${JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers }, null, 2)}\n`,
    ]),
  );
}

/** Resolves providers for models.json from the saved provider config. */
function resolveProvidersForModelsJson(
  context: PreparedModelsConfigContext,
): Record<string, ProviderConfig> {
  const explicitProviders = stripBlankProviderBaseUrls(
    materializeConfiguredProviderCatalogModels(context.cfg.models?.providers, {
      manifestPlugins: context.pluginMetadataSnapshot,
    }) ?? {},
  );
  return explicitProviders;
}

function stripBlankProviderBaseUrls(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    if (typeof provider?.baseUrl === "string" && provider.baseUrl.trim() === "") {
      const { baseUrl: _blank, ...rest } = provider;
      next[key] = rest as ProviderConfig;
      mutated = true;
      continue;
    }
    next[key] = provider;
  }
  return mutated ? next : providers;
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isWritableProviderConfig(provider)),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

/** Plans root and plugin-owned model catalog writes for the current runtime. */
export async function planOpenClawModelsJson(params: {
  context: PreparedModelsConfigContext;
  existingRaw: string;
}): Promise<ModelsJsonPlan> {
  const { context } = params;
  const { cfg, agentDir, env } = context;
  const providers = resolveProvidersForModelsJson(context);

  if (Object.keys(providers).length === 0) {
    return {
      action: "write",
      contents: `${JSON.stringify({ providers: {} }, null, 2)}\n`,
      pluginCatalogWrites: {},
    };
  }

  const secretRefManagedProviders = new Set<string>();
  const providerPolicyManifestRegistry =
    context.pluginMetadataSnapshot?.pluginIds === undefined
      ? context.pluginMetadataSnapshot?.manifestRegistry
      : undefined;
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
      ...(providerPolicyManifestRegistry
        ? { manifestRegistry: providerPolicyManifestRegistry }
        : {}),
    }) ?? providers;
  const mergedProviders = normalizedProviders;
  const finalizeProviders = (candidateProviders: Record<string, ProviderConfig>) => {
    const normalized =
      normalizeProviderCatalogModelsForConfig(candidateProviders) ?? candidateProviders;
    return filterWritableProviders(
      enforceSourceManagedProviderSecrets({
        providers: normalized,
        sourceConfigForSecrets: context.sourceConfigForSecrets,
        secretRefManagedProviders,
      }) ?? normalized,
    );
  };
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalizeProviders(mergedProviders),
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
  });
  const pluginCatalogWrites = buildPluginCatalogWrites(splitProviders.pluginProviders);
  // Root models.json is author-owned even when a plugin also owns that provider id.
  const rootProviders = splitProviders.rootProviders;
  const nextContents = `${JSON.stringify(
    {
      providers: finalizeProviders(rootProviders),
    },
    null,
    2,
  )}\n`;

  if (params.existingRaw === nextContents && Object.keys(pluginCatalogWrites).length === 0) {
    return { action: "noop", pluginCatalogWrites };
  }

  return {
    action: "write",
    contents: nextContents,
    pluginCatalogWrites,
  };
}
