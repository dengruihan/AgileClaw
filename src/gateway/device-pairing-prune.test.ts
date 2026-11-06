// Covers gateway-side cleanup when silent pairing supersedes stale sibling records.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import {
  listDevicePairing,
  removePairedDeviceRole,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "../infra/push-apns.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { pruneSupersededSilentPairingsAfterApproval } from "./device-pairing-prune.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "./node-pending-work.js";
import { enqueuePendingNodeAction, listPendingNodeActions } from "./node-runtime-state.js";
import {
  captureNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "./node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "./node-wake-state.test-support.js";
import {
  clearAllSessionScopeLeasesForTest,
  readSessionScopeLease,
  recordSessionScopeLease,
} from "./session-scope-lease.js";
import { bindDeviceWorkerReconciliation } from "./worker-environments/device-provider.js";

const pairingStateDirs: string[] = [];
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-pairing-prune-" });

type BroadcastCall = { event: string; payload: Record<string, unknown> };
type PruneContext = Parameters<typeof pruneSupersededSilentPairingsAfterApproval>[0]["context"];

function createPruneContext(params?: {
  connectedDeviceIds?: string[];
  workerEnvironmentIds?: Record<string, readonly string[]>;
}) {
  const broadcasts: BroadcastCall[] = [];
  const invalidated: string[] = [];
  const disconnected: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const clearedSurfaces: string[] = [];
  const revokedWorkers: string[] = [];
  const reconciledPlacements: string[] = [];
  const order: string[] = [];
  const connected = new Set(params?.connectedDeviceIds ?? []);
  const workerEnvironmentService = {} as NonNullable<PruneContext["workerEnvironmentService"]>;
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    revokedWorkers.push(deviceId);
    order.push(`worker:${deviceId}`);
    return params?.workerEnvironmentIds?.[deviceId] ?? [];
  });
  const workerPlacementDispatchService = {
    reconcileActive: async (environmentId: string) => {
      reconciledPlacements.push(environmentId);
      order.push(`placement:${environmentId}`);
    },
  } as NonNullable<PruneContext["workerPlacementDispatchService"]>;
  const context: PruneContext = {
    broadcast: (event, payload) => {
      broadcasts.push({ event, payload: payload as Record<string, unknown> });
    },
    logGateway: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => warnings.push(message),
    },
    hasConnectedClientsForDevice: (deviceId: string) => connected.has(deviceId),
    invalidateClientsForDevice: (deviceId: string) => {
      invalidated.push(deviceId);
      order.push(`invalidate:${deviceId}`);
    },
    disconnectClientsForDevice: (deviceId: string) => {
      disconnected.push(deviceId);
      order.push(`disconnect:${deviceId}`);
    },
    workerEnvironmentService,
    workerPlacementDispatchService,
    nodeRegistry: {
      updateSurface: (nodeId: string) => {
        clearedSurfaces.push(nodeId);
        return null;
      },
    },
  };
  return {
    broadcasts,
    invalidated,
    disconnected,
    logs,
    warnings,
    clearedSurfaces,
    revokedWorkers,
    reconciledPlacements,
    order,
    context,
  };
}

async function pairSilentDevice(params: {
  baseDir: string;
  deviceId: string;
  roles: string[];
  clientId: string;
  clientMode: string;
  displayName?: string;
}) {
  const request = await requestDevicePairing(
    {
      deviceId: params.deviceId,
      publicKey: `pk-${params.deviceId}`,
      clientId: params.clientId,
      clientMode: params.clientMode,
      displayName: params.displayName,
      role: params.roles[0],
      roles: params.roles,
      scopes: [],
    },
    params.baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: "silent" },
    params.baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${params.deviceId}`);
  }
  return approved.device;
}

describe("pruneSupersededSilentPairingsAfterApproval", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    for (const stateDir of pairingStateDirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    await suiteRootTracker.cleanup();
  });

  afterEach(() => {
    resetNodeWakeStateForTest();
    clearAllSessionScopeLeasesForTest();
  });

  test("retires stale node siblings across both pairing stores", async () => {
    const baseDir = await suiteRootTracker.make("case");
    pairingStateDirs.push(baseDir);
    await pairSilentDevice({
      baseDir,
      deviceId: "node-stale",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const nodeRequest = await requestNodePairing(
      { nodeId: "node-stale", displayName: "megaclaw" },
      baseDir,
    );
    await approveNodePairing(nodeRequest.request.requestId, { callerScopes: [] }, baseDir);
    const anchor = await pairSilentDevice({
      baseDir,
      deviceId: "node-anchor",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    await registerApnsRegistration({
      nodeId: "node-stale",
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      baseDir,
    });
    await runNodeWakeAttempt({
      nodeId: "node-stale",
      force: true,
      throttleMs: 60_000,
      attempt: async (markAttempted) => {
        markAttempted();
        return { available: true, throttled: false, path: "sent", durationMs: 1 };
      },
    });
    await runNodeWakeNudgeAttempt({
      nodeId: "node-stale",
      throttleMs: 60_000,
      throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
      attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
    });
    enqueueNodePendingWork({ nodeId: "node-stale", type: "location.request" });
    enqueuePendingNodeAction({
      nodeId: "node-stale",
      pairingGeneration: "generation-1",
      command: "camera.capture",
      idempotencyKey: "idem-1",
      ttlMs: 60_000,
      maxPerNode: 10,
    });
    const wakeLifecycle = captureNodeWakeLifecycle("node-stale");

    const harness = createPruneContext({
      workerEnvironmentIds: { "node-stale": ["environment-node-stale"] },
    });
    const pruned = await pruneSupersededSilentPairingsAfterApproval({
      deviceId: anchor.deviceId,
      context: harness.context,
      baseDir,
      nowMs: Date.now() + 120_000,
    });

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["node-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId)).toEqual(["node-anchor"]);
    const nodes = await listNodePairing(baseDir);
    expect(nodes.paired).toHaveLength(0);
    expect(getNodeWakeStateSnapshot("node-stale")).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork("node-stale", { includeDefaultStatus: false }).items).toEqual([]);
    expect(listPendingNodeActions({ nodeId: "node-stale", ttlMs: 60_000 })).toEqual([]);
    await expect(loadApnsRegistration("node-stale", baseDir)).resolves.toBeNull();
    expect(harness.invalidated).toEqual(["node-stale"]);
    expect(harness.revokedWorkers).toEqual(["node-stale"]);
    expect(harness.reconciledPlacements).toEqual(["environment-node-stale"]);
    expect(harness.disconnected).toEqual(["node-stale"]);
    expect(harness.order).toEqual([
      "invalidate:node-stale",
      "worker:node-stale",
      "placement:environment-node-stale",
      "disconnect:node-stale",
    ]);
    expect(harness.clearedSurfaces).toEqual(["node-stale"]);
    expect(harness.warnings).toEqual([]);
    expect(harness.broadcasts).toEqual([
      {
        event: "node.pair.resolved",
        payload: expect.objectContaining({ nodeId: "node-stale", decision: "removed" }),
      },
    ]);
  });

  test("keeps connected siblings and clears APNs for operator-only full prunes", async () => {
    const baseDir = await suiteRootTracker.make("case");
    pairingStateDirs.push(baseDir);
    await pairSilentDevice({
      baseDir,
      deviceId: "cli-stale",
      roles: ["operator", "node"],
      clientId: "cli",
      clientMode: "cli",
    });
    await registerApnsRegistration({
      nodeId: "cli-stale",
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      baseDir,
    });
    await expect(
      removePairedDeviceRole({ deviceId: "cli-stale", role: "node", baseDir }),
    ).resolves.toEqual({ deviceId: "cli-stale", role: "node", removedDevice: false });
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toMatchObject({
      nodeId: "cli-stale",
    });
    await pairSilentDevice({
      baseDir,
      deviceId: "cli-live",
      roles: ["operator"],
      clientId: "cli",
      clientMode: "cli",
    });
    const anchor = await pairSilentDevice({
      baseDir,
      deviceId: "cli-anchor",
      roles: ["operator"],
      clientId: "cli",
      clientMode: "cli",
    });

    const harness = createPruneContext({ connectedDeviceIds: ["cli-live"] });
    const pruned = await pruneSupersededSilentPairingsAfterApproval({
      deviceId: anchor.deviceId,
      context: harness.context,
      baseDir,
      nowMs: Date.now() + 120_000,
    });

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["cli-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId).toSorted()).toEqual([
      "cli-anchor",
      "cli-live",
    ]);
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toBeNull();
    expect(harness.broadcasts).toEqual([]);
    expect(harness.disconnected).toEqual(["cli-stale"]);
  });

  test("retires mirrored occupancy leases and records one delete fact per pruned device", async () => {
    const baseDir = await suiteRootTracker.make("case");
    pairingStateDirs.push(baseDir);
    await pairSilentDevice({
      baseDir,
      deviceId: "lease-stale",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const anchor = await pairSilentDevice({
      baseDir,
      deviceId: "lease-anchor",
      roles: ["node"],
      clientId: "node-host",
      clientMode: "node",
      displayName: "megaclaw",
    });
    const admissionToken = createExecutionIdentityAdmissionToken("run-prune", {
      contextId: "context-prune",
      executionId: "execution-prune",
      now: 5,
    });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "lease-stale",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
      admissionToken,
    });
    const work: ExecutionDecisionWork[] = [];
    const clearWorkSink = configureExecutionDecisionWorkSink((item) => {
      work.push(item);
      return true;
    });
    const harness = createPruneContext();

    try {
      const pruned = await pruneSupersededSilentPairingsAfterApproval({
        deviceId: anchor.deviceId,
        context: harness.context,
        baseDir,
        nowMs: Date.now() + 120_000,
      });
      expect(pruned.map((entry) => entry.deviceId)).toEqual(["lease-stale"]);
    } finally {
      clearWorkSink();
    }

    // Superseded pruning is a pairing removal owner too: the mirrored lease is
    // retired and exactly one attribution-only delete fact records it, matching
    // device.pair.remove/node.pair.remove.
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
    expect(work.map((item) => item.receipt.decision)).toEqual([
      { outcome: "not-applicable", reasonCode: "device_lease_delete" },
    ]);
    expect(work[0]?.token).toEqual(admissionToken);
    expect(work[0]?.receipt.enforcement).toMatchObject({ coverageState: "attribution-only" });
    // Raw device and session bytes ride only in the private work item; the
    // writer projects them and the keyed receipt id before persistence.
    expect(work[0]?.refs?.resource).toEqual({ namespace: "device", value: "lease-stale" });
  });
});
