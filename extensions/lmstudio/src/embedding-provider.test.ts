// LM Studio embedding provider tests cover model resolution and memory identity.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lmstudioMemoryEmbeddingProviderAdapter } from "../memory-embedding-adapter.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const fetchLmstudioModelsMock = vi.hoisted(() =>
  vi.fn(
    async (
      _params?: unknown,
    ): Promise<{
      reachable: boolean;
      status?: number;
      models: Array<{
        type?: "llm" | "embedding";
        key?: string;
        variants?: unknown;
        selected_variant?: unknown;
        loaded_instances?: unknown[];
      }>;
    }> => ({
      reachable: true,
      status: 200,
      models: [],
    }),
  ),
);
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const embeddedModels = vi.hoisted(() => [] as string[]);
const createRemoteEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn((params: { client: { model: string } }) => {
    const providerModel = params.client.model;
    return {
      id: "lmstudio",
      model: providerModel,
      embed: vi.fn(async () => {
        embeddedModels.push(params.client.model);
        return [1, 0];
      }),
      embedBatch: vi.fn(async (texts: string[]) => {
        embeddedModels.push(params.client.model);
        return texts.map(() => [1, 0]);
      }),
    };
  }),
);

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    createRemoteEmbeddingProvider: createRemoteEmbeddingProviderMock,
  };
});

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    fetchLmstudioModels: (params: unknown) => fetchLmstudioModelsMock(params),
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioProviderHeaders: (params: unknown) => resolveLmstudioProviderHeadersMock(params),
    resolveLmstudioRuntimeApiKey: (params: unknown) => resolveLmstudioRuntimeApiKeyMock(params),
  };
});

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

function buildConfig(params: {
  model?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          models: [{ id: EMBEDDING_MODEL, ...params.model }],
          ...params.provider,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("createLmstudioEmbeddingProvider", () => {
  beforeEach(() => {
    fetchLmstudioModelsMock.mockClear();
    fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 200, models: [] });
    createRemoteEmbeddingProviderMock.mockClear();
    embeddedModels.length = 0;
    resolveLmstudioProviderHeadersMock.mockClear();
    resolveLmstudioRuntimeApiKeyMock.mockClear();
  });

  it("resolves a JIT variant before freezing provider and cache identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "embedding",
          key: EMBEDDING_MODEL,
          variants: [requestedVariant],
          selected_variant: requestedVariant,
          loaded_instances: [],
        },
      ],
    });

    const options = {
      config: buildConfig({ model: { id: requestedVariant } }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
    };
    const result = await lmstudioMemoryEmbeddingProviderAdapter.create(options);
    if (!result.provider) {
      throw new Error("expected LM Studio embedding provider");
    }

    expect(fetchLmstudioModelsMock).toHaveBeenCalledOnce();
    expect(result.provider.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });

    await expect(result.provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);

    expect(embeddedModels).toEqual([EMBEDDING_MODEL]);
  });

  it("keeps the requested model when discovery is unreachable", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: false,
      models: [],
    });

    const { client } = await createLmstudioEmbeddingProvider({
      config: buildConfig({ model: { id: requestedVariant } }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
    });

    expect(client.model).toBe(requestedVariant);
    expect(createRemoteEmbeddingProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: requestedVariant }) }),
    );
  });

  it("routes a remote endpoint override with its own tenant headers", async () => {
    const options = {
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "http://spark.local:1234/v1",
              apiKey: "provider-host-key",
              headers: { "X-Provider-Tenant": "provider-a" },
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
      remote: {
        baseUrl: "http://memory.local:1234/v1",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
    };
    const { provider, client } = await createLmstudioEmbeddingProvider(options);

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
    expect(client.headers).toEqual({
      "Content-Type": "application/json",
      "X-Remote-Tenant": "remote-b",
    });
  });

  it("preserves a scheme-added /api/v1 endpoint target", async () => {
    const options = {
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "spark.local:1234/api/v1",
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
    };

    const { client } = await createLmstudioEmbeddingProvider(options);

    expect(client.baseUrl).toBe("http://spark.local:1234/api/v1");
  });

  it("preserves configured provider aliases in the memory adapter", async () => {
    const result = await lmstudioMemoryEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "http://spark.local:1234/v1",
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "lmstudio-spark",
      baseUrl: "http://spark.local:1234/v1",
      model: EMBEDDING_MODEL,
    });
  });

  it("keeps API key rotation out of memory identity without dropping tenant headers", async () => {
    const readIdentity = async (headers: Record<string, string>) =>
      (
        await lmstudioMemoryEmbeddingProviderAdapter.create({
          config: buildConfig({}),
          provider: "lmstudio",
          model: EMBEDDING_MODEL,
          fallback: "none",
          remote: { headers },
        })
      ).runtime?.cacheKeyData;

    const defaultIdentity = await readIdentity({});
    const firstTenant = await readIdentity({
      Authorization: "Bearer synthetic-before",
      "X-API-KEY": "synthetic-key-before",
      "X-Tenant": "tenant-a",
    });
    const rotatedTenant = await readIdentity({
      Authorization: "Bearer synthetic-after",
      "x-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-a",
    });
    const otherTenant = await readIdentity({
      "X-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-b",
    });

    expect(defaultIdentity).toEqual({
      provider: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      model: EMBEDDING_MODEL,
      headers: [["Content-Type", "application/json"]],
    });
    expect(firstTenant).toEqual(rotatedTenant);
    expect(firstTenant).not.toEqual(otherTenant);
    expect(firstTenant).toMatchObject({
      headers: [
        ["Content-Type", "application/json"],
        ["X-Tenant", "tenant-a"],
      ],
    });
  });
});
