import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeOccupancyStatus } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { NodeOccupancyOwner } from "./node-occupancy.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

const fixture = createFixtureLifetime();

function makeOwner(events?: NodeOccupancyStatus[]) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: fixture.createTempDir("node-occupancy-proc-") };
  return {
    env,
    owner: new NodeOccupancyOwner({
      env,
      ...(events ? { onStatusEvent: (status) => events.push(status) } : {}),
    }),
  };
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fixture.cleanup();
});

describe("NodeOccupancyOwner disconnect cleanup", () => {
  it("tree-kills attached holder processes, waits for extinction, then clears", async () => {
    const { owner } = makeOwner();
    owner.acquire({
      sessionKey: "agent:root:1",
      sessionId: "session-1",
      runId: "run-1",
      leaseToken: "token-1",
    });
    const extinct = createDeferred();
    let killRequested = false;
    owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      {
        detached: false,
        kill: async () => {
          killRequested = true;
          await extinct.promise;
        },
      },
    );

    let disconnectSettled = false;
    const disconnected = owner.handleDisconnect().then(() => {
      disconnectSettled = true;
    });
    await Promise.resolve();
    expect(killRequested).toBe(true);
    expect(disconnectSettled).toBe(false);
    expect(owner.status()).toMatchObject({ occupied: true });

    extinct.resolve();
    await disconnected;
    expect(owner.status()).toEqual({ occupied: false });
  });

  it("keeps occupancy when detached processes outlive the disconnect", async () => {
    const events: NodeOccupancyStatus[] = [];
    const { owner } = makeOwner(events);
    owner.acquire({
      sessionKey: "agent:root:1",
      sessionId: "session-1",
      runId: "run-1",
      leaseToken: "token-1",
    });
    const detachedExit = createDeferred();
    const detached = owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      {
        detached: true,
        kill: async () => {
          detachedExit.resolve();
        },
      },
    );

    await owner.handleDisconnect();
    expect(owner.status()).toMatchObject({
      occupied: true,
      holder: { sessionKey: "agent:root:1", detachedProcesses: 1 },
    });

    // The last detached process exiting releases the lease and emits a status event.
    events.length = 0;
    detachedExit.resolve();
    detached.settle();
    expect(owner.status()).toEqual({ occupied: false });
    expect(events.at(-1)).toEqual({ occupied: false });
  });

  it("holds a requested release until live lease processes are extinct", async () => {
    const { owner } = makeOwner();
    owner.acquire({
      sessionKey: "agent:root:1",
      sessionId: "session-1",
      runId: "run-1",
      leaseToken: "token-1",
    });
    const attached = owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      { detached: false, kill: async () => {} },
    );

    const released = owner.release({ sessionKey: "agent:root:1", leaseToken: "token-1" });
    expect(released).toMatchObject({ ok: true, released: false });
    expect(owner.status()).toMatchObject({ occupied: true });

    attached.settle();
    expect(owner.status()).toEqual({ occupied: false });
  });

  it("keeps a live turn lease when a detached process exits mid-session", async () => {
    const { owner } = makeOwner();
    owner.acquire({
      sessionKey: "agent:root:1",
      sessionId: "session-1",
      runId: "run-1",
      leaseToken: "token-1",
    });
    const detached = owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      { detached: true, kill: async () => {} },
    );

    detached.settle();
    expect(owner.status()).toMatchObject({ occupied: true });
  });

  it("kills detached processes too when the lease is revoked", async () => {
    const { owner } = makeOwner();
    owner.acquire({
      sessionKey: "agent:root:1",
      sessionId: "session-1",
      runId: "run-1",
      leaseToken: "token-1",
    });
    let detachedKilled = false;
    owner.registerLeaseProcess(
      { sessionKey: "agent:root:1", leaseToken: "token-1" },
      {
        detached: true,
        kill: async () => {
          detachedKilled = true;
        },
      },
    );

    const revoked = await owner.revoke({});
    expect(revoked).toMatchObject({ ok: true, revoked: true, killedProcesses: 1 });
    expect(detachedKilled).toBe(true);
    expect(owner.status()).toEqual({ occupied: false });
  });
});
