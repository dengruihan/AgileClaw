import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it as baseIt, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile as applyAuth,
  bridgeCodexAppServerStartOptions as bridgeStart,
  reconcileCodexComputerUseStartArtifacts as reconcileArtifacts,
  resolveCodexAppServerHomeDir as codexHomeDir,
  resolveCodexAppServerPreparedAuthHandoff as prepareHandoff,
} from "./auth-bridge.js";
import { resolveCodexAppServerFallbackApiKeyCacheKey } from "./auth-cache-key.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

function it(name: string, run: (context: { agentDir: string }) => Promise<void>) {
  baseIt(name, () => withTempDir("openclaw-codex-", (agentDir) => run({ agentDir })));
}

const oauth = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

type MockDesktopCandidate = ReturnType<typeof resolveMacOSDesktopCodexAppPathCandidates>[number];
const desktop = vi.hoisted(() => ({
  cache: vi.fn<(_params: { forceRefresh?: boolean }) => Promise<boolean>>(async () => false),
  marketplace: vi.fn<(_params?: unknown) => Promise<string | undefined>>(async () => undefined),
  service: vi.fn<
    (_params?: unknown) => Promise<{
      status: "already_current" | "source_missing";
      changed: boolean;
    }>
  >(async () => ({ status: "already_current", changed: false })),
  marketplaceSource: vi.fn<
    (params: {
      candidates?: readonly MockDesktopCandidate[];
    }) => Promise<MockDesktopCandidate | undefined>
  >(async (params) => params.candidates?.[0]),
  serviceSource: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { provider?: string; context: { refresh: string } }) => {
      const refreshed = await oauth.refresh(params.context.refresh);
      return refreshed
        ? {
            ...params.context,
            ...refreshed,
            type: "oauth",
            provider: "openai",
          }
        : undefined;
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  const { saveAuthProfileStore } = actual;
  return {
    ...actual,
    resolveApiKeyForProfile: async (
      params: Parameters<typeof actual.resolveApiKeyForProfile>[0],
    ) => {
      const credential = params.store.profiles[params.profileId];
      if (!credential) {
        return null;
      }
      if (credential.type === "api_key") {
        const apiKey =
          credential.key?.trim() ||
          (credential.keyRef?.source === "env" ? process.env[credential.keyRef.id]?.trim() : "");
        return apiKey ? { apiKey, provider: credential.provider } : null;
      }
      if (credential.type === "token") {
        const apiKey =
          credential.token?.trim() ||
          (credential.tokenRef?.source === "env"
            ? process.env[credential.tokenRef.id]?.trim()
            : "");
        return apiKey ? { apiKey, provider: credential.provider, email: credential.email } : null;
      }
      if (credential.type !== "oauth") {
        return null;
      }
      let oauthCredential = credential;
      if (params.forceRefresh || (oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
          provider: oauthCredential.provider,
          context: oauthCredential,
        });
        if (refreshed?.access) {
          const refreshedCredential = refreshed as typeof oauthCredential;
          params.validateOAuthCredential?.(refreshedCredential);
          oauthCredential = refreshedCredential;
          params.store.profiles[params.profileId] = oauthCredential;
          if (params.agentDir || process.env.OPENCLAW_STATE_DIR) {
            saveAuthProfileStore(params.store, params.agentDir);
          }
        }
      } else {
        params.validateOAuthCredential?.(oauthCredential);
      }
      const formatted = await providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin({
        provider: oauthCredential.provider,
        context: oauthCredential,
      });
      const apiKey =
        typeof formatted === "string" && formatted ? formatted : oauthCredential.access;
      if (!apiKey) {
        return null;
      }
      const result = { apiKey, provider: oauthCredential.provider, email: oauthCredential.email };
      Object.defineProperty(result, "credential", { value: oauthCredential });
      return result;
    },
    refreshOAuthCredentialForRuntime: async (
      params: Parameters<typeof actual.refreshOAuthCredentialForRuntime>[0],
    ) => {
      const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
        provider: params.credential.provider,
        context: params.credential,
      });
      return refreshed
        ? {
            ...params.credential,
            ...refreshed,
            type: "oauth" as const,
          }
        : null;
    },
  };
});

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: desktop.service,
  resolveCodexComputerUseServiceAppSourcePath: desktop.serviceSource,
}));

vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace: desktop.marketplace,
  resolveCodexManagedBundledMarketplaceSource: desktop.marketplaceSource,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache: desktop.cache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  oauth.refresh.mockReset();
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
  desktop.service.mockClear();
  desktop.marketplace.mockClear();
  desktop.cache.mockReset();
  desktop.cache.mockResolvedValue(false);
  desktop.marketplaceSource.mockReset();
  desktop.marketplaceSource.mockImplementation(async (params) => params.candidates?.[0]);
  desktop.serviceSource.mockReset();
  desktop.serviceSource.mockImplementation(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  );
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "resolved-managed",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

const EPHEMERAL_AUTH_ARGS = ["-c", 'cli_auth_credentials_store="ephemeral"', "app-server"];

type AuthProfileStore = ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
type AuthProfileCredential = AuthProfileStore["profiles"][string];

type OAuthProfile = Extract<AuthProfileCredential, { type: "oauth" }>;

function oauthProfile(
  prefix: string,
  overrides: Partial<Omit<OAuthProfile, "type" | "provider">> = {},
): OAuthProfile {
  return {
    type: "oauth",
    provider: "openai",
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    // Fresh fixtures must outlive the proactive OAuth refresh window.
    expires: Date.now() + 24 * 60 * 60_000,
    ...overrides,
  };
}

function profileStore<T extends AuthProfileCredential>(credential: T) {
  return { version: 1, profiles: { "openai:work": credential } };
}

function profileParams(agentDir: string, authProfileStore?: AuthProfileStore) {
  return { agentDir, authProfileId: "openai:work", authProfileStore };
}

function expectApiKeyLogin(request: ReturnType<typeof vi.fn>, apiKey: string): void {
  expect(request).toHaveBeenCalledWith(
    "account/login/start",
    { type: "apiKey", apiKey },
    {
      assertCurrent: undefined,
    },
  );
}

async function writeCodexCliApiKeyAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "cli-auth-json-api-key",
    })}\n`,
  );
}

describe("Codex auth bridge", () => {
  baseIt.each(["marketplace", "service"] as const)(
    "rejects a desktop candidate whose exact %s is unavailable",
    async (missingArtifact) => {
      await withTempDir("openclaw-codex-", async (agentDir) => {
        if (missingArtifact === "marketplace") {
          desktop.marketplaceSource.mockResolvedValueOnce(undefined);
        } else {
          desktop.serviceSource.mockResolvedValueOnce(undefined);
        }

        await expect(
          reconcileArtifacts({
            startOptions: createStartOptions({
              command: "/Applications/ChatGPT.app/Contents/Resources/codex",
            }),
            agentDir,
            pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
          }),
        ).rejects.toMatchObject({
          code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
        });
        expect(desktop.service).not.toHaveBeenCalled();
        expect(desktop.marketplace).not.toHaveBeenCalled();
      });
    },
  );

  baseIt.each([
    { marketplaceSource: "file:///tmp/custom-marketplace" },
    { marketplacePath: "/tmp/custom-marketplace/marketplace.json" },
    { marketplaceName: "custom-marketplace" },
  ])("keeps an exact desktop candidate with configured marketplace selection", async (selector) => {
    await withTempDir("openclaw-codex-computer-use-custom-source-", async (agentDir) => {
      await expect(
        reconcileArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: {
            computerUse: { enabled: true, autoInstall: true, ...selector },
          },
        }),
      ).resolves.toBeUndefined();
      expect(desktop.marketplace).not.toHaveBeenCalled();
      expect(desktop.service).toHaveBeenCalledOnce();
    });
  });

  it("keeps package fallback artifacts on one complete desktop owner", async ({ agentDir }) => {
    const candidates = resolveMacOSDesktopCodexAppPathCandidates("darwin");
    const codexCandidate = candidates.find((candidate) => candidate.appName === "Codex.app");
    if (!codexCandidate) {
      throw new Error("expected Codex.app candidate");
    }
    desktop.serviceSource.mockImplementation(
      async (params: { sourceAppCandidates?: readonly string[] }) => {
        const source = params.sourceAppCandidates?.[0];
        return source?.includes("ChatGPT.app") ? undefined : source;
      },
    );
    desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");

    await reconcileArtifacts({
      startOptions: createStartOptions({ command: "/cache/openclaw/codex" }),
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    });

    expect(desktop.marketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [codexCandidate],
        appServerCommand: codexCandidate.appServerCommandPath,
      }),
    );
    expect(desktop.service).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAppCandidates: codexCandidate.computerUseServiceAppPaths,
        appServerCommand: codexCandidate.appServerCommandPath,
      }),
    );
    expect(desktop.cache).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledMarketplacePath: "/managed/openai-bundled",
      }),
    );
  });

  it("classifies native client provisioning failures as harness preflight", async () => {
    desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");
    desktop.service.mockRejectedValueOnce(new Error("copy failed"));

    await expect(
      reconcileArtifacts({
        startOptions: createStartOptions(),
        agentDir: "/tmp/openclaw-codex-computer-use-failed",
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
  });

  it("refreshes shared cache once per selected desktop source generation", async ({ agentDir }) => {
    desktop.cache.mockResolvedValue(true);
    const startOptions = createStartOptions({
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });
    const pluginConfig = {
      computerUse: {
        enabled: true,
        autoInstall: false,
        pluginCacheMode: "shared" as const,
      },
    };

    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
    });

    expect(desktop.cache.mock.calls.map(([params]) => params.forceRefresh)).toEqual([
      true,
      false,
      true,
    ]);
    expect(desktop.service).not.toHaveBeenCalled();
    expect(desktop.marketplace).not.toHaveBeenCalled();
  });

  it("does not let a stale desktop generation publish artifacts after its successor", async ({
    agentDir,
  }) => {
    const firstMarketplaceStarted = createDeferred<void>();
    const releaseFirstMarketplace = createDeferred<void>();
    let activeMarketplaceCalls = 0;
    let maxActiveMarketplaceCalls = 0;
    desktop.marketplace
      .mockImplementationOnce(async () => {
        activeMarketplaceCalls += 1;
        maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
        firstMarketplaceStarted.resolve();
        try {
          await releaseFirstMarketplace.promise;
          return "/managed/openai-bundled";
        } finally {
          activeMarketplaceCalls -= 1;
        }
      })
      .mockImplementationOnce(async () => {
        activeMarketplaceCalls += 1;
        maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
        activeMarketplaceCalls -= 1;
        return "/managed/openai-bundled";
      });
    let currentEpoch = 1;
    const startOptions = createStartOptions();
    const first = reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
      assertCurrent: () => {
        if (currentEpoch !== 1) {
          throw new Error("desktop generation X is stale");
        }
      },
    });
    await firstMarketplaceStarted.promise;
    currentEpoch = 2;
    const second = reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
      assertCurrent: () => {
        if (currentEpoch !== 2) {
          throw new Error("desktop generation Y is stale");
        }
      },
    });
    releaseFirstMarketplace.resolve();

    await expect(first).rejects.toThrow("desktop generation X is stale");
    await expect(second).resolves.toBeUndefined();
    expect(maxActiveMarketplaceCalls).toBe(1);
    expect(desktop.service).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an option value for the app-server subcommand", async ({ agentDir }) => {
    const startOptions = createStartOptions({
      args: ["-c", 'cli_auth_credentials_store="keyring"', "--profile", "app-server", "app-server"],
    });

    const bridged = await bridgeStart({ startOptions, agentDir });

    expect(bridged.args).toEqual([
      "-c",
      'cli_auth_credentials_store="keyring"',
      "--profile",
      "app-server",
      "-c",
      'cli_auth_credentials_store="ephemeral"',
      "app-server",
    ]);
  });

  it("preserves explicit CODEX_HOME and HOME overrides", async ({ agentDir }) => {
    const codexHome = path.join(agentDir, "custom-codex-home");
    const nativeHome = path.join(agentDir, "custom-native-home");
    const startOptions = createStartOptions({
      env: { CODEX_HOME: codexHome, HOME: nativeHome, EXISTING: "1" },
      clearEnv: ["CODEX_HOME", "HOME", "FOO"],
    });

    await expect(
      bridgeStart({
        startOptions,
        agentDir,
      }),
    ).resolves.toEqual({
      ...startOptions,
      args: EPHEMERAL_AUTH_ARGS,
      env: {
        CODEX_HOME: codexHome,
        HOME: nativeHome,
        EXISTING: "1",
      },
      clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
    });
    await expect(fs.access(codexHome)).resolves.toBeUndefined();
    await expect(fs.access(nativeHome)).resolves.toBeUndefined();
    expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    });
    expect(desktop.service).not.toHaveBeenCalled();
    expect(desktop.marketplace).not.toHaveBeenCalled();
  });

  baseIt.each(["api-key", "profile"] as const)(
    "clears ambient auth before prepared %s startup",
    async (authKind) => {
      await withTempDir("openclaw-codex-", async (agentDir) => {
        const startOptions = createStartOptions({ clearEnv: ["FOO", "OPENAI_API_KEY"] });
        const bridged = await bridgeStart({
          startOptions,
          agentDir,
          preparedAuth:
            authKind === "api-key"
              ? { kind: "api-key", apiKey: "prepared-platform-key" }
              : {
                  kind: "profile",
                  profileId: "openai:prepared",
                  store: { version: 1, profiles: { "openai:prepared": oauthProfile("prepared") } },
                },
        });
        expect(bridged).toEqual({
          ...startOptions,
          args: EPHEMERAL_AUTH_ARGS,
          env: { CODEX_HOME: codexHomeDir(agentDir) },
          clearEnv: ["FOO", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
        });
        const spawnEnv = resolveCodexAppServerSpawnEnv(bridged, {
          FOO: "ambient",
          CODEX_API_KEY: "ambient-codex-key",
          OPENAI_API_KEY: "ambient-openai-key",
          CODEX_ACCESS_TOKEN: "ambient-access-token",
        });
        expect(spawnEnv).toMatchObject({ CODEX_HOME: codexHomeDir(agentDir) });
        expect(spawnEnv).not.toHaveProperty("FOO");
        expect(spawnEnv).not.toHaveProperty("CODEX_API_KEY");
        expect(spawnEnv).not.toHaveProperty("OPENAI_API_KEY");
        expect(spawnEnv).not.toHaveProperty("CODEX_ACCESS_TOKEN");
      });
    },
  );

  it("applies a prepared API-key handoff without selecting an available OAuth profile", async () => {
    const authProfileStore: AuthProfileStore = profileStore(
      oauthProfile("test", {
        access: "subscription-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      }),
    );
    const handoff = await prepareHandoff({
      resolvedApiKey: "  prepared-platform-key  ",
      authProfileId: "openai:work",
      authProfileStore,
      homeScope: "agent",
    });
    expect(handoff.authProfileId).toBe("openai:work");
    expect(handoff.nativeAuthProfile).toBe(false);
    expect(handoff.preparedAuth).toEqual({ kind: "api-key", apiKey: "prepared-platform-key" });
    if (handoff.preparedAuth?.kind !== "api-key") {
      throw new Error("Expected API-key handoff");
    }
    const request = vi.fn(async () => ({ type: "apiKey" }));
    await applyAuth({
      client: { request } as never,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: null,
      authProfileStore,
      preparedAuth: handoff.preparedAuth,
    });
    expect(request).toHaveBeenCalledOnce();
    expectApiKeyLogin(request, "prepared-platform-key");
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("keeps an inherited OpenAI API key for an explicit Codex api-key profile", async ({
    agentDir,
  }) => {
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    const tokenLikeKey = "eyJhbGciOiJub25l.eyJzdWIiOiJjb2RleCJ9.signature123456";

    upsertAuthProfile({
      agentDir,
      profileId: "openai:work",
      credential: { type: "api_key", provider: "openai", key: tokenLikeKey },
    });

    await expect(
      bridgeStart({
        startOptions,
        ...profileParams(agentDir),
      }),
    ).resolves.toEqual({
      ...startOptions,
      args: EPHEMERAL_AUTH_ARGS,
      env: {
        CODEX_HOME: codexHomeDir(agentDir),
      },
      clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
    });
    const request = vi.fn(async () => ({ type: "apiKey" }));
    await expect(
      applyAuth({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      }),
    ).resolves.toBeUndefined();
    expectApiKeyLogin(request, tokenLikeKey);
  });

  it("includes Codex CLI api-key auth.json in fallback app-server cache keys", async ({
    agentDir: root,
  }) => {
    const codexHome = path.join(root, "codex-cli");

    await writeCodexCliApiKeyAuthFile(codexHome);

    const first = resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions: createStartOptions(),
      baseEnv: { CODEX_HOME: codexHome },
    });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      `${JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "second-cli-auth-json-api-key",
      })}\n`,
    );
    const second = resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions: createStartOptions(),
      baseEnv: { CODEX_HOME: codexHome },
    });

    expect(first).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
    expect(second).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(first).not.toContain("cli-auth-json-api-key");
    expect(second).not.toContain("second-cli-auth-json-api-key");
  });

  it("does not send env API-key fallback to websocket app-server connections", async ({
    agentDir,
  }) => {
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");

    const codexHome = path.join(agentDir, "native-cli");
    await writeCodexCliApiKeyAuthFile(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    const startOptions = createStartOptions({
      transport: "websocket",
      url: "ws://127.0.0.1:1455",
      clearEnv: ["FOO"],
    });
    await expect(bridgeStart({ startOptions, agentDir })).resolves.toBe(startOptions);
    expect(
      resolveCodexAppServerFallbackApiKeyCacheKey({
        startOptions,
        baseEnv: { CODEX_HOME: codexHome },
      }),
    ).toBeUndefined();
  });
});
