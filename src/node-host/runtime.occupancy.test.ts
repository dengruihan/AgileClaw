import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  NODE_DEVICE_OCCUPIED_ERROR_CODE,
  NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
  NODE_EXECUTOR_PROFILE_COMMANDS,
  NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
  NODE_OCCUPANCY_CAP,
  NODE_OCCUPANCY_STATUS_EVENT,
} from "../infra/node-commands.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NodeHostClient } from "./client.js";
import { NodeOccupancyControlGate } from "./node-occupancy-control-gate.js";
import {
  createNodeHostClient,
  frame as baseFrame,
  mocks,
  prepareNodeHostRuntime,
} from "./runtime.test-support.js";

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

const fixture = createFixtureLifetime();

function occupancyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: "/usr/bin",
    OPENCLAW_STATE_DIR: fixture.createTempDir("runtime-occupancy-"),
  };
}

type CapturedResult = {
  id: string;
  ok: boolean;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
};

function captureClient() {
  const results: CapturedResult[] = [];
  const events: Array<{ event: string; payloadJSON: string | null }> = [];
  const client: NodeHostClient = createNodeHostClient(async (method, params) => {
    const record = params as CapturedResult & { event?: string; payloadJSON?: string };
    if (method === "node.invoke.result") {
      results.push(record);
    } else if (method === "node.event") {
      events.push({ event: record.event ?? "", payloadJSON: record.payloadJSON ?? null });
    }
    return {};
  });
  return { client, results, events };
}

function invokeFrame(params: {
  id: string;
  command: string;
  sessionKey?: string;
  paramsJSON?: string;
}) {
  return {
    ...baseFrame,
    id: params.id,
    command: params.command,
    paramsJSON: params.paramsJSON ?? null,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  };
}

function acquireParams(leaseToken: string) {
  return JSON.stringify({
    sessionKey: "agent:root:1",
    sessionId: "session-1",
    agentId: "agent-1",
    runId: "run-1",
    turnId: "turn-1",
    leaseToken,
  });
}

async function startOccupancyRuntime(env: NodeJS.ProcessEnv, client: NodeHostClient) {
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false }, workerRuns: { enabled: true } } },
    env,
    enableAgentRuns: true,
    enableWorkerRuns: true,
    enableOccupancy: true,
  });
  expect(prepared.occupancy).toBeDefined();
  return prepared.start({ client });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fixture.cleanup();
});

describe("node host runtime occupancy commands", () => {
  it("serves the occupancy lifecycle through the invoke pipeline", async () => {
    const { client, results } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);

    await runtime.invoke(
      invokeFrame({
        id: "acquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );
    await runtime.invoke(invokeFrame({ id: "status", command: "occupancy.status.v1" }));
    await runtime.invoke(
      invokeFrame({
        id: "release",
        command: "occupancy.release.v1",
        paramsJSON: JSON.stringify({ sessionKey: "agent:root:1", leaseToken: "lease-token" }),
      }),
    );

    const acquire = results.find((result) => result.id === "acquire");
    expect(acquire).toMatchObject({ ok: true });
    expect(JSON.parse(acquire?.payloadJSON ?? "{}")).toMatchObject({
      holder: { sessionKey: "agent:root:1", sessionId: "session-1" },
      leaseToken: "lease-token",
    });
    const status = results.find((result) => result.id === "status");
    expect(JSON.parse(status?.payloadJSON ?? "{}")).toMatchObject({ occupied: true });
    const release = results.find((result) => result.id === "release");
    expect(JSON.parse(release?.payloadJSON ?? "{}")).toMatchObject({ released: true });

    await runtime.close();
  });

  it("rejects another session's acquisition with the holder identity", async () => {
    const { client, results } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);
    await runtime.invoke(
      invokeFrame({
        id: "acquire-a",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );

    await runtime.invoke(
      invokeFrame({
        id: "acquire-b",
        command: "occupancy.acquire.v1",
        paramsJSON: JSON.stringify({
          sessionKey: "agent:root:2",
          sessionId: "session-2",
          runId: "run-2",
          leaseToken: "other-token",
        }),
      }),
    );

    const rejected = results.find((result) => result.id === "acquire-b");
    expect(rejected).toEqual({
      id: "acquire-b",
      nodeId: expect.any(String),
      ok: false,
      error: {
        code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
        message: expect.stringContaining("agent:root:1"),
      },
    });

    await runtime.close();
  });
});

describe("node host runtime per-call lease admission", () => {
  it("validates holder and lease token before every execution command", async () => {
    const { client, results } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);

    await runtime.invoke(
      invokeFrame({ id: "cold", command: "test.duplex", sessionKey: "agent:root:1" }),
    );
    expect(results.find((result) => result.id === "cold")).toMatchObject({
      ok: false,
      error: { code: NODE_DEVICE_UNOCCUPIED_ERROR_CODE },
    });
    expect(mocks.handleInvoke).not.toHaveBeenCalled();

    await runtime.invoke(
      invokeFrame({
        id: "acquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );

    await runtime.invoke(
      invokeFrame({
        id: "foreign-session",
        command: "test.duplex",
        sessionKey: "agent:root:2",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );
    expect(results.find((result) => result.id === "foreign-session")).toMatchObject({
      error: {
        code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
        message: expect.stringContaining("agent:root:1"),
      },
    });

    await runtime.invoke(
      invokeFrame({ id: "no-token", command: "test.duplex", sessionKey: "agent:root:1" }),
    );
    expect(results.find((result) => result.id === "no-token")).toMatchObject({
      error: { code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE },
    });

    await runtime.invoke(
      invokeFrame({
        id: "stale-token",
        command: "test.duplex",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "stale" }),
      }),
    );
    expect(results.find((result) => result.id === "stale-token")).toMatchObject({
      error: { code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE },
    });
    expect(mocks.handleInvoke).not.toHaveBeenCalled();

    await runtime.invoke(
      invokeFrame({
        id: "admitted",
        command: "test.duplex",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );
    expect(mocks.handleInvoke).toHaveBeenCalledTimes(1);

    // A newer turn invalidates the previous token on the very next call.
    await runtime.invoke(
      invokeFrame({
        id: "reacquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token-turn-2"),
      }),
    );
    await runtime.invoke(
      invokeFrame({
        id: "previous-turn",
        command: "test.duplex",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );
    expect(results.find((result) => result.id === "previous-turn")).toMatchObject({
      error: { code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE },
    });

    // Operator approval policy governs the device rather than a turn, so the
    // Gateway's approvals UI and CLI stay reachable while the lease is held.
    await runtime.invoke(invokeFrame({ id: "approvals", command: "system.execApprovals.get" }));
    expect(mocks.handleInvoke).toHaveBeenCalledTimes(2);

    await runtime.close();
  });
});

describe("node host runtime control serialization", () => {
  it("serializes control commands while other commands stay parallel", async () => {
    const { client } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);
    await runtime.invoke(
      invokeFrame({
        id: "acquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );

    const held = createDeferred<void>();
    const dispatched: string[] = [];
    mocks.handleInvoke.mockImplementation(async (...args: unknown[]) => {
      const frame = args[0] as { id: string };
      dispatched.push(frame.id);
      if (frame.id === "control-1") {
        await held.promise;
      }
    });

    void runtime.invoke(
      invokeFrame({
        id: "control-1",
        command: "browser.proxy",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );
    await vi.waitFor(() => expect(dispatched).toEqual(["control-1"]));

    void runtime.invoke(
      invokeFrame({
        id: "control-2",
        command: "browser.proxy",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );
    void runtime.invoke(
      invokeFrame({
        id: "parallel-exec",
        command: "test.duplex",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token" }),
      }),
    );

    await vi.waitFor(() => expect(dispatched).toContain("parallel-exec"));
    expect(dispatched).not.toContain("control-2");

    held.resolve();
    await vi.waitFor(() => expect(dispatched).toEqual(["control-1", "parallel-exec", "control-2"]));

    await runtime.close();
  });
});

describe("node host executor profile", () => {
  it("advertises the tool-execution surface and disables worker hosting", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: true }, workerRuns: { enabled: true } } },
      env: occupancyEnv(),
      enableAgentRuns: true,
      enableWorkerRuns: true,
      profile: "executor",
    });

    expect(prepared.restrictedSurface).toBe(true);
    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.manifest.caps).toContain(NODE_OCCUPANCY_CAP);
    expect(prepared.manifest.commands).toEqual(
      expect.arrayContaining([
        "system.run",
        "system.which",
        "system.execApprovals.get",
        ...NODE_EXECUTOR_PROFILE_COMMANDS.filter((command) => command.startsWith("occupancy.")),
      ]),
    );
    expect(prepared.manifest.commands).not.toEqual(
      expect.arrayContaining(["worker.launch.v1", "worker.bundle.install.v1"]),
    );
    expect(prepared.occupancy).toBeDefined();
  });

  it("requires the lease for every execution command on the profile surface", async () => {
    const { client, results } = captureClient();
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: occupancyEnv(),
      profile: "executor",
    });
    const runtime = prepared.start({ client });

    await runtime.invoke(
      invokeFrame({ id: "cold-run", command: "system.run", sessionKey: "agent:root:1" }),
    );
    expect(results.find((result) => result.id === "cold-run")).toMatchObject({
      ok: false,
      error: { code: NODE_DEVICE_UNOCCUPIED_ERROR_CODE },
    });
    expect(mocks.handleInvoke).not.toHaveBeenCalled();

    await runtime.close();
  });
});

describe("node host occupancy revoke authority", () => {
  it("only lets the holder session revoke over the invoke channel", async () => {
    const { client, results, events } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);
    await runtime.invoke(
      invokeFrame({
        id: "acquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );

    await runtime.invoke(
      invokeFrame({
        id: "foreign-revoke",
        command: "occupancy.revoke.v1",
        sessionKey: "agent:root:2",
        paramsJSON: JSON.stringify({ sessionKey: "agent:root:1", leaseToken: "lease-token" }),
      }),
    );
    expect(results.find((result) => result.id === "foreign-revoke")).toMatchObject({
      ok: false,
      error: { code: NODE_DEVICE_OCCUPIED_ERROR_CODE },
    });

    // The holder session must still prove the current token.
    await runtime.invoke(
      invokeFrame({
        id: "stale-revoke",
        command: "occupancy.revoke.v1",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "stale" }),
      }),
    );
    expect(results.find((result) => result.id === "stale-revoke")).toMatchObject({
      ok: false,
      error: { code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE },
    });

    await runtime.invoke(invokeFrame({ id: "status", command: "occupancy.status.v1" }));
    expect(
      JSON.parse(results.find((result) => result.id === "status")?.payloadJSON ?? "{}"),
    ).toMatchObject({
      occupied: true,
    });

    // The operator path carries no session identity and force-clears.
    await runtime.invoke(invokeFrame({ id: "operator-revoke", command: "occupancy.revoke.v1" }));
    expect(
      JSON.parse(results.find((result) => result.id === "operator-revoke")?.payloadJSON ?? "{}"),
    ).toMatchObject({
      ok: true,
      revoked: true,
    });
    expect(events.at(-1)).toMatchObject({
      event: NODE_OCCUPANCY_STATUS_EVENT,
      payloadJSON: JSON.stringify({ occupied: false }),
    });

    await runtime.close();
  });
});

describe("node host occupancy disconnect cleanup", () => {
  it("aborts and waits for holder-owned exec processes before clearing occupancy", async () => {
    const { client } = captureClient();
    const runtime = await startOccupancyRuntime(occupancyEnv(), client);
    await runtime.invoke(
      invokeFrame({
        id: "acquire",
        command: "occupancy.acquire.v1",
        paramsJSON: acquireParams("lease-token"),
      }),
    );

    const held = createDeferred<void>();
    let execSignal: AbortSignal | undefined;
    mocks.handleInvoke.mockImplementationOnce(async (...args: unknown[]) => {
      const runtimeOptions = args[4] as { signal?: AbortSignal };
      execSignal = runtimeOptions.signal;
      await held.promise;
    });

    const exec = runtime.invoke(
      invokeFrame({
        id: "exec",
        command: "system.run",
        sessionKey: "agent:root:1",
        paramsJSON: JSON.stringify({ leaseToken: "lease-token", command: ["true"] }),
      }),
    );
    await vi.waitFor(() => expect(execSignal).toBeDefined());

    let disconnectSettled = false;
    const disconnected = runtime.cancelAll().then(() => {
      disconnectSettled = true;
    });
    await vi.waitFor(() => expect(execSignal?.aborted).toBe(true));
    // Extinction is required before occupancy clears.
    expect(disconnectSettled).toBe(false);

    held.resolve();
    await exec;
    await disconnected;
    expect(mocks.disconnectPlugins).toHaveBeenCalled();

    await runtime.close();
  });
});
