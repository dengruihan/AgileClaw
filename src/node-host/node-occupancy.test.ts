import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeOccupancyStatus } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  NODE_DEVICE_OCCUPIED_ERROR_CODE,
  NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
  NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
} from "../infra/node-commands.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { NODE_OCCUPANCY_MACHINE_STATE_KEY, NodeOccupancyOwner } from "./node-occupancy.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

const fixture = createFixtureLifetime();

function makeOwner(events?: NodeOccupancyStatus[]) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: fixture.createTempDir("node-occupancy-") };
  return {
    env,
    owner: new NodeOccupancyOwner({
      env,
      now: () => 1_700_000_000_000,
      ...(events ? { onStatusEvent: (status) => events.push(status) } : {}),
    }),
  };
}

function acquireSession(sessionKey: string, leaseToken = "lease-token") {
  return {
    sessionKey,
    sessionId: `${sessionKey}-session`,
    agentId: "agent-1",
    runId: "run-1",
    turnId: "turn-1",
    leaseToken,
  };
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fixture.cleanup();
});

describe("NodeOccupancyOwner state machine", () => {
  it("admits exactly one holder and rejects other sessions with their identity", () => {
    const { owner } = makeOwner();
    const acquired = owner.acquire(acquireSession("agent:root:1"));
    expect(acquired).toMatchObject({
      ok: true,
      holder: { sessionKey: "agent:root:1", sessionId: "agent:root:1-session", runId: "run-1" },
    });

    const rejected = owner.acquire(acquireSession("agent:root:2"));
    expect(rejected).toEqual({
      ok: false,
      code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
      message: expect.stringContaining("agent:root:1"),
    });
    if (!rejected.ok) {
      expect(rejected.message).toContain("agent:root:1-session");
      expect(rejected.message).toContain("agent-1");
    }
    expect(owner.status()).toMatchObject({
      occupied: true,
      holder: { sessionKey: "agent:root:1" },
    });
  });

  it("lets the holder session re-acquire for a newer turn and invalidates the old token", () => {
    const { owner } = makeOwner();
    expect(owner.acquire(acquireSession("agent:root:1", "token-turn-1"))).toMatchObject({
      ok: true,
    });
    expect(owner.acquire(acquireSession("agent:root:1", "token-turn-2"))).toMatchObject({
      ok: true,
      leaseToken: "token-turn-2",
    });
    expect(
      owner.admitExecution({
        command: "system.run",
        sessionKey: "agent:root:1",
        leaseToken: "token-turn-1",
      }),
    ).toMatchObject({ ok: false, code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE });
    expect(
      owner.admitExecution({
        command: "system.run",
        sessionKey: "agent:root:1",
        leaseToken: "token-turn-2",
      }),
    ).toEqual({ ok: true, sessionKey: "agent:root:1", leaseToken: "token-turn-2" });
  });

  it("renews only the current holder token", () => {
    const { owner } = makeOwner();
    owner.acquire(acquireSession("agent:root:1", "token-1"));

    expect(owner.renew({ sessionKey: "agent:root:2", leaseToken: "token-1" })).toMatchObject({
      ok: false,
      code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
    });
    expect(owner.renew({ sessionKey: "agent:root:1", leaseToken: "stale" })).toEqual({
      ok: false,
      code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
      message: expect.stringContaining("agent:root:1"),
    });
    expect(owner.renew({ sessionKey: "agent:root:1", leaseToken: "token-1" })).toMatchObject({
      ok: true,
      holder: { renewedAtMs: 1_700_000_000_000 },
    });
  });

  it("releases idempotently and rejects foreign or stale releases", () => {
    const { owner } = makeOwner();
    expect(owner.release({ sessionKey: "agent:root:1", leaseToken: "token-1" })).toEqual({
      ok: true,
      released: false,
    });
    owner.acquire(acquireSession("agent:root:1", "token-1"));

    expect(owner.release({ sessionKey: "agent:root:2", leaseToken: "token-1" })).toMatchObject({
      ok: false,
      code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
    });
    expect(owner.release({ sessionKey: "agent:root:1", leaseToken: "stale" })).toMatchObject({
      ok: false,
      code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
    });
    expect(owner.release({ sessionKey: "agent:root:1", leaseToken: "token-1" })).toMatchObject({
      ok: true,
      released: true,
      holder: { sessionKey: "agent:root:1" },
    });
    expect(owner.status()).toEqual({ occupied: false });
    expect(owner.release({ sessionKey: "agent:root:1", leaseToken: "token-1" })).toEqual({
      ok: true,
      released: false,
    });
  });

  it("revokes the current holder after killing their processes", async () => {
    const { owner } = makeOwner();
    owner.acquire(acquireSession("agent:root:1", "token-1"));
    owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      { detached: false, kill: async () => {} },
    );

    expect(await owner.revoke({ sessionKey: "agent:root:2" })).toMatchObject({
      ok: false,
      code: NODE_DEVICE_OCCUPIED_ERROR_CODE,
    });
    expect(await owner.revoke({ sessionKey: "agent:root:1", leaseToken: "stale" })).toMatchObject({
      ok: false,
      code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE,
    });
    expect(await owner.revoke({ sessionKey: "agent:root:1", leaseToken: "token-1" })).toMatchObject(
      {
        ok: true,
        revoked: true,
        killedProcesses: 1,
        holder: { sessionKey: "agent:root:1" },
      },
    );
    expect(owner.status()).toEqual({ occupied: false });
  });

  it("never exposes the lease token through status or the durable row", () => {
    const { env, owner } = makeOwner();
    owner.acquire(acquireSession("agent:root:1", "secret-lease-token"));

    expect(JSON.stringify(owner.status())).not.toContain("secret-lease-token");
    expect(
      JSON.stringify(readConfigMachineState(NODE_OCCUPANCY_MACHINE_STATE_KEY, { env })),
    ).not.toContain("secret-lease-token");
  });
});

describe("NodeOccupancyOwner durable row", () => {
  it("mirrors the holder identity under the documented key and clears occupancy on boot", () => {
    const { env, owner } = makeOwner();
    expect(NODE_OCCUPANCY_MACHINE_STATE_KEY).toBe("nodeHost.occupancy.v1");
    owner.acquire(acquireSession("agent:root:1", "token-1"));

    const readRow = () => readConfigMachineState(NODE_OCCUPANCY_MACHINE_STATE_KEY, { env });
    const persisted = readRow();
    expect(persisted).toMatchObject({
      sessionKey: "agent:root:1",
      runId: "run-1",
      acquiredAtMs: 1_700_000_000_000,
    });

    owner.release({ sessionKey: "agent:root:1", leaseToken: "token-1" });
    expect(readRow()).toBeUndefined();

    // A crashed host leaves the row behind; the next boot must clear it.
    owner.acquire(acquireSession("agent:root:1", "token-2"));
    closeOpenClawStateDatabaseForTest();
    const restarted = new NodeOccupancyOwner({ env });
    expect(restarted.initialize()).toMatchObject({ sessionKey: "agent:root:1" });
    expect(restarted.status()).toEqual({ occupied: false });
    expect(readRow()).toBeUndefined();
  });
});

describe("NodeOccupancyOwner per-call admission", () => {
  it("rejects every execution command without the current holder lease", () => {
    const { owner } = makeOwner();
    const unoccupied = owner.admitExecution({
      command: "system.run",
      sessionKey: "agent:root:1",
      leaseToken: "token-1",
    });
    expect(unoccupied).toEqual({
      ok: false,
      code: NODE_DEVICE_UNOCCUPIED_ERROR_CODE,
      message: expect.any(String),
    });

    owner.acquire(acquireSession("agent:root:1", "token-1"));
    expect(
      owner.admitExecution({ command: "system.run", sessionKey: undefined, leaseToken: undefined }),
    ).toMatchObject({ ok: false, code: NODE_DEVICE_OCCUPIED_ERROR_CODE });
    expect(
      owner.admitExecution({
        command: "file.stat",
        sessionKey: "agent:root:1",
        leaseToken: undefined,
      }),
    ).toMatchObject({ ok: false, code: NODE_LEASE_TOKEN_MISMATCH_ERROR_CODE });
    expect(
      owner.admitExecution({
        command: "file.stat",
        sessionKey: "agent:root:1",
        leaseToken: "token-1",
      }),
    ).toEqual({ ok: true, sessionKey: "agent:root:1", leaseToken: "token-1" });
  });

  it("refuses lease process registration without the current lease", () => {
    const { owner } = makeOwner();
    owner.acquire(acquireSession("agent:root:1", "token-1"));
    expect(() =>
      owner.registerLeaseProcess(
        { sessionKey: "agent:root:1", leaseToken: "stale" },
        { detached: false, kill: async () => {} },
      ),
    ).toThrow("INVALID_REQUEST");
    expect(() =>
      owner.registerLeaseProcess(
        { sessionKey: "agent:root:2", leaseToken: "token-1" },
        { detached: false, kill: async () => {} },
      ),
    ).toThrow("INVALID_REQUEST");
  });
});
