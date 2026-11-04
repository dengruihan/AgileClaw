import { vi } from "vitest";
import type { AuthHealthSummary } from "../../agents/auth-health.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
  type RuntimeAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveProviderAuthLookupMaps } from "../../secrets/provider-env-vars.js";
import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";

type BuildAuthHealthSummary = typeof import("../../agents/auth-health.js").buildAuthHealthSummary;

const emptyUsageSummary = (): UsageSummary => ({ updatedAt: 0, providers: [] });

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  ),
  resolveDefaultAgentId: vi.fn(() => "main"),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn((agentDir?: string): AuthProfileStore => {
    void agentDir;
    return { version: 1, profiles: {} };
  }),
  listProfilesForProvider: vi.fn((): string[] => []),
  removeModelAuthCredentials: vi.fn(async () => {}),
  saveModelProviderApiKey:
    vi.fn<typeof import("../../commands/models/auth-api-key.js").saveModelProviderApiKey>(),
  setAuthProfileOrder: vi.fn(async (): Promise<AuthProfileStore | null> => ({
    version: 1,
    profiles: {},
  })),
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => false),
  prepareModelRuntimeSnapshot: vi.fn(async () => {}),
  loadDeferredCatalog: vi.fn(),
  readPreparedCatalog: vi.fn(),
  buildAuthHealthSummary: vi.fn<BuildAuthHealthSummary>((): AuthHealthSummary => ({
    now: 0,
    warnAfterMs: 0,
    profiles: [],
    providers: [],
  })),
  loadProviderUsageSummary: vi.fn(async (): Promise<UsageSummary> => emptyUsageSummary()),
  listProviderUsagePluginDescriptors: vi.fn(() => [
    { provider: "anthropic", displayName: "Claude" },
    { provider: "deepseek", displayName: "DeepSeek" },
    { provider: "openai", displayName: "OpenAI" },
  ]),
}));

// mock-isolation: the harness serves config reads from an in-memory fixture store.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

// mock-isolation: agent roster and directories stay deterministic per test.
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentDir: mocks.resolveAgentDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

// mock-isolation: auth profile persistence is replaced by in-memory fakes.
vi.mock("../../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-profiles.js")>(
    "../../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStoreWithoutExternalProfiles:
      mocks.ensureAuthProfileStoreWithoutExternalProfiles,
    listProfilesForProvider: mocks.listProfilesForProvider,
    setAuthProfileOrder: mocks.setAuthProfileOrder,
  };
});

// mock-isolation: key saves are captured as calls, never touching secrets.
vi.mock("../../commands/models/auth-api-key.js", () => ({
  saveModelProviderApiKey: mocks.saveModelProviderApiKey,
}));

// mock-isolation: credential removal is captured as calls against fake stores.
vi.mock("../../commands/models/auth-logout.js", () => ({
  removeModelAuthCredentials: mocks.removeModelAuthCredentials,
}));

// mock-isolation: health summaries come from per-test fixtures.
vi.mock("../../agents/auth-health.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/auth-health.js")>(
    "../../agents/auth-health.js",
  );
  return {
    ...actual,
    buildAuthHealthSummary: mocks.buildAuthHealthSummary,
  };
});

// mock-isolation: usage summaries come from per-test fixtures.
vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

// mock-isolation: plugin usage descriptors stay a fixed fixture list.
vi.mock("../../plugins/provider-runtime.js", () => ({
  listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
}));

// mock-isolation: secret refresh stays a controllable fake, never real keys.
vi.mock("../../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshActiveProviderAuthRuntimeSnapshot,
}));

// mock-isolation: runtime snapshot publication is driven per test.
vi.mock("../../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: mocks.prepareModelRuntimeSnapshot,
}));

// mock-isolation: catalog reads come from the prepared owner fixture.
vi.mock("../server-model-catalog-auth.js", () => ({
  loadDeferredCatalog: mocks.loadDeferredCatalog,
  readPreparedCatalog: mocks.readPreparedCatalog,
}));

/**
 * Prepared-snapshot state shared by the reset harness and individual tests.
 * Direct writes to `current` bypass the ambient snapshot push on purpose:
 * one usage test advances the prepared owner ahead of the ambient revision.
 */
export const preparedAuth = {
  current: { version: 1, profiles: {} } as AuthProfileStore,
};
let preparedMetadataSnapshot: unknown;

export function setPreparedAuthStore(store: RuntimeAuthProfileStore): void {
  preparedAuth.current = store;
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: "/tmp/agent", store }]);
}

export function setPreparedMetadataSnapshot(snapshot: unknown): void {
  preparedMetadataSnapshot = snapshot;
}

function createPreparedOwnerSnapshot(agentId: string) {
  const config = mocks.getRuntimeConfig.mock.results.at(-1)?.value ?? {};
  const agentDir =
    mocks.resolveAgentDir.mock.results.at(-1)?.value ??
    (agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`);
  return {
    agentId,
    agentDir,
    workspaceDir: "/tmp/workspace",
    config,
    entries: [],
    routeVariants: [],
    authModes: {},
    authStore: preparedAuth.current,
    authMaterializations: [],
    metadataSnapshot: preparedMetadataSnapshot as never,
  };
}

export function resetAuthStatusMocks(): void {
  for (const envVarNames of Object.values(
    resolveProviderAuthLookupMaps({ env: {} }).envCandidateMap,
  )) {
    for (const envVarName of envVarNames) {
      vi.stubEnv(envVarName, "");
    }
  }
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.clearAllMocks();
  clearModelAuthStatusUsageCache();
  mocks.getRuntimeConfig.mockReturnValue({});
  mocks.listAgentIds.mockReturnValue(["main"]);
  mocks.resolveAgentDir.mockImplementation((_cfg: unknown, agentId: string) =>
    agentId === "main" ? "/tmp/agent" : `/tmp/agent-${agentId}`,
  );
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  setPreparedAuthStore({ version: 1, profiles: {} });
  setPreparedMetadataSnapshot(createPluginMetadataSnapshotFixture());
  mocks.readPreparedCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.loadDeferredCatalog.mockImplementation(async (_context, agentId: string) =>
    createPreparedOwnerSnapshot(agentId),
  );
  mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(
    createAuthProfileStoreFixture({}),
  );
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.removeModelAuthCredentials.mockResolvedValue();
  mocks.saveModelProviderApiKey.mockResolvedValue({ profileId: "openrouter:manual" });
  mocks.setAuthProfileOrder.mockResolvedValue({ version: 1, profiles: {} });
  mocks.buildAuthHealthSummary.mockReturnValue({
    now: 0,
    warnAfterMs: 0,
    profiles: [],
    providers: [],
  });
  mocks.loadProviderUsageSummary.mockResolvedValue(emptyUsageSummary());
  mocks.refreshActiveProviderAuthRuntimeSnapshot.mockResolvedValue(false);
  mocks.prepareModelRuntimeSnapshot.mockResolvedValue();
}

export { mocks };
