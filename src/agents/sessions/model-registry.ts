import { normalizeResolvedPricing } from "@openclaw/llm-core";
import type { ModelCatalogContextWindowOption } from "@openclaw/model-catalog-core/model-catalog-types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Model, SimpleStreamOptions } from "../../llm/types.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { sanitizeModelHeaders } from "../embedded-agent-runner/model.inline-provider.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import { normalizeProviderMapKeys, type ProviderModelCatalog } from "../models-config.merge.js";
import type { PluginModelCatalogMetadataSnapshot } from "../plugin-model-catalog.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import type { AuthStatus, AuthStorage } from "./auth-storage.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
  resetModelRegistryRuntime,
} from "./model-registry-runtime.js";
import type { ModelsConfig, ProviderAuthMode } from "./model-registry-schema.js";
import type { ProviderConfigBase, ProviderModelConfig } from "./provider-config.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";
import {
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

type RegistryProviderSources = Record<
  string,
  ProviderModelCatalog &
    Pick<ModelsConfig["providers"][string], "apiKey" | "auth" | "authHeader"> & {
      headers?: Record<string, string>;
    }
>;

interface ProviderRequestConfig {
  baseUrls?: readonly string[];
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

type ModelRegistryOptions = {
  config?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  sourceSnapshot?: ModelRegistry;
  workspaceDir?: string;
};

type ModelRegistryCatalogSnapshot = {
  models: Model[];
  providerRequestConfigs: Map<string, ProviderRequestConfig>;
  modelRequestHeaders: Map<string, Record<string, string>>;
  loadError: string | undefined;
  pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;
  oauthProviders: OAuthProviderInterface[];
};

export class ModelRegistry {
  private models: Model[] = [];
  private config: OpenClawConfig | undefined;
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;
  readonly authStorage: AuthStorage;
  private pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;
  private baseCatalogSnapshot: ModelRegistryCatalogSnapshot | undefined;
  private sourceSnapshot: ModelRegistryCatalogSnapshot | undefined;

  private constructor(authStorage: AuthStorage, options: ModelRegistryOptions = {}) {
    this.authStorage = authStorage;
    this.config = options.config ?? options.sourceSnapshot?.config;
    initializeModelRegistryRuntime(this);
    if (options.sourceSnapshot) {
      const source = options.sourceSnapshot;
      const captured = source.baseCatalogSnapshot ?? source.captureCatalogSnapshot();
      const sourceSnapshot = captured;
      this.sourceSnapshot = sourceSnapshot;
      this.baseCatalogSnapshot = sourceSnapshot;
      this.restoreSourceCatalog(sourceSnapshot);
      this.registeredProviders = new Map(
        [...source.registeredProviders].map(([provider, config]) => [provider, { ...config }]),
      );
      getAuthStorageOAuthProviderRegistry(authStorage).reset();
      for (const oauthProvider of sourceSnapshot.oauthProviders) {
        getAuthStorageOAuthProviderRegistry(authStorage).register(oauthProvider);
      }
      for (const [providerName, config] of this.registeredProviders.entries()) {
        this.applyProviderConfig(providerName, config);
      }
      return;
    }
    this.pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
      config: this.config,
      ...(options.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
        : {}),
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
      useRuntimeConfig: true,
    });
    this.loadModels();
    this.baseCatalogSnapshot = this.captureCatalogSnapshot();
  }

  private captureCatalogSnapshot(): ModelRegistryCatalogSnapshot {
    return {
      models: structuredClone(this.models),
      providerRequestConfigs: new Map(
        [...this.providerRequestConfigs].map(([provider, config]) => [provider, { ...config }]),
      ),
      modelRequestHeaders: new Map(
        [...this.modelRequestHeaders].map(([key, headers]) => [key, { ...headers }]),
      ),
      loadError: this.loadError,
      pluginMetadataSnapshot: this.pluginMetadataSnapshot,
      oauthProviders: [...this.authStorage.getOAuthProviders()],
    };
  }

  private restoreSourceCatalog(source: ModelRegistryCatalogSnapshot): void {
    this.models = structuredClone(source.models);
    this.providerRequestConfigs = new Map(
      [...source.providerRequestConfigs].map(([provider, config]) => [provider, { ...config }]),
    );
    this.modelRequestHeaders = new Map(
      [...source.modelRequestHeaders].map(([key, headers]) => [key, { ...headers }]),
    );
    this.loadError = source.loadError;
    this.pluginMetadataSnapshot = source.pluginMetadataSnapshot;
  }

  static create(authStorage: AuthStorage, options: ModelRegistryOptions = {}): ModelRegistry {
    return new ModelRegistry(authStorage, options);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage);
  }

  /** Creates a request-isolated registry from this lifecycle-owned catalog snapshot. */
  fork(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, { sourceSnapshot: this });
  }

  /**
   * Reload models from disk (models.json).
   */
  refresh(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    // Rebuild this lifecycle's API/OAuth registrations from current provider state.
    resetModelRegistryRuntime(this);
    getAuthStorageOAuthProviderRegistry(this.authStorage).reset();

    if (this.sourceSnapshot) {
      this.restoreSourceCatalog(this.sourceSnapshot);
      for (const oauthProvider of this.sourceSnapshot.oauthProviders) {
        getAuthStorageOAuthProviderRegistry(this.authStorage).register(oauthProvider);
      }
    } else {
      this.loadModels();
      // Forks start from the latest disk-backed base, then replay this registry's dynamic providers.
      this.baseCatalogSnapshot = this.captureCatalogSnapshot();
    }

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  /** Get any root or generated plugin catalog load error. */
  getError(): string | undefined {
    return this.loadError;
  }

  /** Returns the exact plugin metadata generation captured with this registry. */
  getProviderMetadataOwners() {
    return this.pluginMetadataSnapshot?.owners;
  }

  private loadModels(): void {
    // Saved provider rows are the only runtime inventory. Manifest and discovered
    // rows may provide setup metadata, but cannot restore removed model rows.
    const providers: RegistryProviderSources = {};
    for (const [providerId, configured] of Object.entries(
      normalizeProviderMapKeys(this.config?.models?.providers),
    )) {
      const current: RegistryProviderSources[string] = {
        api: configured.api,
        baseUrl: configured.baseUrl,
        models: configured.models?.map((model) => ({
          ...model,
          api: model.api ?? configured.api,
          baseUrl: model.baseUrl ?? configured.baseUrl,
          maxTokensSource: "configured",
          headers: sanitizeModelHeaders(model.headers),
        })),
      };
      providers[providerId] = current;
      this.providerRequestConfigs.delete(providerId);
      // Current config owns provider request settings, including accepted catalog routes.
      // File-only callers retain the authored-endpoint scope captured by loadCustomModels.
      this.storeProviderRequestConfig(providerId, {
        apiKey: normalizeOptionalSecretInput(configured.apiKey),
        auth: configured.auth,
        authHeader: configured.authHeader,
        headers: sanitizeModelHeaders(configured.headers),
      });
    }
    this.models = this.parseModels(providers);
  }

  private parseModels(providers: RegistryProviderSources): Model[] {
    const models: Model[] = [];

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      for (const modelDef of providerConfig.models ?? []) {
        const api = modelDef.api ?? providerConfig.api;
        if (!api) {
          continue;
        }

        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
        if (!baseUrl) {
          continue;
        }

        // Project richer persisted metadata to runtime's text/image contract.
        // Unsupported-only rows are not runnable; explicit empty input stays valid.
        const runtimeInput = (modelDef.input ?? ["text"]).filter(
          (input): input is "text" | "image" => input === "text" || input === "image",
        );
        if ((modelDef.input?.length ?? 0) > 0 && runtimeInput.length === 0) {
          continue;
        }

        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: runtimeInput,
          cost: normalizeResolvedPricing(modelDef.cost ?? {}),
          contextWindow: modelDef.contextWindow ?? 128000,
          contextTokens: modelDef.contextTokens,
          contextWindows: modelDef.contextWindows,
          contextWindowDefault: modelDef.contextWindowDefault,
          maxTokens: modelDef.maxTokens ?? 16384,
          ...(modelDef.maxTokens !== undefined
            ? { maxTokensSource: modelDef.maxTokensSource }
            : {}),
          params: modelDef.params,
          headers: undefined,
          compat: modelDef.compat,
        } as Model);
      }
    }

    return models;
  }

  getAll(): Model[] {
    return this.models;
  }

  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable(): Model[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  find(provider: string, modelId: string): Model | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  hasConfiguredAuth(model: Model): boolean {
    const providerConfig = this.getModelProviderRequestConfig(model);
    return (
      this.authStorage.hasAuth(model.provider) ||
      providerConfig?.auth === "aws-sdk" ||
      providerConfig?.apiKey !== undefined
    );
  }

  private getModelProviderRequestConfig(model: Model): ProviderRequestConfig | undefined {
    const config = this.providerRequestConfigs.get(model.provider);
    if (
      config?.baseUrls &&
      !config.baseUrls.some((baseUrl) =>
        modelTransportRoutesMatch({ baseUrl }, { baseUrl: model.baseUrl }),
      )
    ) {
      return undefined;
    }
    return config;
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return JSON.stringify([provider, modelId]);
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: {
      baseUrl?: string;
      models?: readonly { baseUrl?: string }[];
      apiKey?: string;
      auth?: ProviderAuthMode;
      headers?: Record<string, string>;
      authHeader?: boolean;
    },
  ): void {
    if (!config.apiKey && !config.auth && !config.headers && !config.authHeader) {
      return;
    }

    this.providerRequestConfigs.set(providerName, {
      // File-authored endpoints authorize these settings; generated destinations do not.
      // Route-less runtime registrations retain their explicit caller-owned scope.
      baseUrls: config.baseUrl
        ? [config.baseUrl, ...(config.models ?? []).flatMap((model) => model.baseUrl ?? [])]
        : undefined,
      apiKey: config.apiKey,
      auth: config.auth,
      headers: config.headers,
      authHeader: config.authHeader,
    });
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ): void {
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.getModelProviderRequestConfig(model);
      const usesAwsSdkAuth = providerConfig?.auth === "aws-sdk";
      const apiKeyFromAuthStorage = usesAwsSdkAuth
        ? undefined
        : await this.authStorage.getApiKey(model.provider, {
            includeFallback: false,
            baseUrl: model.baseUrl,
          });
      const apiKey =
        apiKeyFromAuthStorage ??
        (!usesAwsSdkAuth && providerConfig?.apiKey
          ? resolveConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);

      const providerHeaders = resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );

      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Return auth status for a provider, including request auth configured in models.json.
   * This intentionally does not execute command-backed config values.
   */
  getProviderAuthStatus(provider: string): AuthStatus {
    const providerRequestConfig = this.providerRequestConfigs.get(provider);
    if (providerRequestConfig?.auth === "aws-sdk") {
      return { configured: true, source: "models_json_key", label: providerRequestConfig.auth };
    }

    const authStatus = this.authStorage.getAuthStatus(provider);
    if (authStatus.source) {
      return authStatus;
    }

    const providerApiKey = providerRequestConfig?.apiKey;
    if (!providerApiKey) {
      return authStatus;
    }

    if (providerApiKey.startsWith("!")) {
      return { configured: true, source: "models_json_command" };
    }

    if (process.env[providerApiKey]) {
      return { configured: true, source: "environment", label: providerApiKey };
    }

    return { configured: true, source: "models_json_key" };
  }

  getProviderDisplayName(provider: string): string {
    const registeredProvider = this.registeredProviders.get(provider);
    const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

    return (
      registeredProvider?.name ??
      registeredProvider?.oauth?.name ??
      oauthProvider?.name ??
      BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
      provider
    );
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
    if (apiKey !== undefined) {
      return apiKey;
    }

    const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
    return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
  }

  /**
   * Check if a model is using OAuth credentials (subscription).
   */
  isUsingOAuth(model: Model): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /**
   * Register a provider dynamically (from extensions).
   *
   * If provider has models: replaces all existing models for this provider.
   * Provider-level request settings are stored for already-known models but
   * never create implicit model rows.
   * If provider has oauth: registers OAuth provider for /login support.
   */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.upsertRegisteredProvider(providerName, config);
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) {
      return;
    }
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  /**
   * Upsert a provider config into registeredProviders.
   * If the provider is already registered, defined values in the incoming config
   * override existing ones; undefined values are preserved from the stored config.
   * If the provider is not registered, the incoming config is stored as-is.
   */
  private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
    const existing = this.registeredProviders.get(providerName);
    if (!existing) {
      this.registeredProviders.set(providerName, config);
      return;
    }
    for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
      if (config[k] !== undefined) {
        (existing as Record<string, unknown>)[k] = config[k];
      }
    }
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.oauth) {
      const oauthProvider: OAuthProviderInterface = {
        ...config.oauth,
        id: providerName,
      };
      getAuthStorageOAuthProviderRegistry(this.authStorage).register(oauthProvider);
    }

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      getModelRegistryRuntime(this).apiRegistry.registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) =>
            streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }

    this.storeProviderRequestConfig(providerName, config);

    // Provider plugins register transport and auth behavior; config rows own inventory.
  }
}

export interface ProviderConfigInput extends ProviderConfigBase {
  auth?: ProviderAuthMode;
  /** OAuth provider for /login support */
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<
    ProviderModelConfig & {
      contextTokens?: number;
      contextWindows?: ModelCatalogContextWindowOption[];
      contextWindowDefault?: string;
      params?: Record<string, unknown>;
    }
  >;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
