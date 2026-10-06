import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsDiscoverResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

type DiscoverEndpoint = {
  requests: Array<{ path?: string; authorization?: string }>;
  respond: (request: { path?: string; authorization?: string }) => {
    status: number;
    body: unknown;
    delayMs?: number;
  };
  address: () => string | null;
  close: () => Promise<void>;
};

async function startDiscoverEndpoint(
  behavior: DiscoverEndpoint["respond"],
): Promise<DiscoverEndpoint> {
  const requests: DiscoverEndpoint["requests"] = [];
  const server = createServer((request, response) => {
    const seen = { path: request.url, authorization: request.headers.authorization };
    requests.push(seen);
    const reply = behavior(seen);
    const finish = () => {
      if (reply.status !== 200) {
        response
          .writeHead(reply.status)
          .end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(reply.body));
    };
    if (reply.delayMs) {
      setTimeout(finish, reply.delayMs);
      return;
    }
    finish();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addressInfo = server.address();
  const origin =
    addressInfo && typeof addressInfo !== "string" ? `http://127.0.0.1:${addressInfo.port}` : null;
  return {
    requests,
    respond: behavior,
    address: () => origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

it("models.discover reports actionable failures without writing config", async () => {
  const state = await createOpenClawTestState({
    label: "models-discover-failures",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    },
  });
  let client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"] | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>["server"] | undefined;
  const endpoints: DiscoverEndpoint[] = [];
  try {
    const token = "models-discover-failures-token";
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
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

    const draftFor = (origin: string) =>
      ({
        baseUrl: `${origin}/`,
        api: "openai-completions",
        discovery: { endpointPath: "v1/models", request: { allowPrivateNetwork: true } },
        models: [],
      }) as const;

    // Authentication failure carries the endpoint status, not a generic timeout.
    const unauthorized = await startDiscoverEndpoint(() => ({
      status: 401,
      body: { error: { message: "bad key" } },
    }));
    endpoints.push(unauthorized);
    await expect(
      client.request("models.discover", {
        agentId: "main",
        config: { ...draftFor(unauthorized.address()!), apiKey: "invalid-key" },
      }),
    ).rejects.toThrow(/401|unauthorized|bad key/u);

    // An unusable model-list body is reported, never faked by a static catalog.
    const empty = await startDiscoverEndpoint(() => ({
      status: 200,
      body: { data: [] },
    }));
    endpoints.push(empty);
    await expect(
      client.request("models.discover", {
        agentId: "main",
        config: draftFor(empty.address()!),
      }),
    ).rejects.toThrow(/no usable text models|empty|no models/iu);

    // A slow endpoint fails within the discovery budget instead of hanging.
    const slow = await startDiscoverEndpoint(() => ({
      status: 200,
      body: { data: [{ id: "slow-model" }] },
      delayMs: 130_000,
    }));
    endpoints.push(slow);
    await expect(
      client.request("models.discover", {
        agentId: "main",
        config: {
          ...draftFor(slow.address()!),
          timeoutSeconds: 1,
        },
      }),
    ).rejects.toThrow(/abort|timeout|timed out|deadline/iu);

    // API formats outside the supported vocabulary are rejected before any request.
    await expect(
      client.request("models.discover", {
        agentId: "main",
        config: { ...draftFor("https://fixture.invalid"), api: "openai-codex-responses" },
      }),
    ).rejects.toThrow(/invalid models.discover params.*config\/api/iu);

    // Every failure path leaves the saved config untouched.
    expect(await readFile(state.configPath, "utf8")).toBe(configBefore);
  } finally {
    if (client) {
      await disconnectGatewayClient(client);
    }
    await gateway?.close();
    for (const endpoint of endpoints) {
      await endpoint.close();
    }
    await state.cleanup();
  }
}, 180_000);

it("models.discover success path stays read-only with draft credentials", async () => {
  const state = await createOpenClawTestState({
    label: "models-discover-draft-key",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    },
  });
  let client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"] | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>["server"] | undefined;
  const endpoint = await startDiscoverEndpoint((request) => {
    if (request.authorization !== "Bearer draft-discovery-key") {
      return { status: 401, body: { error: { message: "missing draft key" } } };
    }
    return { status: 200, body: { data: [{ id: "draft-model", name: "Draft model" }] } };
  });
  try {
    const token = "models-discover-draft-token";
    const cfg = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
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
    const origin = expectDefined(endpoint.address(), "discovery endpoint origin");
    const discovered = await client.request<ModelsDiscoverResult>("models.discover", {
      agentId: "main",
      config: {
        baseUrl: `${origin}/`,
        api: "openai-completions",
        apiKey: "draft-discovery-key",
        discovery: { endpointPath: "v1/models", request: { allowPrivateNetwork: true } },
        models: [],
      },
    });
    expect(discovered.models).toEqual([
      expect.objectContaining({ id: "draft-model", metadataSource: "provider-discovery" }),
    ]);
    expect(endpoint.requests).toEqual([
      { path: "/v1/models", authorization: "Bearer draft-discovery-key" },
    ]);
    expect(await readFile(state.configPath, "utf8")).toBe(configBefore);
  } finally {
    if (client) {
      await disconnectGatewayClient(client);
    }
    await gateway?.close();
    await endpoint.close();
    await state.cleanup();
  }
}, 120_000);

function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}
