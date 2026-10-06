import {
  buildRemoteBaseUrlPolicy,
  createRemoteEmbeddingProvider,
  embeddingProviderOwnsDestination,
  normalizeEmbeddingModelWithPrefixes,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySecretInputString } from "openclaw/plugin-sdk/memory-core-host-secret";
import { findNormalizedProviderKey } from "openclaw/plugin-sdk/provider-model-metadata";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { LMSTUDIO_DEFAULT_EMBEDDING_MODEL, LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import { fetchLmstudioModels } from "./models.fetch.js";
import { resolveLmstudioCanonicalModelKey, resolveLmstudioInferenceBase } from "./models.js";
import { hasLmstudioAuthorizationHeader } from "./provider-auth.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioConfiguredApiKeyForProvider,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
  sanitizeLmstudioStringHeaders,
} from "./runtime.js";

type LmstudioEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = LMSTUDIO_DEFAULT_EMBEDDING_MODEL;

/** Normalizes LM Studio embedding model refs and accepts `lmstudio/` prefix. */
function normalizeLmstudioModel(model: string, providerId?: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
    prefixes: [`${providerId?.trim() || LMSTUDIO_PROVIDER_ID}/`, `${LMSTUDIO_PROVIDER_ID}/`],
  });
}

/** Resolves API key (real or synthetic placeholder) from runtime/provider auth config. */
async function resolveLmstudioApiKey(
  options: MemoryEmbeddingProviderCreateOptions,
  providerId?: string,
): Promise<string | undefined> {
  const selectedProviderId = providerId?.trim();
  if (selectedProviderId && selectedProviderId !== LMSTUDIO_PROVIDER_ID) {
    return await resolveLmstudioConfiguredApiKeyForProvider({
      providerId: selectedProviderId,
      config: options.config,
      env: process.env,
    });
  }
  try {
    return await resolveLmstudioRuntimeApiKey({
      config: options.config,
      agentDir: options.agentDir,
    });
  } catch (error) {
    // Embeddings can target local LM Studio instances that do not require auth.
    const message = error instanceof Error ? error.message : String(error);
    if (/LM Studio API key is required/i.test(message)) {
      return undefined;
    }
    throw error;
  }
}

function resolveConfiguredLmstudioProvider(options: MemoryEmbeddingProviderCreateOptions) {
  const providers = options.config.models?.providers;
  if (!providers) {
    return undefined;
  }
  const requestedId = options.provider?.trim() || LMSTUDIO_PROVIDER_ID;
  const providerId = providers[requestedId]
    ? requestedId
    : (findNormalizedProviderKey(providers, requestedId) ?? LMSTUDIO_PROVIDER_ID);
  const config = providers[providerId];
  return config ? { providerId, config } : undefined;
}

function resolveLmstudioEmbeddingBaseUrl(configuredBaseUrl?: string): string {
  const query = configuredBaseUrl?.match(/\?[^#]*/u)?.[0] ?? "";
  return `${resolveLmstudioInferenceBase(configuredBaseUrl)}${query}`;
}

async function resolveLmstudioEmbeddingModelKey(params: {
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
}): Promise<string> {
  const discovered = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
  });
  if (!discovered.reachable || (discovered.status !== undefined && discovered.status >= 400)) {
    return params.model;
  }
  return resolveLmstudioCanonicalModelKey({
    modelKey: params.model,
    models: discovered.models,
  });
}

/** Creates an embedding provider for an LM Studio model already loaded by the operator. */
export async function createLmstudioEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: LmstudioEmbeddingClient }> {
  const resolvedProvider = resolveConfiguredLmstudioProvider(options);
  const providerConfig = resolvedProvider?.config;
  const providerBaseUrl = providerConfig?.baseUrl?.trim();
  const remoteBaseUrl = options.remote?.baseUrl?.trim();
  const remoteApiKey = resolveMemorySecretInputString({
    value: options.remote?.apiKey,
    path: "memory.search.remote.apiKey",
  });
  const configuredBaseUrl = remoteBaseUrl || providerBaseUrl || undefined;
  const baseUrl = resolveLmstudioEmbeddingBaseUrl(configuredBaseUrl);
  const providerOwnedBaseUrl = resolveLmstudioEmbeddingBaseUrl(providerBaseUrl);
  const providerOwnsDestination =
    !remoteBaseUrl ||
    embeddingProviderOwnsDestination({ baseUrl, providerBaseUrl: providerOwnedBaseUrl });
  const model = normalizeLmstudioModel(options.model, resolvedProvider?.providerId);
  const providerHeaders = providerOwnsDestination
    ? await resolveLmstudioProviderHeaders({
        config: options.config,
        env: process.env,
        headers: providerConfig?.headers,
      })
    : undefined;
  // Memory remote headers are resolved snapshot values, never fresh SecretRefs.
  const headerOverrides = Object.assign(
    {},
    providerHeaders,
    sanitizeLmstudioStringHeaders(options.remote?.headers),
  );
  const apiKey = hasLmstudioAuthorizationHeader(headerOverrides)
    ? undefined
    : remoteApiKey?.trim() ||
      (providerOwnsDestination
        ? await resolveLmstudioApiKey(options, resolvedProvider?.providerId)
        : undefined);
  const headers =
    buildLmstudioAuthHeaders({
      apiKey,
      json: true,
      headers: headerOverrides,
    }) ?? {};
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const client: LmstudioEmbeddingClient = {
    baseUrl,
    model,
    headers,
    ssrfPolicy,
  };
  if (model.includes("@")) {
    client.model = await resolveLmstudioEmbeddingModelKey({
      baseUrl,
      apiKey,
      headers: headerOverrides,
      ssrfPolicy,
      model,
    });
  }

  const remoteProvider = createRemoteEmbeddingProvider({
    id: LMSTUDIO_PROVIDER_ID,
    client,
    errorPrefix: "lmstudio embeddings failed",
  });
  const embed: MemoryEmbeddingProvider["embed"] = async (input, callOptions) => {
    callOptions?.signal?.throwIfAborted();
    return await remoteProvider.embed(input, callOptions);
  };
  const embedBatch: MemoryEmbeddingProvider["embedBatch"] = async (inputs, callOptions) => {
    if (inputs.length === 0) {
      return [];
    }
    if (callOptions?.inputType === "query") {
      // Promise.all rejects before sibling requests settle, so every query keeps its own lease.
      return await Promise.all(inputs.map((input) => embed(input, callOptions)));
    }
    callOptions?.signal?.throwIfAborted();
    return await remoteProvider.embedBatch(inputs, callOptions);
  };
  const provider: MemoryEmbeddingProvider = {
    ...remoteProvider,
    embed,
    embedBatch,
  };
  return {
    provider,
    client,
  };
}
