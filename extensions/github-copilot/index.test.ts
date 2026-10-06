// Github Copilot tests cover index plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  })),
  resolveCopilotRuntimeAuth: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./register.runtime.js", () => ({
  resolveCopilotRuntimeAuth: mocks.resolveCopilotRuntimeAuth,
}));

import plugin from "./index.js";
import { registerProviderWithPluginConfig } from "./provider.test-support.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function createModelRegistry() {
  return {
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
    find: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
  };
}

function writeProfiles(
  agentDir: string,
  profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"],
) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

function writeExistingCopilotApiKeyProfile(agentDir: string) {
  writeProfiles(agentDir, {
    "github-copilot:github": {
      type: "api_key",
      provider: "github-copilot",
      key: "existing-token",
    },
  });
}

describe("github-copilot plugin", () => {
  it("preserves the source token supplied by the auth layer for runtime auth", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const provider = registerProviderWithPluginConfig({});

    const prepared = await provider.prepareRuntimeAuth({
      config: {},
      env: {},
      provider: "github-copilot",
      modelId: "gpt-5-mini",
      model: { id: "gpt-5-mini", provider: "github-copilot" },
      apiKey: "github-source-token",
      authMode: "oauth",
    } as never);

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: "github-source-token",
      env: {},
      githubDomain: "github.com",
    });
    expect(prepared).toEqual({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      request: {
        headers: {
          "Accept-Encoding": "identity",
          "Copilot-Integration-Id": "copilot-developer-cli",
          "Editor-Plugin-Version": "copilot-chat/0.35.0",
          "Editor-Version": "vscode/1.107.0",
          "Openai-Organization": "github-copilot",
          "User-Agent": "GitHubCopilotChat/0.35.0",
        },
      },
    });
  });

  it.each([
    { headers: undefined, expected: "vscode-chat" },
    { headers: { "COPILOT-INTEGRATION-ID": "model-identity" }, expected: "model-identity" },
  ])(
    "honors the existing provider integration header during runtime authentication: $expected",
    async ({ headers, expected }) => {
      mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
        apiKey: "github-source-token",
        baseUrl: "https://copilot-api.acme.ghe.com",
      });
      const provider = registerProviderWithPluginConfig({});
      const prepared = await provider.prepareRuntimeAuth({
        config: {
          models: {
            providers: {
              "github-copilot": {
                headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
                request: { headers: { "copilot-integration-id": "vscode-chat" } },
              },
            },
          },
        },
        env: {},
        provider: "github-copilot",
        modelId: "claude-sonnet-5",
        model: { id: "claude-sonnet-5", provider: "github-copilot", headers },
        apiKey: "github-source-token",
        authMode: "token",
      } as never);

      expect(new Headers(prepared?.request?.headers).get("copilot-integration-id")).toBe(expected);
    },
  );

  it("rejects an unresolved integration SecretRef before catalog fallback or inference", async () => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const config = {
      models: {
        providers: {
          "github-copilot": {
            request: {
              headers: {
                "Copilot-Integration-Id": { source: "env", provider: "default", id: "IDENTITY" },
              },
            },
          },
        },
      },
    };
    mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
      apiKey: "github-source-token",
      baseUrl: "https://copilot-api.acme.ghe.com",
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.catalog.run({
        agentDir,
        config,
        env: { COPILOT_GITHUB_TOKEN: "github-source-token" },
      }),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    await expect(
      provider.prepareRuntimeAuth({
        config,
        env: {},
        provider: "github-copilot",
        modelId: "claude-sonnet-5",
        model: { id: "claude-sonnet-5", provider: "github-copilot" },
        apiKey: "github-source-token",
        authMode: "token",
      } as never),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates live catalog results by the configured integration header", async () => {
    const agentDir = await createAgentDir();
    writeExistingCopilotApiKeyProfile(agentDir);
    const provider = registerProviderWithPluginConfig({});
    const modelRegistry = createModelRegistry();
    mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
      apiKey: "identity-catalog-token",
      baseUrl: "https://copilot-api.acme.ghe.com",
    });
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        observedHeaders.push(headers);
        return Response.json({
          data: [
            {
              id: "gpt-5-mini",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
                limits: {
                  max_context_window_tokens:
                    headers.get("copilot-integration-id") === "vscode-chat" ? 100_000 : 200_000,
                },
              },
            },
          ],
        });
      }),
    );

    for (const identity of ["vscode-chat", "copilot-developer-cli"]) {
      const config = {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "https://copilot-api.acme.ghe.com",
              models: [],
              headers: {
                "copilot-integration-id": identity,
                "X-Private-Header": "not-for-catalog",
              },
            },
          },
        },
      };
      const result = await provider.catalog.run({
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "identity-catalog-token" },
        config,
      });
      const contextWindow = identity === "vscode-chat" ? 100_000 : 200_000;
      expect(result && "provider" in result ? result.provider.models : []).toMatchObject([
        { id: "gpt-5-mini", contextWindow },
      ]);
      const context = {
        config,
        agentDir,
        modelRegistry,
        provider: "github-copilot",
        modelId: "gpt-5-mini",
        authProfileId: "github-copilot:github",
      };
      await provider.prepareDynamicModel(context);
      expect(provider.resolveDynamicModel(context)).toMatchObject({
        id: "gpt-5-mini",
        contextWindow,
      });
    }
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders.every((headers) => !headers.has("x-private-header"))).toBe(true);
  });

  it("registers embedding provider", () => {
    const registerEmbeddingProviderMock = vi.fn<OpenClawPluginApi["registerEmbeddingProvider"]>();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerEmbeddingProvider: registerEmbeddingProviderMock,
      }),
    );

    expect(registerEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = expectDefined(
      registerEmbeddingProviderMock.mock.calls[0]?.[0],
      "embedding provider registration",
    );
    expect(adapter.id).toBe("github-copilot");
  });

  it("uses a stored api_key account when discovering its live Copilot model catalog", async () => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": {
        type: "api_key",
        provider: "github-copilot",
        key: "first-token",
      },
      "github-copilot:preferred": {
        type: "api_key",
        provider: "github-copilot",
        key: "preferred-token",
      },
    });
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "preferred-copilot-token",
      baseUrl: "https://api.githubcopilot.preferred",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
                supports: { streaming: true, tool_calls: true },
              },
            },
          ],
        }),
      ),
    );
    const provider = registerProviderWithPluginConfig({});

    const env = {};
    const result = await provider.catalog.run({
      config: { auth: { order: { "github-copilot": ["github-copilot:preferred"] } } },
      agentDir,
      env,
    });

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: "preferred-token",
      env,
      githubDomain: "github.com",
    });
    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["gpt-5.4"]);
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("ignores %s during catalog discovery", async (key) => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const result = await provider.catalog.run({
      config: {},
      agentDir,
      env: { [key]: "generic-token" },
    });
    expect(result).toBeNull();
    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
  });

  it("does not exchange auth or discover models for an unavailable direct SecretRef", async () => {
    const agentDir = await createAgentDir();
    const provider = registerProviderWithPluginConfig({});

    await expect(
      provider.catalog.run({
        config: {
          models: {
            providers: {
              "github-copilot": {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_MISSING_COPILOT_CATALOG_TOKEN",
                },
              },
            },
          },
        },
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
      }),
    ).rejects.toThrow("models.providers.github-copilot.apiKey");

    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("exposes xhigh and max thinking for the bundled Claude Opus 5 model", () => {
    const provider = registerProviderWithPluginConfig({});
    const model = expectDefined(
      manifest.modelCatalog.providers["github-copilot"].models.find(
        (candidate) => candidate.id === "claude-opus-5",
      ),
      "bundled GitHub Copilot Claude Opus 5 model",
    );

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: model.id,
      compat: model.compat,
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(
      expect.arrayContaining(["xhigh", "max"]),
    );
  });

  it("exposes xhigh thinking for non-Claude Copilot models with catalog xhigh effort", () => {
    // Regression for #59416: mini-family models (e.g. gpt-5.4-mini) are
    // entitled to xhigh per live /models, but the static xhigh allowlist only
    // contains gpt-5.4 and gpt-5.3-codex. When live metadata wins, the
    // resolved compat must drive xhigh for these non-Claude ids as well.
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5.4-mini",
      compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
    });

    expect(profile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("omits xhigh for non-Claude Copilot models whose catalog effort lacks it", () => {
    // Negative half of the #59416 regression: live-first must not over-grant.
    // gpt-5-mini reports only [low, medium, high] live, so xhigh must stay off
    // even though the reporter asked for the whole mini family to gain it.
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5-mini",
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    });

    expect(profile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });

  it("publishes only picker-visible, policy-enabled tool models in the live catalog", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "catalog-policy-token",
      baseUrl: "https://api.githubcopilot.policy-test",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "eligible",
              name: "Eligible",
              model_picker_enabled: true,
              model_picker_category: "versatile",
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "disabled",
              name: "Disabled",
              model_picker_enabled: true,
              policy: { state: "disabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "hidden",
              name: "Hidden",
              model_picker_enabled: false,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "chat-only",
              name: "Chat only",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: false, tool_calls: false },
              },
            },
          ],
        }),
      ),
    );
    const provider = registerProviderWithPluginConfig({});

    const result = await provider.catalog.run({
      config: {},
      agentDir: "/tmp/agent",
      env: { COPILOT_GITHUB_TOKEN: "catalog-source-token" },
    } as never);

    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["eligible", "chat-only"]);
  });

  it.each([
    { stage: "user", status: 401, expected: "auth-rejected" },
    { stage: "user", status: 503, expected: "unavailable" },
    { stage: "models", status: 403, expected: "auth-rejected" },
    { stage: "models", status: 503, expected: "unavailable" },
    { stage: "models", status: 200, expected: "ready" },
  ])(
    "records the catalog attempt at $stage with HTTP $status",
    async ({ stage, status, expected }) => {
      const agentDir = await createAgentDir();
      writeExistingCopilotApiKeyProfile(agentDir);
      const provider = registerProviderWithPluginConfig({});
      mocks.resolveCopilotRuntimeAuth.mockReset();
      if (stage === "user") {
        mocks.resolveCopilotRuntimeAuth.mockRejectedValue(
          new CopilotRuntimeAuthError({ reason: "http_error", status }),
        );
      } else {
        mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
          apiKey: "catalog-attempt-token",
          baseUrl: `https://api.githubcopilot.attempt-${status}`,
        });
      }
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.catalog.run({ config: {}, agentDir, env: {} });
      expect(result?.outcomes).toEqual([
        {
          provider: "github-copilot",
          profileId: "github-copilot:github",
          status: expected,
          ...(expected === "auth-rejected" ? { rejectionScope: "catalog" } : {}),
        },
      ]);
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "user" ? 0 : 1);
      if (expected === "ready") {
        expect(result && "provider" in result ? result.provider.models : undefined).toEqual([]);
      } else {
        expect(result && "providers" in result ? result.providers : undefined).toEqual({});
      }
    },
  );

  describe("github-copilot dynamic model resolution", () => {
    it("uses live catalog metadata for request-time model resolution", async () => {
      const agentDir = await createAgentDir();
      writeProfiles(agentDir, {
        "github-copilot:first": {
          type: "api_key",
          provider: "github-copilot",
          key: "first",
        },
        "github-copilot:selected": {
          type: "api_key",
          provider: "github-copilot",
          key: "chosen",
        },
      });
      mocks.resolveCopilotRuntimeAuth
        .mockResolvedValueOnce({
          apiKey: "chosen",
          baseUrl: "https://api.githubcopilot.live",
        })
        .mockResolvedValueOnce({
          apiKey: "first",
          baseUrl: "https://api.githubcopilot.first",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        Response.json({
          data: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              object: "model",
              vendor: "OpenAI",
              capabilities: {
                type: "chat",
                limits: {
                  max_context_window_tokens: contextWindow,
                  max_prompt_tokens: promptTokens,
                  max_output_tokens: 128_000,
                },
                supports: {
                  vision: true,
                  reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
                },
              },
            },
          ],
        });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000))
          .mockResolvedValueOnce(catalogResponse(400_000, 272_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const selectedContext = {
        config: {},
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:selected",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const firstContext = {
        ...selectedContext,
        authProfileId: "github-copilot:first",
      };

      await provider.prepareDynamicModel(selectedContext);
      await provider.prepareDynamicModel(firstContext);

      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
        githubToken: "chosen",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
        githubToken: "first",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.preferRuntimeResolvedModel(selectedContext)).toBe(true);
      expect(provider.resolveDynamicModel(selectedContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.live",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
        maxTokens: 128_000,
      });
      expect(provider.resolveDynamicModel(firstContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.first",
        contextWindow: 400_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
    });

    it("rematerializes direct-config metadata after a profile fallback", async () => {
      const agentDir = await createAgentDir();
      writeProfiles(agentDir, {
        "github-copilot:first": {
          type: "api_key",
          provider: "github-copilot",
          key: "test-auth-token",
        },
      });
      mocks.resolveCopilotRuntimeAuth
        .mockResolvedValueOnce({
          apiKey: "test-auth-token",
          baseUrl: "https://api.githubcopilot.profile",
        })
        .mockResolvedValueOnce({
          apiKey: "test-token-placeholder",
          baseUrl: "https://api.githubcopilot.direct",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        Response.json({
          data: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              object: "model",
              vendor: "OpenAI",
              capabilities: {
                type: "chat",
                limits: {
                  max_context_window_tokens: contextWindow,
                  max_prompt_tokens: promptTokens,
                  max_output_tokens: 128_000,
                },
              },
            },
          ],
        });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(200_000, 150_000))
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const config = {
        models: {
          providers: {
            "github-copilot": {
              apiKey: "test-token-placeholder",
              baseUrl: "https://api.githubcopilot.test",
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      const profileContext = {
        config,
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:first",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const directContext = {
        ...profileContext,
        authProfileId: undefined,
        authProfileMode: "api_key" as const,
      };

      // The first profile's credential can fail later during runtime auth. The
      // prepared direct fallback must then replace its account-scoped limits.
      await provider.prepareDynamicModel(profileContext);
      await provider.prepareDynamicModel(directContext);

      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
        githubToken: "test-auth-token",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
        githubToken: "test-token-placeholder",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.resolveDynamicModel(profileContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.profile",
        contextWindow: 200_000,
        contextTokens: 150_000,
      });
      expect(provider.resolveDynamicModel(directContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.direct",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
      });
    });
  });
});
