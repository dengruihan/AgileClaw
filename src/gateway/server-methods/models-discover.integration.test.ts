import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsDiscoverResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it("models.discover resolves a saved API-key profile and keeps discovery read-only", async () => {
  const state = await createOpenClawTestState({
    label: "models-discover-saved-profile",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    },
  });
  const seen: Array<{ path?: string; authorization?: string }> = [];
  const endpoint = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== "Bearer saved-discovery-key") {
      response.writeHead(401).end("unauthorized");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "saved-discovery-model", name: "Saved model" }] }));
  });
  let client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"] | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>["server"] | undefined;
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Discovery fixture did not bind a TCP port");
    }
    const token = "models-discover-test-token";
    const cfg = {
      models: {
        providers: {
          "stable-provider-id": {
            name: "Custom provider",
            baseUrl: `http://127.0.0.1:${address.port}/`,
            api: "openai-completions",
            apiKey: "stable-provider-id:default",
            models: [],
          },
        },
      },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "stable-provider-id:default": {
          type: "api_key",
          provider: "stable-provider-id",
          key: "saved-discovery-key",
        },
      },
    });
    state.applyEnv();
    const started = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    client = started.client;
    gateway = started.server;
    await gateway.startupSettled;
    const configBefore = await readFile(state.configPath, "utf8");
    const draft = {
      baseUrl: `http://127.0.0.1:${address.port}/`,
      api: "openai-completions",
      discovery: {
        endpointPath: "v1/models",
        request: { allowPrivateNetwork: true },
      },
      models: [],
    } as const;
    const discovered = await client.request<ModelsDiscoverResult>("models.discover", {
      agentId: "main",
      providerId: "stable-provider-id",
      config: draft,
    });
    expect(discovered.models).toEqual([
      expect.objectContaining({
        id: "saved-discovery-model",
        metadataSource: "provider-discovery",
      }),
    ]);
    expect(seen).toEqual([{ path: "/v1/models", authorization: "Bearer saved-discovery-key" }]);
    await expect(
      client.request("models.discover", {
        agentId: "main",
        providerId: "stable-provider-id",
        config: { ...draft, apiKey: "" },
      }),
    ).rejects.toThrow(/401/u);
    expect(seen[1]).toEqual({ path: "/v1/models", authorization: undefined });
    expect(await readFile(state.configPath, "utf8")).toBe(configBefore);
  } finally {
    if (client) {
      await disconnectGatewayClient(client);
    }
    await gateway?.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => (error ? reject(error) : resolve()));
    });
    await state.cleanup();
  }
}, 120_000);
