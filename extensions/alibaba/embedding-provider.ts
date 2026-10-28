import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import {
  hasNonTextEmbeddingParts,
  normalizeEmbeddingModelWithPrefixes,
  postJsonWithRetry,
  resolveRemoteEmbeddingClient,
  type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
  type RemoteEmbeddingClient,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

/**
 * Alibaba Model Studio (DashScope) multimodal embeddings. Text queries and
 * indexed Markdown use the shared contents array; inline image parts fuse
 * with their label text into one vector via enable_fusion, so the whole
 * memory index lives in a single text/image semantic space.
 */

export const DEFAULT_ALIBABA_EMBEDDING_MODEL = "qwen3-vl-embedding";
const DEFAULT_ALIBABA_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com";
const MULTIMODAL_EMBEDDING_PATH =
  "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
/** API limit on contents elements per multimodal-embedding request. */
const CONTENTS_PER_REQUEST = 20;
const QWEN_VL_MAX_INPUT_TOKENS = 32_000;

type DashScopeEmbeddingEntry = {
  index?: unknown;
  embedding?: unknown;
  type?: unknown;
};

type DashScopeEmbeddingPayload = {
  output?: { embeddings?: DashScopeEmbeddingEntry[] };
};

function normalizeAlibabaModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_ALIBABA_EMBEDDING_MODEL,
    prefixes: ["alibaba/", "dashscope/"],
  });
}

/** Inline image bytes become data URIs; the multimodal API has no other inline media. */
function toContents(
  input: Exclude<EmbeddingInput, string>,
): Array<{ text: string } | { image: string }> {
  const parts = input.parts ?? [{ type: "text" as const, text: input.text }];
  return parts.map((part) => {
    if (part.type === "text") {
      return { text: part.text };
    }
    if (part.mimeType.startsWith("image/")) {
      return { image: `data:${part.mimeType};base64,${part.data}` };
    }
    throw new Error(
      `alibaba multimodal embeddings do not accept inline ${part.mimeType} input; index images only`,
    );
  });
}

function isNumberVector(values: unknown): values is number[] {
  return (
    Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "number")
  );
}

function readEmbeddingValues(
  entry: DashScopeEmbeddingEntry | undefined,
  expectedIndex: number,
): number[] {
  if (entry?.index !== expectedIndex || !isNumberVector(entry?.embedding)) {
    throw new Error("alibaba multimodal embeddings returned a malformed embedding payload");
  }
  return entry.embedding;
}

export async function createAlibabaEmbeddingProvider(
  options: MemoryEmbeddingProviderCreateOptions,
): Promise<{ provider: MemoryEmbeddingProvider; client: RemoteEmbeddingClient }> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "alibaba",
    options,
    defaultBaseUrl: DEFAULT_ALIBABA_EMBEDDING_BASE_URL,
    normalizeModel: normalizeAlibabaModel,
  });
  const url = `${client.baseUrl.replace(/\/+$/, "")}${MULTIMODAL_EMBEDDING_PATH}`;
  const dimension =
    typeof options.dimensions === "number" && options.dimensions > 0
      ? options.dimensions
      : undefined;
  const errorPrefix = "alibaba multimodal embeddings failed";

  const postContents = async (
    contents: Array<{ text: string } | { image: string }>,
    fusion: boolean,
  ): Promise<DashScopeEmbeddingEntry[]> => {
    const payload = await postJsonWithRetry<DashScopeEmbeddingPayload>({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      errorPrefix,
      body: {
        model: client.model,
        input: { contents },
        parameters: {
          ...(fusion ? { enable_fusion: true } : {}),
          ...(dimension !== undefined ? { dimension } : {}),
        },
      },
    });
    const embeddings = payload.output?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error(`${errorPrefix}: response carried no embeddings`);
    }
    return embeddings;
  };

  const embedTextGroup = async (texts: readonly string[]): Promise<number[][]> => {
    const entries = await postContents(
      texts.map((text) => ({ text })),
      false,
    );
    return texts.map((_, index) => readEmbeddingValues(entries[index], index));
  };

  const embedFusedInput = async (input: Exclude<EmbeddingInput, string>): Promise<number[]> => {
    const entries = await postContents(toContents(input), true);
    // Fusion mode collapses every content into exactly one vector.
    const fused =
      entries.find((entry) => entry.type === "fusion") ??
      (entries.length === 1 ? entries[0] : undefined);
    if (!fused || !isNumberVector(fused.embedding)) {
      throw new Error(`${errorPrefix}: fusion response carried no fused embedding`);
    }
    return fused.embedding;
  };

  return {
    provider: {
      id: "alibaba",
      model: client.model,
      maxInputTokens: QWEN_VL_MAX_INPUT_TOKENS,
      embed: async (input) => {
        if (typeof input !== "string" && hasNonTextEmbeddingParts(input)) {
          return await embedFusedInput(input);
        }
        const text = typeof input === "string" ? input : input.text;
        const [vector] = await embedTextGroup([text]);
        return vector ?? [];
      },
      embedBatch: async (inputs) => {
        const results: Array<number[] | undefined> = Array.from({ length: inputs.length });
        const plainIndexes: number[] = [];
        const plainTexts: string[] = [];
        const structuredInputs: Array<{ index: number; input: Exclude<EmbeddingInput, string> }> =
          [];
        for (const [index, input] of inputs.entries()) {
          if (typeof input !== "string" && hasNonTextEmbeddingParts(input)) {
            structuredInputs.push({ index, input });
          } else {
            plainIndexes.push(index);
            plainTexts.push(typeof input === "string" ? input : input.text);
          }
        }
        for (let start = 0; start < plainTexts.length; start += CONTENTS_PER_REQUEST) {
          const groupTexts = plainTexts.slice(start, start + CONTENTS_PER_REQUEST);
          const groupVectors = await embedTextGroup(groupTexts);
          groupTexts.forEach((_, offset) => {
            results[plainIndexes[start + offset]!] = groupVectors[offset];
          });
        }
        await Promise.all(
          structuredInputs.map(async ({ index, input }) => {
            results[index] = await embedFusedInput(input);
          }),
        );
        return results.map((vector) => vector ?? []);
      },
    },
    client,
  };
}
