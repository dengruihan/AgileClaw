import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import type { MemoryEmbeddingProviderCreateOptions } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAlibabaEmbeddingProvider } from "./embedding-provider.js";

type RequestRecord = { url: string; body: Record<string, unknown> };

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function stubEmbeddingFetch(respond: (record: RequestRecord) => unknown) {
  const records: RequestRecord[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const rawBody = init?.body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<
      string,
      unknown
    >;
    records.push({ url, body });
    const payload = respond({ url, body });
    return Response.json(payload);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { records, fetchMock };
}

function createOptions(
  overrides?: Partial<MemoryEmbeddingProviderCreateOptions>,
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: { models: { providers: {} } } as unknown as OpenClawConfig,
    remote: { apiKey: "fixture-dashscope" },
    model: "qwen3-vl-embedding",
    ...overrides,
  };
}

function textPayload(vectors: number[][]) {
  return {
    output: {
      embeddings: vectors.map((embedding, index) => ({ index, embedding, type: "text" })),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alibaba multimodal embedding provider", () => {
  it("batches plain text inputs into indexed contents without fusion", async () => {
    const { records } = stubEmbeddingFetch(() =>
      textPayload([
        [0.1, 0.2],
        [0.3, 0.4],
      ]),
    );
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    const vectors = await provider.embedBatch([{ text: "first" }, { text: "second" }]);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.url).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    );
    expect(records[0]!.body).toEqual({
      model: "qwen3-vl-embedding",
      input: { contents: [{ text: "first" }, { text: "second" }] },
      parameters: {},
    });
  });

  it("splits text batches at the contents limit", async () => {
    const { records } = stubEmbeddingFetch(({ body }) => {
      const contents = (body.input as { contents: unknown[] }).contents;
      return textPayload(contents.map((_, index) => [index]));
    });
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    const inputs = Array.from({ length: 25 }, (_, index) => ({ text: `t${index}` }));
    const vectors = await provider.embedBatch(inputs);
    expect(vectors).toEqual([
      ...Array.from({ length: 20 }, (_, index) => [index]),
      ...Array.from({ length: 5 }, (_, index) => [index]),
    ]);
    expect(
      records.map((record) => (record.body.input as { contents: unknown[] }).contents.length),
    ).toEqual([20, 5]);
  });

  it("fuses inline image parts with their label into one vector", async () => {
    const { records } = stubEmbeddingFetch(() => ({
      output: { embeddings: [{ index: 0, embedding: [0.9, 0.8], type: "fusion" }] },
    }));
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    const input: EmbeddingInput = {
      text: "Image: memory/shot.png",
      parts: [
        { type: "text", text: "Image: memory/shot.png" },
        { type: "inline-data", mimeType: "image/png", data: "aWNvbg==" },
      ],
    };
    await expect(provider.embed(input)).resolves.toEqual([0.9, 0.8]);
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toEqual({
      model: "qwen3-vl-embedding",
      input: {
        contents: [{ text: "Image: memory/shot.png" }, { image: "data:image/png;base64,aWNvbg==" }],
      },
      parameters: { enable_fusion: true },
    });
  });

  it("keeps mixed batches in input order across text and fused image paths", async () => {
    const { records } = stubEmbeddingFetch(({ body }) => {
      const parameters = body.parameters as { enable_fusion?: boolean };
      return parameters.enable_fusion === true
        ? { output: { embeddings: [{ index: 0, embedding: [7, 7], type: "fusion" }] } }
        : textPayload([[1, 1]]);
    });
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    const vectors = await provider.embedBatch([
      { text: "plain" },
      {
        text: "Image: memory/a.jpg",
        parts: [{ type: "inline-data", mimeType: "image/jpeg", data: "aw==" }],
      },
    ]);
    expect(vectors).toEqual([
      [1, 1],
      [7, 7],
    ]);
    expect(records).toHaveLength(2);
  });

  it("normalizes model prefixes and passes the configured dimension", async () => {
    const { records } = stubEmbeddingFetch(() => textPayload([[1]]));
    const { provider } = await createAlibabaEmbeddingProvider(
      createOptions({ model: "alibaba/qwen3-vl-embedding", dimensions: 1152 }),
    );
    await expect(provider.embed("hello")).resolves.toEqual([1]);
    expect(records[0]!.body.model).toBe("qwen3-vl-embedding");
    expect(records[0]!.body.parameters).toEqual({ dimension: 1152 });
    expect(provider.model).toBe("qwen3-vl-embedding");
  });

  it("rejects non-image inline media instead of sending an unsupported request", async () => {
    const { fetchMock } = stubEmbeddingFetch(() => textPayload([[1]]));
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    await expect(
      provider.embed({
        text: "clip",
        parts: [{ type: "inline-data", mimeType: "audio/wav", data: "aw==" }],
      }),
    ).rejects.toThrow(/do not accept inline audio\/wav/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on malformed index-mapped responses", async () => {
    stubEmbeddingFetch(() => ({
      output: { embeddings: [{ index: 3, embedding: [1], type: "text" }] },
    }));
    const { provider } = await createAlibabaEmbeddingProvider(createOptions());
    await expect(provider.embed("hello")).rejects.toThrow(/malformed embedding payload/);
  });
});
