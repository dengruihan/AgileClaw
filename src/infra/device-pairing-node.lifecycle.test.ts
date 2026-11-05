// Capability approvals follow the paired-device lifecycle, not the device-auth request TTL.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  captureAuthenticatedNodePairingState,
  isPairedNodeDeviceDisabled,
} from "./device-pairing-node-state.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  listNodePairing,
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  rejectNodePairing,
  requestNodePairing,
  setPairedNodeDeviceCommandPolicy,
  setPairedNodeDeviceEnabled,
} from "./device-pairing-node.js";
import { seedNodeDevice, setupPairedNode } from "./device-pairing-node.test-support.js";
import {
  getPairedDevice,
  listDevicePairingReadOnly,
  removePairedDeviceRole,
  requestDevicePairing,
  resolveNodePairingGeneration,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-lifecycle-" });
const databasePaths = new Set<string>();
async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  const baseDir = await tempDirs.make("case");
  databasePaths.add(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: baseDir }),
  );
  return await run(baseDir);
}

describe("node surface approval lifetime", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });
  afterAll(async () => {
    for (const databasePath of databasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    await tempDirs.cleanup();
  });

  test.each(["initial", "reapproval"])(
    "keeps %s capability approval pending across aged reads, writes, and database reopen",
    async (kind) => {
      await withNodePairingDir(async (baseDir) => {
        if (kind === "initial") {
          await seedNodeDevice(baseDir, "node-1");
        } else {
          await setupPairedNode(baseDir);
        }
        const requestedAtMs = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
        try {
          const { request } = await requestNodePairing(
            {
              nodeId: "node-1",
              platform: "android",
              caps: ["voiceWake"],
              commands: ["system.run"],
            },
            baseDir,
          );
          const database = openOpenClawStateDatabase({
            env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
          });
          now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
          const expectedPending = { requestId: request.requestId, caps: ["voiceWake"] };

          expect
            .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          expect
            .soft((await listDevicePairingReadOnly(baseDir)).paired[0]?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          expect.soft((await listNodePairing(baseDir)).pending).toEqual([request]);
          await updatePairedDeviceMetadata("node-1", { displayName: "Still connected" }, baseDir);
          expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
          expect
            .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          await expect
            .soft(
              approveNodePairing(
                request.requestId,
                { callerScopes: ["operator.pairing"] },
                baseDir,
              ),
            )
            .resolves.toEqual({ status: "forbidden", missingScope: "operator.admin" });
          await expect
            .soft(
              approveNodePairing(
                request.requestId,
                { callerScopes: ["operator.pairing", "operator.admin"] },
                baseDir,
              ),
            )
            .resolves.toMatchObject({
              requestId: request.requestId,
              node: { caps: ["voiceWake"] },
            });
          expect((await listNodePairing(baseDir)).pending).toEqual([]);
        } finally {
          now.mockRestore();
        }
      });
    },
  );

  test.each(["rejection", "successful reconnect", "node-role removal"])(
    "resolves aged capability reapproval through %s",
    async (resolution) => {
      await withNodePairingDir(async (baseDir) => {
        await setupPairedNode(baseDir);
        if (resolution === "node-role removal") {
          const operator = await requestDevicePairing(
            { deviceId: "node-1", publicKey: "test-key-node-1", role: "operator", scopes: [] },
            baseDir,
          );
          await approveDevicePairing(operator.request.requestId, { callerScopes: [] }, baseDir);
        }
        const requestedAtMs = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
        try {
          const { request } = await requestNodePairing(
            { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
            baseDir,
          );
          now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
          expect((await listNodePairing(baseDir)).pending).toEqual([request]);
          if (resolution === "rejection") {
            await expect(rejectNodePairing(request.requestId, baseDir)).resolves.toEqual({
              requestId: request.requestId,
              nodeId: "node-1",
            });
          } else if (resolution === "successful reconnect") {
            const { cleanupClaim } = await beginNodePairingConnect("node-1", baseDir);
            await expect(
              finalizeNodePairingCleanupClaim(expectDefined(cleanupClaim, "cleanup claim")),
            ).resolves.toEqual([{ requestId: request.requestId, nodeId: "node-1" }]);
          } else {
            await expect(
              removePairedDeviceRole({ deviceId: "node-1", role: "node", baseDir }),
            ).resolves.toEqual({ deviceId: "node-1", role: "node", removedDevice: false });
          }
          const database = openOpenClawStateDatabase({
            env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
          });
          expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
          const device = await getPairedDevice("node-1", baseDir);
          expect(device?.pendingNodeSurface).toBeUndefined();
          if (resolution === "node-role removal") {
            expect(device?.roles).toEqual(["operator"]);
            expect(device?.nodeSurface).toBeUndefined();
          } else {
            expect(device?.nodeSurface?.commands).toEqual(["system.run"]);
          }
          await expect(
            approveNodePairing(
              request.requestId,
              { callerScopes: ["operator.pairing", "operator.admin"] },
              baseDir,
            ),
          ).resolves.toBeNull();
        } finally {
          now.mockRestore();
        }
      });
    },
  );

  test("keeps an aged capability reapproval through a recorded disconnect", async () => {
    await withNodePairingDir(async (baseDir) => {
      const generation = await setupPairedNode(baseDir);
      await expect(
        recordPairedNodeConnection("node-1", 1_000, baseDir, generation),
      ).resolves.toEqual({ recorded: true, firstConnection: true });
      const requestedAtMs = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
      try {
        const { request } = await requestNodePairing(
          { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
          baseDir,
        );
        now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);

        await expect(
          recordPairedNodeDisconnection({
            nodeId: "node-1",
            connectedAtMs: 1_000,
            disconnectedAtMs: 2_000,
            expectedPairingGeneration: generation,
            baseDir,
          }),
        ).resolves.toEqual({ recorded: true });

        const database = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
        });
        expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
        expect((await listNodePairing(baseDir)).pending).toEqual([request]);
      } finally {
        now.mockRestore();
      }
    });
  });

  test("supersedes an aged capability request with a changed surface", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const requestedAtMs = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
      try {
        const first = await requestNodePairing(
          { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
          baseDir,
        );
        now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
        const second = await requestNodePairing(
          {
            nodeId: "node-1",
            caps: ["voiceWake"],
            commands: ["system.run", "system.which"],
          },
          baseDir,
        );

        expect(second.superseded).toEqual([
          { requestId: first.request.requestId, nodeId: "node-1" },
        ]);
        expect((await listNodePairing(baseDir)).pending).toEqual([second.request]);
        await expect(
          approveNodePairing(
            first.request.requestId,
            { callerScopes: ["operator.pairing", "operator.admin"] },
            baseDir,
          ),
        ).resolves.toBeNull();
      } finally {
        now.mockRestore();
      }
    });
  });

  describe("device registry", () => {
    // Registry tests use per-run device ids so a reused state database cannot
    // turn a fresh pairing into a repair of an earlier run.
    function registryNodeId(label: string): string {
      return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    async function approveSurface(baseDir: string, nodeId: string) {
      const pending = await requestNodePairing(
        { nodeId, platform: "darwin", commands: ["system.run", "canvas.snapshot"] },
        baseDir,
      );
      await approveNodePairing(
        pending.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin"] },
        baseDir,
      );
    }

    async function captureNodeSurface(baseDir: string, nodeId: string) {
      const device = await getPairedDevice(nodeId, baseDir);
      if (!device?.tokens?.node) {
        throw new Error("expected a paired node token");
      }
      return await captureAuthenticatedNodePairingState({
        nodeId,
        publicKey: device.publicKey,
        token: device.tokens.node.token,
        baseDir,
      });
    }

    test("registers a new pairing disabled and enables it on surface approval", async () => {
      await withNodePairingDir(async (baseDir) => {
        const nodeId = registryNodeId("registry-new");
        await seedNodeDevice(baseDir, nodeId);
        expect((await getPairedDevice(nodeId, baseDir))?.enabled).toBe(false);

        await approveSurface(baseDir, nodeId);

        const device = await getPairedDevice(nodeId, baseDir);
        expect(device?.enabled).toBe(true);
        expect(resolveNodePairingGeneration(device)?.key).toBeTruthy();
      });
    });

    test("disabling a paired node removes execution eligibility but keeps the record", async () => {
      await withNodePairingDir(async (baseDir) => {
        const nodeId = registryNodeId("registry-disable");
        await seedNodeDevice(baseDir, nodeId);
        await approveSurface(baseDir, nodeId);
        expect((await captureNodeSurface(baseDir, nodeId))?.approvedSurface.commands).toEqual([
          "system.run",
          "canvas.snapshot",
        ]);

        const disabled = await setPairedNodeDeviceEnabled(nodeId, false, baseDir);
        expect(disabled).toEqual({ nodeId, enabled: false });
        await expect(isPairedNodeDeviceDisabled(nodeId, baseDir)).resolves.toBe(true);

        const state = await captureNodeSurface(baseDir, nodeId);
        expect(state?.identity.nodeId).toBe(nodeId);
        expect(state?.approvedSurface).toEqual({ caps: [], commands: [] });
        expect(state?.generation).toBeNull();

        // The approved surface stays on the record so the inventory keeps it visible.
        expect((await listNodePairing(baseDir)).paired[0]?.commands).toEqual([
          "system.run",
          "canvas.snapshot",
        ]);

        await expect(setPairedNodeDeviceEnabled(nodeId, true, baseDir)).resolves.toEqual({
          nodeId,
          enabled: true,
        });
        await expect(isPairedNodeDeviceDisabled(nodeId, baseDir)).resolves.toBe(false);
        expect((await captureNodeSurface(baseDir, nodeId))?.generation?.key).toBeTruthy();
      });
    });

    test("filters the approved surface with the per-device command policy", async () => {
      await withNodePairingDir(async (baseDir) => {
        const nodeId = registryNodeId("registry-policy");
        await seedNodeDevice(baseDir, nodeId);
        await approveSurface(baseDir, nodeId);

        await setPairedNodeDeviceCommandPolicy(nodeId, { deny: ["canvas.snapshot"] }, baseDir);
        expect((await captureNodeSurface(baseDir, nodeId))?.approvedSurface.commands).toEqual([
          "system.run",
        ]);

        // allow selects within the approved surface and cannot widen it.
        await setPairedNodeDeviceCommandPolicy(nodeId, { allow: ["canvas.snapshot"] }, baseDir);
        expect((await captureNodeSurface(baseDir, nodeId))?.approvedSurface.commands).toEqual([
          "canvas.snapshot",
        ]);
        await setPairedNodeDeviceCommandPolicy(nodeId, { allow: ["system.which"] }, baseDir);
        expect((await captureNodeSurface(baseDir, nodeId))?.approvedSurface.commands).toEqual([]);

        await setPairedNodeDeviceCommandPolicy(nodeId, null, baseDir);
        expect((await captureNodeSurface(baseDir, nodeId))?.approvedSurface.commands).toEqual([
          "system.run",
          "canvas.snapshot",
        ]);
      });
    });

    test("rejects registry updates for devices without an approved node role", async () => {
      await withNodePairingDir(async (baseDir) => {
        await expect(setPairedNodeDeviceEnabled("missing", false, baseDir)).resolves.toBeNull();

        const operatorId = registryNodeId("registry-operator");
        const request = await requestDevicePairing(
          {
            deviceId: operatorId,
            publicKey: `operator-key-${operatorId}`,
            role: "operator",
            scopes: [],
          },
          baseDir,
        );
        await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
        await expect(setPairedNodeDeviceEnabled(operatorId, false, baseDir)).resolves.toBeNull();
      });
    });
  });
});
