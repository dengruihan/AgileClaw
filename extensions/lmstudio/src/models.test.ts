import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import { discoverLmstudioModels, fetchLmstudioModels } from "./models.fetch.js";
import {
  mapLmstudioWireEntry,
  mapLmstudioWireModelsToConfig,
  normalizeLmstudioConfiguredCatalogEntry,
  normalizeLmstudioProviderConfig,
  resolveLmstudioInferenceBase,
  resolveLmstudioReasoningCompat,
  resolveLmstudioServerBase,
} from "./models.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

function malformedJsonResponse(): Response {
  return new Response("{ nope", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("lmstudio-models", () => {
  const asFetch = (mock: unknown) => mock as typeof fetch;
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes LM Studio base URLs", () => {
    expect(resolveLmstudioServerBase()).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase()).toBe("http://localhost:1234/v1");
    expect(resolveLmstudioServerBase("http://localhost:1234/api/v1")).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase("http://localhost:1234/api/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(resolveLmstudioServerBase("localhost:1234/api/v1")).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase("localhost:1234/api/v1")).toBe("http://localhost:1234/v1");
  });

  it("marks configured LM Studio endpoints as trusted private-network model targets", () => {
    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://192.168.1.10:1234",
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://192.168.1.10:1234/v1",
      request: { allowPrivateNetwork: true },
      models: [],
    });

    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://gpu-box.local:1234/v1",
        request: {
          allowPrivateNetwork: false,
          headers: { "X-Proxy-Auth": "token" },
        },
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://gpu-box.local:1234/v1",
      request: {
        allowPrivateNetwork: false,
        headers: { "X-Proxy-Auth": "token" },
      },
      models: [],
    });
  });

  it("rejects malformed and unapproved configured compatibility fields", () => {
    expect(
      normalizeLmstudioConfiguredCatalogEntry({
        id: "qwen/qwen3-1.7b",
        compat: {
          supportsStore: "false",
          supportsPromptCacheKey: 1,
          visibleReasoningDetailTypes: ["reasoning.summary", 1],
          maxTokensField: "max_output_tokens",
          codeMode: "unsupported",
          thinkingFormat: "unsupported",
          toolSchemaProfile: 1,
          unsupportedToolSchemaKeywords: ["additionalProperties", ""],
          toolCallArgumentsEncoding: false,
          requiresOpenAiAnthropicToolPayload: "true",
          unapprovedCompatField: true,
        },
      }),
    ).toMatchObject({
      id: "qwen/qwen3-1.7b",
      compat: undefined,
    });
  });

  it.each([
    { label: "enabled", supportsTools: true },
    { label: "disabled", supportsTools: false },
    { label: "unknown", supportsTools: undefined },
  ])("preserves $label native tool support in runtime and setup models", ({ supportsTools }) => {
    const entry = {
      type: "llm" as const,
      key: "qwen3-8b-instruct",
      capabilities: {
        ...(supportsTools === undefined ? {} : { trained_for_tool_use: supportsTools }),
        reasoning: { allowed_options: ["off", "on"], default: "on" },
      },
    };
    const expectedCompat = {
      ...(supportsTools === true ? { supportsTools } : {}),
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      reasoningEffortMap: {
        off: "none",
        none: "none",
        adaptive: "xhigh",
        max: "xhigh",
      },
    };

    expect(mapLmstudioWireEntry(entry)?.compat).toEqual(expectedCompat);
    expect(mapLmstudioWireModelsToConfig([entry])[0]?.compat).toEqual(expectedCompat);
  });

  it("drops malformed discovered context metadata", () => {
    const model = mapLmstudioWireEntry({
      type: "llm",
      key: "bad-context",
      max_context_length: 32768.5,
      loaded_instances: [{ id: "loaded", config: { context_length: Number.POSITIVE_INFINITY } }],
    });

    expect(model).toMatchObject({
      id: "bad-context",
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
      loaded: false,
    });
  });

  it("uses the loaded context as the effective runtime budget", () => {
    const model = mapLmstudioWireEntry({
      type: "llm",
      key: "small-loaded-context",
      max_context_length: 262_144,
      loaded_instances: [{ id: "loaded", config: { context_length: 8_192 } }],
    });

    expect(model).toMatchObject({
      id: "small-loaded-context",
      contextWindow: 262_144,
      contextTokens: 8_192,
      maxTokens: 8_192,
      loaded: true,
    });
  });

  it("keeps a loaded context above the default load length", () => {
    const model = mapLmstudioWireEntry({
      type: "llm",
      key: "large-loaded-context",
      max_context_length: 262_144,
      loaded_instances: [{ id: "loaded", config: { context_length: 98_304 } }],
    });

    // The default load length only governs the JIT load request for unloaded
    // models; a running instance decides its own serving context.
    expect(model).toMatchObject({
      id: "large-loaded-context",
      contextWindow: 262_144,
      contextTokens: 98_304,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
      loaded: true,
    });
  });

  it("omits reasoning compatibility when only off is supported", () => {
    expect(
      resolveLmstudioReasoningCompat({
        capabilities: {
          reasoning: {
            allowed_options: ["off"],
            default: "off",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("discovers llm models and maps metadata", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({
        models: [
          {
            type: "llm",
            key: "qwen3-8b-instruct",
            display_name: "Qwen3 8B",
            max_context_length: 262144,
            format: "mlx",
            capabilities: {
              vision: true,
              trained_for_tool_use: true,
              reasoning: {
                allowed_options: ["off", "on"],
                default: "on",
              },
            },
            loaded_instances: [{ id: "inst-1", config: { context_length: 64000 } }],
          },
          {
            type: "llm",
            key: "deepseek-r1",
          },
          {
            type: "llm",
            key: "graded-reasoning",
            capabilities: {
              reasoning: { allowed_options: ["low", "medium", "high"], default: "low" },
            },
          },
          {
            type: "llm",
            key: "off-only-reasoning",
            capabilities: {
              reasoning: { allowed_options: ["off"], default: "off" },
            },
          },
          {
            type: "embedding",
            key: "text-embedding-nomic-embed-text-v1.5",
          },
          {
            type: "llm",
            key: "   ",
          },
        ],
      }),
    );

    const models = await discoverLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lm-token",
      quiet: false,
      fetchImpl: asFetch(fetchMock),
    });

    const modelsRequest = fetchMock.mock.calls.find(
      ([url]) => url === "http://localhost:1234/api/v1/models",
    );
    const modelsRequestOptions = modelsRequest?.[1] as
      | { headers?: Record<string, string>; signal?: unknown }
      | undefined;
    expect(modelsRequestOptions?.headers).toEqual({
      Authorization: "Bearer lm-token",
    });
    expect(modelsRequestOptions?.signal).toBeInstanceOf(AbortSignal);

    expect(models).toHaveLength(4);
    expect(models[0]).toEqual({
      id: "qwen3-8b-instruct",
      name: "Qwen3 8B (MLX, vision, tool-use, loaded)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        reasoningEffortMap: {
          off: "none",
          none: "none",
          adaptive: "xhigh",
          max: "xhigh",
        },
        supportsTools: true,
      },
      contextWindow: 262144,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    expect(models[1]).toEqual({
      id: "deepseek-r1",
      name: "deepseek-r1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true },
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    expect(models[2]).toMatchObject({ id: "graded-reasoning", reasoning: true });
    expect(models[2]?.compat).toEqual({
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: { adaptive: "high", max: "high" },
    });
    expect(models[3]).toMatchObject({ id: "off-only-reasoning", reasoning: false });
    expect(models[3]?.compat).toEqual({ supportsUsageInStreaming: true });
  });

  it("cancels the response body after a non-ok model discovery response", async () => {
    const tracked = cancelTrackedTextResponse("unavailable", { status: 503 });
    const fetchMock = vi.fn(async () => tracked.response);

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: asFetch(fetchMock),
    });

    expect(result).toEqual({
      reachable: true,
      status: 503,
      models: [],
    });
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each([
    {
      name: "reports malformed model list JSON with an owned error",
      responses: () => [malformedJsonResponse()],
    },
    {
      name: "reports wrong-shaped model list payloads with owned errors",
      responses: () =>
        [[], { models: {} }, { models: [null] }].map((payload) => Response.json(payload)),
    },
  ])("$name", async ({ responses }) => {
    for (const response of responses()) {
      const result = await fetchLmstudioModels({
        baseUrl: "http://localhost:1234/v1",
        fetchImpl: asFetch(vi.fn(async () => response)),
      });
      expect(result.reachable).toBe(false);
      expect((result.error as Error).message).toBe("LM Studio model list: malformed JSON response");
    }
  });

  it("discovers valid local models from partially malformed catalogs", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        models: [null, { type: "llm", key: "qwen3-8b-instruct" }, [], "invalid-model", 42],
      }),
    );

    const models = await discoverLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lm-token",
      quiet: true,
      fetchImpl: asFetch(fetchMock),
    });

    expect(models).toEqual([expect.objectContaining({ id: "qwen3-8b-instruct" })]);
  });

  it("caps oversized direct fetch timeouts before discovering models", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      Response.json({ models: [] }),
    );

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      fetchImpl: asFetch(fetchMock),
    });

    expect(result.reachable).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutController.signal);
  });

  it("caps oversized guarded-fetch timeouts before discovering models", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ models: [] }), { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      ssrfPolicy: {},
    });

    expect(result.reachable).toBe(true);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });
});
