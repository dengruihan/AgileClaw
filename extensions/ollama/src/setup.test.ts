import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { configureOllamaNonInteractive, promptAndConfigureOllama } from "./setup.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
    response: await globalThis.fetch(params.url, {
      ...params.init,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    upsertAuthProfileWithLock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: Parameters<typeof actual.fetchWithSsrFGuard>) =>
      fetchWithSsrFGuardMock(...args),
  };
});

function createOllamaFetchMock(params: {
  tags?: string[];
  show?: Record<string, number | undefined>;
  capabilities?: Record<string, string[] | undefined>;
  pullResponse?: Response;
  tagsError?: Error;
  meResponse?: Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/api/tags")) {
      if (params.tagsError) {
        throw params.tagsError;
      }
      return jsonResponse({ models: (params.tags ?? []).map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(requestBodyText(init?.body)) as { model?: string };
      const contextWindow = body.model ? params.show?.[body.model] : undefined;
      const capabilities = body.model
        ? params.capabilities === undefined
          ? ["tools"]
          : params.capabilities[body.model]
        : undefined;
      return jsonResponse({
        ...(contextWindow ? { model_info: { "llama.context_length": contextWindow } } : {}),
        ...(capabilities ? { capabilities } : {}),
      });
    }
    if (url.endsWith("/api/me")) {
      return params.meResponse ?? jsonResponse({});
    }
    if (url.endsWith("/api/pull")) {
      return params.pullResponse ?? new Response('{"status":"success"}\n', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mock.mock.calls.at(index)?.at(argIndex);
}

function abortReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted", { cause: signal.reason });
}

function createLocalPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce("local-only"),
    text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
    note: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WizardPrompter;
}

function createCloudPrompter(): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce("cloud-only"),
    confirm: vi.fn().mockResolvedValueOnce(false),
    text: vi.fn().mockResolvedValueOnce("test-ollama-key"),
    note: vi.fn(async () => undefined),
  } as unknown as WizardPrompter;
}

function createCloudLocalPrompter(): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce("cloud-local"),
    text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
    note: vi.fn(async () => undefined),
  } as unknown as WizardPrompter;
}

function createDefaultOllamaConfig(primary: string) {
  return {
    agents: { defaults: { model: { primary } } },
    models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
  };
}

describe("ollama setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    upsertAuthProfileWithLock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
  });

  it("puts suggested local model first in local mode", async () => {
    const prompter = createLocalPrompter();

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds?.[0]).toBe("gemma4");
    expect(result.config.models?.providers?.ollama?.apiKey).toBe("ollama-local");
    expect(result.credential).toBeUndefined();
  });

  it("Docker setup defaults to the host Ollama endpoint", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const text = vi.fn().mockResolvedValueOnce("http://host.docker.internal:11434");
    const prompter = createLocalPrompter({ text });

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    const baseUrlPrompt = mockCallArg(text) as {
      message?: string;
      initialValue?: string;
      placeholder?: string;
      validate?: unknown;
    };
    expect(baseUrlPrompt).toEqual({
      message: "Ollama base URL",
      initialValue: "http://host.docker.internal:11434",
      placeholder: "http://host.docker.internal:11434",
      validate: baseUrlPrompt.validate,
    });
    expect(typeof baseUrlPrompt.validate).toBe("function");
    expect(mockCallArg(fetchMock)).toBe("http://host.docker.internal:11434/api/tags");
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe(
      "http://host.docker.internal:11434",
    );
  });

  it("uses generic token flags for cloud-only setup", async () => {
    const prompter = createCloudPrompter();
    vi.stubGlobal("fetch", createOllamaFetchMock({ tags: [] }));

    const result = await promptAndConfigureOllama({
      cfg: {},
      env: {},
      opts: {
        token: "generic-ollama-key",
        tokenProvider: "ollama",
      },
      prompter,
      allowSecretRefPrompt: false,
    });

    expect(result.credential).toBe("generic-ollama-key");
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("puts hybrid cloud model suggestions after the local default when signed in", async () => {
    const prompter = createCloudLocalPrompter();
    const fetchMock = createOllamaFetchMock({
      tags: ["llama3:8b"],
      meResponse: jsonResponse({ user: "signed-in" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds).toEqual([
      "gemma4",
      "minimax-m2.7:cloud",
      "minimax-m3:cloud",
      "kimi-k3:cloud",
      "glm-5.1:cloud",
      "glm-5.2:cloud",
      "llama3:8b",
    ]);
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    expect(result.config.models?.providers?.ollama?.apiKey).toBe("ollama-local");
    expect(result.credential).toBeUndefined();
  });

  it("dedupes the suggested local model against a discovered latest tag", async () => {
    const prompter = createLocalPrompter();

    const fetchMock = createOllamaFetchMock({ tags: ["GEMMA4:latest", "llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);
    expect(modelIds).toEqual(["GEMMA4:latest", "llama3:8b"]);
  });

  it("cloud mode does not hit local Ollama endpoints", async () => {
    const prompter = createCloudPrompter();
    const fetchMock = createOllamaFetchMock({ tags: [] });
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({
      cfg: {},
      env: {},
      prompter,
      allowSecretRefPrompt: false,
    });

    const requestUrls = fetchMock.mock.calls.map((call) => requestUrl(call[0]));
    expect(requestUrls).toEqual(["https://ollama.com/api/tags"]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-ollama-key",
    );
  });

  it("rejects the local marker during cloud-only setup", async () => {
    const prompter = createCloudPrompter();

    await expect(
      promptAndConfigureOllama({
        cfg: {},
        env: {},
        opts: {
          ollamaApiKey: "ollama-local",
        },
        prompter,
        allowSecretRefPrompt: false,
      }),
    ).rejects.toThrow("Cloud-only Ollama setup requires a real OLLAMA_API_KEY.");
  });

  it("local mode only hits local model discovery endpoints", async () => {
    const prompter = createLocalPrompter();

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/show",
    ]);
  });

  it("asks for Ollama mode before cloud api key", async () => {
    const events: string[] = [];
    const prompter = {
      select: vi.fn(async () => {
        events.push("select");
        return "cloud-only";
      }),
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => {
        events.push("text");
        return "test-ollama-key";
      }),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;
    vi.stubGlobal("fetch", createOllamaFetchMock({ tags: [] }));

    await promptAndConfigureOllama({
      cfg: {},
      env: {},
      prompter,
      allowSecretRefPrompt: false,
    });

    expect(events).toEqual(["select", "text"]);
  });

  it("retries the configured host after showing unreachable guidance", async () => {
    const prompter = createLocalPrompter();
    prompter.confirm = vi.fn().mockResolvedValueOnce(true);
    const reachableFetch = createOllamaFetchMock({ tags: ["qwen3:0.6b"] });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockImplementation(reachableFetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(prompter.note).toHaveBeenCalledWith(
      [
        "Ollama could not be reached at http://127.0.0.1:11434.",
        "Start or restart the Ollama server for this address.",
        "If Ollama is not installed on that machine, download it at https://ollama.com/download",
        "",
        "Continue when it is running. OpenClaw will retry this address.",
      ].join("\n"),
      "Ollama",
    );
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Retry this Ollama address now?",
      initialValue: true,
    });
    expect(result.config.models?.providers?.ollama?.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "qwen3:0.6b" })]),
    );
  });

  it("reports the configured host when the retry is still unreachable", async () => {
    const prompter = createLocalPrompter();
    prompter.confirm = vi.fn().mockResolvedValueOnce(true);
    const fetchMock = createOllamaFetchMock({ tagsError: new Error("down") });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      promptAndConfigureOllama({
        cfg: {},
        prompter,
      }),
    ).rejects.toThrow("Ollama is still not reachable at http://127.0.0.1:11434");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cloud + local mode falls back to local models when ollama signin is missing", async () => {
    const prompter = createCloudLocalPrompter();
    const fetchMock = createOllamaFetchMock({
      tags: ["llama3:8b"],
      meResponse: new Response(JSON.stringify({ signin_url: "https://ollama.com/signin" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.config.models?.providers?.ollama?.models?.map((m) => m.id)).toEqual([
      "gemma4",
      "llama3:8b",
    ]);
    expect(prompter.note).toHaveBeenCalledWith(
      [
        "Cloud models on this Ollama host need `ollama signin`.",
        "https://ollama.com/signin",
        "",
        "Continuing with local models only for now.",
      ].join("\n"),
      "Ollama Cloud + Local",
    );
  });

  it("cloud mode falls back to the hardcoded cloud model list when /api/tags is empty", async () => {
    const prompter = createCloudPrompter();
    vi.stubGlobal("fetch", createOllamaFetchMock({ tags: [] }));
    const result = await promptAndConfigureOllama({
      cfg: {},
      env: {},
      prompter,
      allowSecretRefPrompt: false,
    });
    const models = result.config.models?.providers?.ollama?.models;
    const modelIds = models?.map((m) => m.id);

    expect(modelIds).toEqual(["minimax-m2.7", "minimax-m3", "kimi-k3", "glm-5.1", "glm-5.2"]);
    expect(result.defaultModel).toBe("ollama/minimax-m2.7");
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe("https://ollama.com");
    expect(result.config.models?.providers?.ollama?.apiKey).toBe("test-ollama-key");
    expect(result.credential).toBe("test-ollama-key");
    expect(models?.every((model) => model.contextTokens === undefined)).toBe(true);
    expect(models).toEqual(
      expect.arrayContaining(
        [
          { id: "minimax-m2.7", contextWindow: 196_608 },
          { id: "glm-5.1", contextWindow: 202_752 },
          { id: "glm-5.2", contextWindow: 1_000_000 },
        ].map((model) =>
          expect.objectContaining({
            ...model,
            reasoning: true,
            input: ["text"],
            compat: { supportsTools: true, supportsUsageInStreaming: true },
          }),
        ),
      ),
    );
  });

  it("cloud mode populates models from ollama.com /api/tags when reachable", async () => {
    const prompter = createCloudPrompter();
    const fetchMock = createOllamaFetchMock({
      tags: ["qwen3-coder:480b-cloud", "gpt-oss:120b-cloud"],
      show: { "qwen3-coder:480b-cloud": 262144 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      env: {},
      prompter,
      allowSecretRefPrompt: false,
    });
    const models = result.config.models?.providers?.ollama?.models;
    const modelIds = models?.map((m) => m.id);

    expect(modelIds).toEqual([
      "minimax-m2.7",
      "minimax-m3",
      "kimi-k3",
      "glm-5.1",
      "glm-5.2",
      "qwen3-coder:480b-cloud",
      "gpt-oss:120b-cloud",
    ]);
    const requestUrls = fetchMock.mock.calls.map((call) => requestUrl(call[0]));
    expect(requestUrls.filter((url) => url.endsWith("/api/show"))).toEqual([]);
    expect(requestUrls).toContain("https://ollama.com/api/tags");
  });

  it("uses /api/show context windows when building Ollama model configs", async () => {
    const prompter = createLocalPrompter();

    const fetchMock = createOllamaFetchMock({
      tags: ["llama3:8b"],
      show: { "llama3:8b": 65536 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const model = result.config.models?.providers?.ollama?.models?.find(
      (m) => m.id === "llama3:8b",
    );

    expect(model).toMatchObject({ contextWindow: 65_536, contextTokens: 32_768 });
    expect(result.defaultModel).toBe("ollama/llama3:8b");
  });

  it("does not offer a pull when installed-model capability inspection fails", async () => {
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const baseFetch = createOllamaFetchMock({ tags: ["llama3:8b"] });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).endsWith("/api/show")) {
        return new Response("unavailable", { status: 503 });
      }
      return await baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("could not be inspected"),
      "Ollama",
    );
    expect(result.config.models?.providers?.ollama).toBeDefined();
  });

  it("skips a broken model and continues setup when one inspection fails", async () => {
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const baseFetch = createOllamaFetchMock({
      tags: ["broken:20b", "gemma4:e4b"],
      capabilities: { "gemma4:e4b": ["tools"] },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).endsWith("/api/show")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body.model === "broken:20b") {
          return new Response("boom", { status: 500 });
        }
      }
      return await baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining("broken:20b"), "Ollama");
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "gemma4:e4b"),
    ).toMatchObject({ compat: { supportsTools: true } });
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "broken:20b"),
    ).toMatchObject({ compat: { supportsTools: false } });
  });

  it("checks all installed Ollama models before offering a recommended pull", async () => {
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(
      tags.map((name, index) => [name, index === 200 ? ["tools"] : ["generate"]]),
    );
    const fetchMock = createOllamaFetchMock({ tags, capabilities });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter((call) => requestUrl(call[0]).endsWith("/api/show")),
    ).toHaveLength(201);
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "model-200"),
    ).toMatchObject({ compat: { supportsTools: true } });
  });

  it("aborts the exhaustive tools-capability scan with the setup session", async () => {
    const controller = new AbortController();
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(tags.map((name) => [name, ["generate"]]));
    const baseFetch = createOllamaFetchMock({ tags, capabilities });
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(requestBodyText(init.body)) as { model?: string }) : {};
      if (!requestUrl(input).endsWith("/api/show") || body.model !== "model-200") {
        return await baseFetch(input, init);
      }
      markScanStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected tools scan abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = promptAndConfigureOllama({ cfg: {}, prompter, signal: controller.signal });
    await scanStarted;
    controller.abort();

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
    expect(prompter.confirm).not.toHaveBeenCalled();
  });
});
