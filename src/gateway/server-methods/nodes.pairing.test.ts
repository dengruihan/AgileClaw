// Covers the device-registry RPCs (enable/disable/update) and the disabled
// device's execution boundary on node.invoke.
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import {
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingGeneration,
} from "../../infra/device-pairing.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureNodeWakeLifecycle } from "../node-wake-state.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { bindDeviceWorkerReconciliation } from "../worker-environments/device-provider.js";
import { nodeInvokeHandlers } from "./nodes.invoke.js";
import { nodePairingHandlers } from "./nodes.pairing.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const createdStates: OpenClawTestState[] = [];

afterEach(async () => {
  resetNodeWakeStateForTest();
  vi.clearAllMocks();
  await closeStateDatabaseForTest();
  while (createdStates.length > 0) {
    await createdStates.pop()?.cleanup();
  }
});

async function createState(): Promise<void> {
  const state = await createOpenClawTestState({ label: "node-registry", layout: "state-only" });
  createdStates.push(state);
}

async function pairNode(nodeId = "node-1"): Promise<void> {
  const pairing = await requestDevicePairing({
    deviceId: nodeId,
    publicKey: `pk-${nodeId}`,
    role: "node",
    roles: ["node"],
    scopes: [],
  });
  await approveDevicePairing(pairing.request.requestId, { callerScopes: [] });
  const surface = await requestNodePairing({
    nodeId,
    platform: "darwin",
    commands: ["system.run"],
  });
  await approveNodePairing(surface.request.requestId, {
    callerScopes: ["operator.pairing", "operator.admin"],
  });
}

function createContext() {
  return {
    broadcast: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    invalidateClientsForDevice: vi.fn(),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: {
      get: vi.fn(),
      updateSurface: vi.fn(),
    },
  };
}

function createClient(scopes: string[], deviceId?: string) {
  return {
    ...(deviceId ? { isDeviceTokenAuth: true } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

async function invokePairingRpc(
  method: string,
  params: Record<string, unknown>,
  context: ReturnType<typeof createContext>,
  client = createClient(["operator.pairing"]),
) {
  const handler = (nodePairingHandlers as GatewayRequestHandlers)[method];
  if (!handler) {
    throw new Error(`${method} is not registered`);
  }
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "req-1", method },
    params,
    client,
    isWebchatConnect: () => false,
    respond,
    context: context as unknown as GatewayRequestHandlerOptions["context"],
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

describe("node.device registry RPCs", () => {
  it("disables a paired node with the node-role removal cleanup", async () => {
    await createState();
    await pairNode();
    const wakeLifecycle = captureNodeWakeLifecycle("node-1");
    const reconcileActive = vi.fn(async () => undefined);
    const workerEnvironmentService = {};
    bindDeviceWorkerReconciliation(workerEnvironmentService, async () => ["environment-1"]);
    const context = Object.assign(createContext(), {
      workerEnvironmentService,
      workerPlacementDispatchService: { reconcileActive },
    });

    const respond = await invokePairingRpc("node.device.disable", { nodeId: "node-1" }, context);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith(true, { nodeId: "node-1", enabled: false }, undefined);
    const device = await getPairedDevice("node-1");
    expect(device?.enabled).toBe(false);
    // The approved surface stays on the record for the inventory.
    expect(device?.nodeSurface?.commands).toEqual(["system.run"]);
    expect(resolveNodePairingGeneration(device)).toBeNull();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith("node-1", {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(reconcileActive).toHaveBeenCalledWith("environment-1");
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith("node-1", {
      role: "node",
      reason: "device-disabled",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith("node-1", { role: "node" });
  });

  it("enables a disabled node and invalidates its clients to reconnect", async () => {
    await createState();
    await pairNode();
    const context = createContext();
    await invokePairingRpc("node.device.disable", { nodeId: "node-1" }, context);

    const respond = await invokePairingRpc("node.device.enable", { nodeId: "node-1" }, context);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith(true, { nodeId: "node-1", enabled: true }, undefined);
    const device = await getPairedDevice("node-1");
    expect(device?.enabled).toBe(true);
    expect(resolveNodePairingGeneration(device)?.key).toBeTruthy();
    expect(context.invalidateClientsForDevice).toHaveBeenLastCalledWith("node-1", {
      role: "node",
      reason: "device-enabled",
    });
  });

  it("replaces the per-device command policy and clears it when omitted", async () => {
    await createState();
    await pairNode();
    const context = createContext();

    const respond = await invokePairingRpc(
      "node.device.update",
      { nodeId: "node-1", commands: { deny: ["system.run"] } },
      context,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { nodeId: "node-1", enabled: true, commandPolicy: { deny: ["system.run"] } },
      undefined,
    );
    expect((await getPairedDevice("node-1"))?.commandPolicy).toEqual({ deny: ["system.run"] });
    expect(context.invalidateClientsForDevice).toHaveBeenLastCalledWith("node-1", {
      role: "node",
      reason: "device-policy-updated",
    });

    const cleared = await invokePairingRpc("node.device.update", { nodeId: "node-1" }, context);
    expect(cleared).toHaveBeenCalledWith(true, { nodeId: "node-1", enabled: true }, undefined);
    expect((await getPairedDevice("node-1"))?.commandPolicy).toBeUndefined();
  });

  it("denies cross-device management from a non-admin device token", async () => {
    await createState();
    await pairNode();
    const context = createContext();

    const respond = await invokePairingRpc(
      "node.device.disable",
      { nodeId: "node-1" },
      context,
      createClient(["operator.pairing"], "other-device"),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node device disable denied" }),
    );
    expect((await getPairedDevice("node-1"))?.enabled).toBe(true);
    expect(context.invalidateClientsForDevice).not.toHaveBeenCalled();
  });

  it("reports unknown devices instead of mutating them", async () => {
    await createState();
    const context = createContext();

    const respond = await invokePairingRpc("node.device.enable", { nodeId: "missing" }, context);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "unknown nodeId" }),
    );
  });
});

describe("node.invoke against a disabled device", () => {
  it("fails immediately with DEVICE_DISABLED instead of a retry hint", async () => {
    await createState();
    await pairNode();
    await invokePairingRpc("node.device.disable", { nodeId: "node-1" }, createContext());

    const respond = vi.fn();
    const handler = nodeInvokeHandlers["node.invoke"];
    if (!handler) {
      throw new Error("node.invoke is not registered");
    }
    await handler({
      req: { type: "req", id: "req-1", method: "node.invoke" },
      params: {
        nodeId: "node-1",
        command: "system.run",
        idempotencyKey: "disabled-device-invoke",
        timeoutMs: 5_000,
      },
      client: createClient(["operator.write"]),
      isWebchatConnect: () => false,
      respond,
      context: createContext() as unknown as GatewayRequestHandlerOptions["context"],
    } as unknown as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("is disabled"),
        details: { code: "DEVICE_DISABLED", nodeId: "node-1" },
      }),
    );
  });
});
