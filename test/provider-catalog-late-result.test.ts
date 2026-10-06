import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { resolveImplicitProviders } from "../src/agents/models-config.providers.implicit.js";
import type { ModelProviderConfig } from "../src/config/types.models.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import * as providerDiscovery from "../src/plugins/provider-discovery.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const discovery = vi.hoisted(() => ({
  providers: new Array<ProviderPlugin>(),
}));

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

function createCatalogProviderRegistry(providers = discovery.providers) {
  const registry = createEmptyPluginRegistry();
  registry.providers = providers.map((provider) => ({
    pluginId: provider.id,
    provider,
    source: "test",
  }));
  return registry;
}

function withCatalogProviders<T>(run: () => T): T {
  return withPluginRuntimeRegistryScope(createCatalogProviderRegistry(), run);
}

describe("provider catalog late-result finalization", () => {
  const providerId = "catalog-late-fixture";
  const profileId = `${providerId}:api-key`;
  const peerId = "catalog-peer-fixture";
  const model = {
    id: "account-only",
    name: "Account Model",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 8_192,
  };

  let state: OpenClawTestState;
  let store: AuthProfileStore;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "catalog-late-result-", agentEnv: "main" });
    store = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "api_key",
          provider: providerId,
          key: "fixture-api-key",
        },
      },
    };
    await state.writeAuthProfiles(store);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearLiveCatalogCacheForTests();
    discovery.providers = [];
    await state.cleanup();
  });

  it.each(["provider", "providers", "outcomes"] as const)(
    "discards late %s and consumes the next active owner's result once",
    async (shape) => {
      const entered = createDeferredCore();
      const completion = createDeferredCore();
      const catalog = vi.spyOn(providerDiscovery, "runProviderCatalog");
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      // Outcomes report only for providers owned by the running hook's plugin;
      // peer rows stay subject to the discovery scope's row allowlist.
      const ready: ProviderCatalogOutcome[] = [{ provider: providerId, status: "ready" }];
      let reads = 0;
      const readProvider = (): ModelProviderConfig => ({
        baseUrl: "https://catalog.invalid/v1",
        api: "openai-completions",
        models: reads++ === 0 ? [model] : [],
      });
      discovery.providers = [
        {
          id: providerId,
          label: "Catalog Fixture",
          auth: [
            {
              id: "api-key",
              label: "API key",
              kind: "api_key",
              run: async () => {
                throw new Error("interactive auth is outside this fixture");
              },
            },
          ],
          catalog: {
            run: async (ctx) => {
              expect(ctx.resolveProviderAuth(providerId)).toMatchObject({
                apiKey: "fixture-api-key",
                mode: "api_key",
              });
              entered.resolve();
              await completion.promise;
              if (shape === "outcomes") {
                return {
                  providers: {},
                  get outcomes() {
                    return reads++ === 0 ? ready : [];
                  },
                };
              }
              return shape === "provider"
                ? {
                    get provider() {
                      return readProvider();
                    },
                    outcomes: ready,
                  }
                : {
                    get providers() {
                      const provider = readProvider();
                      return { [providerId]: provider, [peerId]: provider };
                    },
                    outcomes: ready,
                  };
            },
          },
        },
      ];
      const outcomes: ProviderCatalogOutcome[] = [];
      const discover = (timeoutMs?: number) =>
        withCatalogProviders(() =>
          resolveImplicitProviders({
            config: {},
            agentDir: state.agentDir(),
            authStore: store,
            env: {},
            // Scope both catalog rows so the hook's peer entry stays inside the
            // discovery allowlist; only the owning provider reports on timeout.
            providerDiscoveryProviderIds:
              shape === "providers" ? [providerId, peerId] : [providerId],
            providerDiscoveryTimeoutMs: timeoutMs,
            onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
          }),
        );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = discover(25);
      try {
        await Promise.race([entered.promise, pending]);
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toEqual({});
      } finally {
        completion.resolve();
        await Promise.allSettled(catalog.mock.results.map((result) => result.value));
      }
      const lateReads = reads;
      expect(outcomes).toEqual([{ provider: providerId, status: "unavailable" }]);
      outcomes.length = 0;
      const accepted = await discover();
      expect({ lateReads, reads }).toEqual({ lateReads: 0, reads: 1 });
      if (shape === "outcomes") {
        expect(accepted).toEqual({});
      } else {
        expect(accepted?.[providerId]?.models).toEqual([model]);
      }
      if (shape === "providers") {
        expect(accepted?.[peerId]?.models).toEqual([model]);
      }
      expect(outcomes).toEqual(ready);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
