import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { modelsAuthApiKeyInspectHandlers } from "./models-auth-api-key-inspect.js";
import { soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), prepared: vi.fn() }));
// mock-isolation: authored config and prepared credential ownership stay synthetic and in memory.
vi.mock("../../config/config.js", () => ({ readConfigFileSnapshot: mocks.snapshot }));
// mock-isolation: never prepare runtime providers or read persisted credentials in this fixture.
vi.mock("../server-model-catalog-auth.js", () => ({ readPreparedCatalog: mocks.prepared }));

const config: OpenClawConfig = {
  agents: {
    entries: {
      main: { workspace: "/tmp/model-key-main" },
      other: { workspace: "/tmp/model-key-other" },
    },
  },
  models: {
    providers: {
      fixture: { baseUrl: "https://example.test/v1", models: [], apiKey: "fixture:manual" },
    },
  },
};
let store: AuthProfileStore;
let sourceConfig: OpenClawConfig;
let current: boolean;
function request(params: Record<string, unknown> = {}) {
  const requestParams = {
    provider: "fixture",
    agentId: "main",
    baseHash: "public:revision",
    reveal: true,
    ...params,
  };
  const client = soloClient();
  return {
    req: {
      type: "req",
      id: "inspect-model-key",
      method: "models.authInspectApiKey",
      params: requestParams,
    },
    params: requestParams,
    client: { ...client, connect: { ...client.connect, scopes: ["operator.admin"] } },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      getRuntimeConfig: () => config,
      configRevisionProjector: {
        projectRawHash: (hash: string) => `public:${hash}`,
        projectResolvedHash: (hash) => hash,
        hashResponseSessionBearer: () => "unused-test-scope",
      },
    }),
    respond: vi.fn(),
  } satisfies GatewayRequestHandlerOptions;
}
async function invoke(options = request()) {
  await modelsAuthApiKeyInspectHandlers["models.authInspectApiKey"]!(options);
  return vi.mocked(options.respond);
}
beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  sourceConfig = structuredClone(config);
  store = {
    version: 1,
    profiles: {
      "fixture:manual": { type: "api_key", provider: "fixture", key: "synthetic-manual-key" },
    },
  };
  mocks.snapshot.mockImplementation(async () => ({ hash: "revision", sourceConfig }));
  mocks.prepared.mockImplementation(async () => ({
    config,
    workspaceDir: "/tmp/model-key-main",
    authStore: store,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent: () => current,
  }));
});

describe("model API-key authoring inspection", () => {
  it("hides a configured profile key unless revealed and never mistakes the profile ID for the key", async () => {
    expect(await invoke(request({ reveal: false }))).toHaveBeenCalledWith(
      true,
      {
        provider: "fixture",
        agentId: "main",
        baseHash: "public:revision",
        configured: true,
        source: "profile",
        profileId: "fixture:manual",
      },
      undefined,
    );
    expect(await invoke()).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ key: "synthetic-manual-key" }),
      undefined,
    );
    sourceConfig.models!.providers!.fixture!.apiKey = "synthetic-inline-key";
    expect(await invoke()).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ source: "literal", key: "synthetic-inline-key" }),
      undefined,
    );
  });
  it.each([
    {
      type: "api_key",
      provider: "fixture",
      key: "hydrated-private-key",
      keyRef: { source: "env", provider: "default", id: "MODEL_KEY" },
    },
    { type: "token", provider: "fixture", token: "synthetic-token" },
    { type: "api_key", provider: "another-provider", key: "synthetic-unrelated-key" },
  ] as const)(
    "never reveals referenced or non-API-key profile material ($type)",
    async (credential) => {
      store.profiles["fixture:manual"] = credential;
      const respond = await invoke();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ configured: true }),
        undefined,
      );
      expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("key");
    },
  );
  it("keeps authored environment refs external even if config resolution supplied a value", async () => {
    sourceConfig.models!.providers!.fixture!.apiKey = {
      source: "env",
      provider: "default",
      id: "MODEL_KEY",
    };
    expect(await invoke()).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ source: "environment", configured: true }),
      undefined,
    );
    expect((await invoke()).mock.calls[0]?.[1]).not.toHaveProperty("key");
  });
  it("uses the configured agent and the same implicit profile order as key replacement", async () => {
    sourceConfig.models = undefined;
    sourceConfig.auth = { order: { fixture: ["fixture:selected", "fixture:manual"] } };
    store.profiles["fixture:selected"] = {
      type: "api_key",
      provider: "fixture",
      key: "synthetic-selected-key",
    };
    expect(await invoke(request({ agentId: "other" }))).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "other",
        profileId: "fixture:selected",
        key: "synthetic-selected-key",
      }),
      undefined,
    );
    expect(mocks.prepared).toHaveBeenCalledWith(expect.anything(), "other");
    const options = request({ agentId: "retired" });
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
  it("denies read-only users before reading config", async () => {
    const options = request();
    options.client!.connect.scopes = ["operator.read"];
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it.each(["config", "prepared"])("rechecks current authority after %s awaits", async (stage) => {
    const options = request();
    const target = stage === "config" ? mocks.snapshot : mocks.prepared;
    const original = target.getMockImplementation()!;
    target.mockImplementation(async (...args) => {
      const result = await original(...args);
      options.client!.invalidated = true;
      return result;
    });
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
  it("refuses stale revisions and retired credential snapshots without disclosing material", async () => {
    expect(await invoke(request({ baseHash: "public:old" }))).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.prepared).not.toHaveBeenCalled();
    current = false;
    expect(await invoke()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
  it("keeps loader error details out of the response", async () => {
    mocks.snapshot.mockRejectedValue(new Error("synthetic-private-loader-value"));
    const respond = await invoke();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("synthetic-private-loader-value");
  });
});
