import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { registerProviderStreamForModel } from "./provider-stream.js";

const { fetchWithSsrFGuard, prepare, providerStream, runtimeHandle } = vi.hoisted(() => {
  const prepareMock = vi.fn(async (_auth?: { mode: string; authFlow?: string }) => undefined);
  return {
    fetchWithSsrFGuard: vi.fn(),
    prepare: prepareMock,
    providerStream: vi.fn(),
    runtimeHandle: {
      provider: "test-provider",
      modelId: "test-model",
      plugin: {
        wrapStreamFn: ({
          streamFn,
          auth,
        }: {
          streamFn: typeof providerStream;
          auth?: { mode: string; authFlow?: string };
        }) => {
          return async (...args: Parameters<typeof providerStream>) => {
            await prepareMock(auth);
            return streamFn(...args);
          };
        },
      },
    },
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode: vi.fn((params) => params),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: vi.fn(() => providerStream),
}));

vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderRuntimePluginHandle: (
      params: Parameters<typeof actual.resolveProviderRuntimePluginHandle>[0],
    ) => ({ ...runtimeHandle, provider: params.provider, modelId: params.modelId }),
  };
});

describe("provider stream lifecycle registration", () => {
  beforeEach(() => {
    fetchWithSsrFGuard.mockReset().mockResolvedValue({
      response: new Response("ok"),
      finalUrl: "http://127.0.0.1:19432/v1/responses",
      release: vi.fn(async () => undefined),
    });
    prepare.mockClear();
    providerStream.mockReset();
    vi.mocked(resolveProviderStreamFn).mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers provider streams with the resolved runtime lifecycle handle", async () => {
    providerStream.mockReturnValue(createAssistantMessageEventStream());
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = bindModelLlmRuntime(
      {
        api: "test-lifecycle-provider",
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 512,
      },
      llmRuntime,
    );

    const auth = { mode: "api-key", authFlow: undefined };
    const streamFn = registerProviderStreamForModel({ model, wrapProviderStream: true, auth });
    expect(streamFn).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("test-lifecycle-provider")).toBeDefined();
    await streamFn?.(model, {} as never, {});
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(auth);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      providerStream.mock.invocationCallOrder[0]!,
    );
  });

  it("passes agent and workspace context to the provider stream resolver", async () => {
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = bindModelLlmRuntime(
      {
        api: "ollama",
        provider: "ollama",
        id: "qwen3:8b",
        name: "Test Model",
        baseUrl: "http://127.0.0.1:19432/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 512,
      },
      llmRuntime,
    );
    expect(apiRegistry.getApiProvider("ollama")).toBeUndefined();
    const streamFn = registerProviderStreamForModel({
      model,
      agentDir: "/tmp/test-agent",
      workspaceDir: "/tmp/test-workspace",
      apiRegistry,
    });

    expect(vi.mocked(resolveProviderStreamFn).mock.calls[0]?.[0].context).toMatchObject({
      agentDir: "/tmp/test-agent",
      workspaceDir: "/tmp/test-workspace",
      provider: "ollama",
      modelId: "qwen3:8b",
      model: { api: "ollama", provider: "ollama", id: "qwen3:8b" },
    });
    expect(streamFn).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("ollama")).toBeDefined();
  });
});
