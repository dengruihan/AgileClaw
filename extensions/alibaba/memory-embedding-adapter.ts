import {
  isMissingEmbeddingApiKeyError,
  sanitizeEmbeddingCacheHeaders,
} from "openclaw/plugin-sdk/embedding-provider-adapter";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createAlibabaEmbeddingProvider,
  DEFAULT_ALIBABA_EMBEDDING_MODEL,
} from "./embedding-provider.js";

export const alibabaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "alibaba",
  defaultModel: DEFAULT_ALIBABA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "alibaba",
  autoSelectPriority: 40,
  allowExplicitWhenConfiguredAuto: true,
  supportsMultimodalEmbeddings: () => true,
  shouldContinueAutoSelection: isMissingEmbeddingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createAlibabaEmbeddingProvider({
      ...options,
      provider: "alibaba",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "alibaba",
        // The multimodal contents protocol has no batch-file endpoint, so the
        // provider's own embedBatch path owns batching and inline image fusion.
        cacheKeyData: {
          provider: "alibaba",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"]),
        },
      },
    };
  },
};
