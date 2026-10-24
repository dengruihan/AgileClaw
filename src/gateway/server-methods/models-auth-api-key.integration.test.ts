import { expect, it } from "vitest";
import {
  type ModelsAuthSetApiKeyResult,
  type ModelsAuthInspectApiKeyResult,
  validateModelsAuthInspectApiKeyResult,
  validateModelsAuthSetApiKeyResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

it("models.authSetApiKey validates the old wire request before the real credential writer", async () => {
  const state = await createOpenClawTestState({
    label: "models-auth-api-key",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const token = "api-key-contract-fixture-token";
  const cfg = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
    gateway: { mode: "local", auth: { mode: "token", token }, reload: { mode: "off" } },
  };
  try {
    const { client, server, port } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    try {
      await server.startupSettled;
      const request = { provider: " Fixture ", apiKey: "synthetic-first-key", agentId: "" };
      const saved = await client.request<ModelsAuthSetApiKeyResult>("models.authSetApiKey", {
        ...request,
        futureField: true,
      });
      expect(validateModelsAuthSetApiKeyResult(saved)).toBe(true);
      expect(saved).toMatchObject({ provider: "fixture", profileId: "fixture:manual" });
      const persisted = () => loadPersistedAuthProfileStore()?.profiles;
      expect(persisted()?.[saved.profileId]).toMatchObject({
        type: "api_key",
        provider: "fixture",
        key: request.apiKey,
      });
      for (const invalid of [
        { ...request, apiKey: "\n\t" },
        { ...request, provider: 1 },
        { ...request, agentId: "retired" },
        { ...request, provider: "openai", apiKey: "not-an-api-key" },
      ]) {
        await expect(client.request("models.authSetApiKey", invalid)).rejects.toThrow();
      }
      expect(persisted()).toEqual({
        [saved.profileId]: expect.objectContaining({ key: request.apiKey }),
      });
      const reader = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: ["operator.read"],
      });
      try {
        await expect(reader.request("models.authSetApiKey", request)).rejects.toThrow(
          "operator.admin",
        );
        await expect(
          reader.request("models.authInspectApiKey", {
            provider: "fixture",
            agentId: "main",
            baseHash: "unread-revision",
            reveal: true,
          }),
        ).rejects.toThrow("operator.admin");
      } finally {
        await disconnectGatewayClient(reader);
      }
      expect(persisted()?.[saved.profileId]).toMatchObject({ key: request.apiKey });
      const { hash: baseHash } = await client.request<{ hash: string }>("config.get", {});
      const inspect = { provider: "fixture", agentId: "main", baseHash };
      const hidden = await client.request<ModelsAuthInspectApiKeyResult>(
        "models.authInspectApiKey",
        inspect,
      );
      expect(validateModelsAuthInspectApiKeyResult(hidden)).toBe(true);
      expect(hidden).toMatchObject({
        configured: true,
        source: "profile",
        profileId: saved.profileId,
      });
      expect(hidden).not.toHaveProperty("key");
      expect(
        await client.request("models.authInspectApiKey", { ...inspect, reveal: true }),
      ).toMatchObject({ key: request.apiKey });
      await client.request("models.authSetApiKey", {
        ...request,
        apiKey: "synthetic-replacement-key",
      });
      const latest = await client.request<{ hash: string }>("config.get", {});
      expect(
        await client.request("models.authInspectApiKey", {
          ...inspect,
          baseHash: latest.hash,
          reveal: true,
        }),
      ).toMatchObject({ profileId: saved.profileId, key: "synthetic-replacement-key" });
      expect(persisted()?.[saved.profileId]).toMatchObject({ key: "synthetic-replacement-key" });
    } finally {
      await disconnectGatewayClient(client);
      await server.close({ reason: "API-key contract test complete" });
    }
  } finally {
    await state.cleanup();
  }
});
