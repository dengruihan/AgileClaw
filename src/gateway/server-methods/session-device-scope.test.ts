import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeOccupancyHolder } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { PairedDevice } from "../../infra/device-pairing.js";
import type { NodeSession } from "../node-session.types.js";
import {
  clearAllSessionScopeLeasesForTest,
  readSessionScopeLease,
  recordSessionScopeLease,
} from "../session-scope-lease.js";
import {
  DEVICE_SCOPE_LEASE_TTL_MS,
  acquireDeviceScopeLease,
  applyNodeOccupancyStatusForDevice,
  buildSessionDeviceScopeSnapshot,
  prepareDeviceScopeSwitch,
  releaseDeviceScopeLease,
  releaseRemovedDeviceScopeLeases,
  resolveSessionScopeRoot,
  revokeDeviceScopeLeases,
  validateDeviceScopeDevice,
  type DeviceScopeRegistry,
} from "./session-device-scope.js";

// The root walk reads the session store through the sharing owner; tests supply
// an explicit lineage map so no agent database is opened.
const SESSION_LINEAGE: Record<
  string,
  { canonicalKey: string; agentId: string; entry: SessionEntry }
> = {};

vi.mock("../session-sharing.js", () => ({
  resolveSessionSharingTarget: (params: { sessionKey: string }) =>
    SESSION_LINEAGE[params.sessionKey] ?? null,
}));

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
  for (const key of Object.keys(SESSION_LINEAGE)) {
    delete SESSION_LINEAGE[key];
  }
});

function pairedDevice(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "device-a",
    publicKey: "pk",
    role: "node",
    roles: ["node"],
    enabled: true,
    tokens: {
      node: { token: "node-token", role: "node", scopes: [], createdAtMs: 1 },
    },
    createdAtMs: 1,
    approvedAtMs: 2,
    ...overrides,
  } as PairedDevice;
}

function nodeSession(overrides: Partial<NodeSession> = {}): NodeSession {
  return {
    nodeId: "device-a",
    connId: "conn-1",
    client: {},
    declaredCaps: [],
    caps: ["occupancy"],
    declaredCommands: [],
    commands: ["occupancy.acquire.v1", "occupancy.release.v1", "system.run"],
    declaredNodePluginTools: [],
    nodePluginTools: [],
    nodeSkills: [],
    connectedAtMs: 1,
    displayName: "Desk Mac",
    platform: "darwin",
    ...overrides,
  } as NodeSession;
}

function holder(overrides: Partial<NodeOccupancyHolder> = {}): NodeOccupancyHolder {
  return {
    sessionKey: "agent:main:root",
    sessionId: "sess-1",
    runId: "run-1",
    acquiredAtMs: 5,
    detachedProcesses: 0,
    ...overrides,
  };
}

function fixtureRegistry(
  handler: (invoke: Record<string, unknown>) => {
    ok: boolean;
    payload?: unknown;
    error?: unknown;
  },
  session?: NodeSession,
): DeviceScopeRegistry & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    invoke: async (params) => {
      calls.push(params as Record<string, unknown>);
      return handler(params as Record<string, unknown>) as never;
    },
    get: () => session,
  };
}

describe("validateDeviceScopeDevice", () => {
  it("accepts a paired, enabled, connected executor device", () => {
    const result = validateDeviceScopeDevice({
      device: pairedDevice(),
      session: nodeSession(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.device).toMatchObject({
        deviceId: "device-a",
        connected: true,
        displayName: "Desk Mac",
        platform: "darwin",
      });
    }
  });

  it("rejects an unpaired device", () => {
    expect(validateDeviceScopeDevice({ device: null, session: undefined })).toMatchObject({
      ok: false,
      code: "DEVICE_NOT_FOUND",
    });
  });

  it("rejects a device without the node role", () => {
    const result = validateDeviceScopeDevice({
      device: pairedDevice({ role: "operator", roles: ["operator"] }),
      session: nodeSession(),
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_NOT_FOUND" });
  });

  it("rejects a disabled device even while it is connected", () => {
    const result = validateDeviceScopeDevice({
      device: pairedDevice({ enabled: false }),
      session: nodeSession(),
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_DISABLED" });
    if (!result.ok) {
      expect(result.message).toContain("node.device.enable");
    }
  });

  it("rejects a disconnected device", () => {
    expect(validateDeviceScopeDevice({ device: pairedDevice(), session: undefined })).toMatchObject(
      { ok: false, code: "DEVICE_NOT_CONNECTED" },
    );
  });

  it("rejects a connected node without the executor surface", () => {
    const result = validateDeviceScopeDevice({
      device: pairedDevice(),
      session: nodeSession({ commands: ["system.run"] }),
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_NOT_EXECUTOR" });
    if (!result.ok) {
      expect(result.message).toContain("occupancy.acquire.v1");
    }
  });
});

describe("acquireDeviceScopeLease", () => {
  it("ascends the root session identity and mirrors the granted lease", async () => {
    const registry = fixtureRegistry(() => ({
      ok: true,
      payload: {
        ok: true,
        holder: holder(),
        leaseToken: "node-token",
        acquiredAtMs: 5,
      },
    }));
    const result = await acquireDeviceScopeLease({
      registry,
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
      agentId: "main",
      runId: "run-1",
      now: () => Date.now(),
      mintLeaseToken: () => "minted",
    });
    expect(result.ok).toBe(true);
    expect(registry.calls[0]).toMatchObject({
      nodeId: "device-a",
      command: "occupancy.acquire.v1",
      sessionKey: "agent:main:root",
      params: {
        sessionKey: "agent:main:root",
        sessionId: "sess-1",
        runId: "run-1",
        leaseToken: "minted",
      },
    });
    expect(readSessionScopeLease("agent:main:root")).toMatchObject({
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "node-token",
      expiresAt: expect.any(Number),
    });
    expect(DEVICE_SCOPE_LEASE_TTL_MS).toBeGreaterThan(0);
  });

  it("reports DEVICE_OCCUPIED with the holder identity and never falls back", async () => {
    const result = await acquireDeviceScopeLease({
      registry: fixtureRegistry(() => ({
        ok: false,
        error: {
          code: "DEVICE_OCCUPIED",
          message: "device occupied by session agent:other",
        },
      })),
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
      mintLeaseToken: () => "minted",
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_OCCUPIED" });
    if (!result.ok) {
      expect(result.message).toContain("agent:other");
      expect(result.message).toContain("No queueing and no gateway fallback");
    }
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });

  it("fails a malformed grant instead of inventing a lease", async () => {
    const result = await acquireDeviceScopeLease({
      registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_LEASE_FAILED" });
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });
});

describe("releaseDeviceScopeLease", () => {
  it("notifies the node and drops the mirror", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "token-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const registry = fixtureRegistry(() => ({
      ok: true,
      payload: { ok: true, released: true },
    }));
    await expect(
      releaseDeviceScopeLease({ registry, rootSessionKey: "agent:main:root" }),
    ).resolves.toBe(true);
    expect(registry.calls[0]).toMatchObject({
      command: "occupancy.release.v1",
      params: { sessionKey: "agent:main:root", leaseToken: "token-1" },
    });
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });

  it("keeps a newer grant when an older caller releases with a stale token", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "token-2",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      releaseDeviceScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        leaseToken: "token-1",
        registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
      }),
    ).resolves.toBe(false);
    expect(readSessionScopeLease("agent:main:root")).toMatchObject({
      leaseToken: "token-2",
    });
  });
});

describe("resolveSessionScopeRoot", () => {
  it("walks subagent lineage to the root session", () => {
    SESSION_LINEAGE["agent:main:root"] = {
      canonicalKey: "agent:main:root",
      agentId: "main",
      entry: {
        sessionId: "root-id",
        updatedAt: 1,
        scopeDeviceId: "device-a",
      } as SessionEntry,
    };
    SESSION_LINEAGE["agent:main:subagent:child"] = {
      canonicalKey: "agent:main:subagent:child",
      agentId: "main",
      entry: {
        sessionId: "child-id",
        updatedAt: 1,
        spawnedBy: "agent:main:root",
        parentSessionKey: "agent:main:root",
      } as SessionEntry,
    };
    const root = resolveSessionScopeRoot({
      cfg: {} as never,
      sessionKey: "agent:main:subagent:child",
      agentId: "main",
    });
    expect(root).toMatchObject({
      rootSessionKey: "agent:main:root",
      agentId: "main",
    });
    expect(root?.entry.scopeDeviceId).toBe("device-a");
  });

  it("treats a fork as its own scope root", () => {
    SESSION_LINEAGE["agent:main:parent"] = {
      canonicalKey: "agent:main:parent",
      agentId: "main",
      entry: {
        sessionId: "parent-id",
        updatedAt: 1,
        scopeDeviceId: "device-a",
      } as SessionEntry,
    };
    SESSION_LINEAGE["agent:main:fork"] = {
      canonicalKey: "agent:main:fork",
      agentId: "main",
      entry: {
        sessionId: "fork-id",
        updatedAt: 1,
        forkSource: { sessionKey: "agent:main:parent" },
        parentSessionKey: "agent:main:parent",
        scopeDeviceId: "device-b",
      } as SessionEntry,
    };
    const root = resolveSessionScopeRoot({
      cfg: {} as never,
      sessionKey: "agent:main:fork",
      agentId: "main",
    });
    expect(root).toMatchObject({ rootSessionKey: "agent:main:fork" });
    expect(root?.entry.scopeDeviceId).toBe("device-b");
  });
});

describe("prepareDeviceScopeSwitch", () => {
  it("acquires the new device and defers releasing the previous lease", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-old",
      holder: "agent:main:root",
      leaseToken: "old-token",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const registry = fixtureRegistry(() => ({
      ok: true,
      payload: {
        ok: true,
        holder: holder(),
        leaseToken: "new-token",
        acquiredAtMs: 5,
      },
    }));
    const result = await prepareDeviceScopeSwitch({
      cfg: {} as never,
      registry,
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
      agentId: "main",
      deviceId: "device-a",
      getPairedDevice: async () => pairedDevice(),
      getNodeSession: () => nodeSession(),
      mintLeaseToken: () => "minted",
    });
    expect(result).toMatchObject({
      ok: true,
      previousLease: { deviceId: "device-old", leaseToken: "old-token" },
    });
    // The old grant is still mirrored: only the committed write releases it.
    expect(readSessionScopeLease("agent:main:root")).toMatchObject({
      deviceId: "device-a",
    });
  });

  it("does not touch the lease when the device is disabled", async () => {
    const registry = fixtureRegistry(() => ({ ok: true, payload: {} }));
    const result = await prepareDeviceScopeSwitch({
      cfg: {} as never,
      registry,
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
      deviceId: "device-a",
      getPairedDevice: async () => pairedDevice({ enabled: false }),
      getNodeSession: () => nodeSession(),
    });
    expect(result).toMatchObject({ ok: false, code: "DEVICE_DISABLED" });
    expect(registry.calls).toHaveLength(0);
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });

  it("returns the previous lease for a switch back to the gateway without releasing early", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "token-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const registry = fixtureRegistry(() => ({ ok: true, payload: {} }));
    const result = await prepareDeviceScopeSwitch({
      cfg: {} as never,
      registry,
      rootSessionKey: "agent:main:root",
      sessionId: "sess-1",
      deviceId: null,
    });
    expect(result).toMatchObject({
      ok: true,
      previousLease: { deviceId: "device-a", leaseToken: "token-1" },
    });
    expect(readSessionScopeLease("agent:main:root")).toMatchObject({
      leaseToken: "token-1",
    });
  });
});

describe("revokeDeviceScopeLeases", () => {
  it("force-clears occupancy as the operator invoke and drops every mirror for the device", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:other",
      deviceId: "device-a",
      holder: "agent:main:other",
      leaseToken: "lease-2",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const rest = fixtureRegistry(() => ({
      ok: true,
      payload: { ok: true, revoked: true },
    }));
    const result = await revokeDeviceScopeLeases({
      registry: rest,
      deviceId: "device-a",
    });
    expect(result.revoked).toBe(true);
    expect(result.clearedRootSessionKeys.toSorted()).toEqual([
      "agent:main:other",
      "agent:main:root",
    ]);
    // Operator force-clear path: no session identity on the envelope or params.
    expect(rest.calls[0]).toMatchObject({
      nodeId: "device-a",
      command: "occupancy.revoke.v1",
    });
    expect(rest.calls[0]).not.toHaveProperty("sessionKey");
    expect(rest.calls[0]).toMatchObject({ params: {} });
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
    expect(readSessionScopeLease("agent:main:other")).toBeUndefined();
  });

  it("still clears the mirrors when the node rejects the revoke", async () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const rest = fixtureRegistry(() => ({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "node not connected" },
    }));
    await expect(
      revokeDeviceScopeLeases({ registry: rest, deviceId: "device-a" }),
    ).resolves.toMatchObject({
      revoked: false,
      clearedRootSessionKeys: ["agent:main:root"],
    });
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });
});

describe("applyNodeOccupancyStatusForDevice", () => {
  it("clears the mirror when the node reports the device released", () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(
      applyNodeOccupancyStatusForDevice({
        deviceId: "device-a",
        occupied: false,
      }),
    ).toEqual(["agent:main:root"]);
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });

  it("never invents or clears a mirror from an occupied report", () => {
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(
      applyNodeOccupancyStatusForDevice({
        deviceId: "device-a",
        occupied: true,
      }),
    ).toEqual([]);
    expect(readSessionScopeLease("agent:main:root")).toMatchObject({
      leaseToken: "lease-1",
    });
  });
});

describe("buildSessionDeviceScopeSnapshot", () => {
  it("renders the gateway target plus the live device list", () => {
    const snapshot = buildSessionDeviceScopeSnapshot({
      connectedDevices: [
        { nodeId: "device-a", displayName: "Desk", platform: "darwin" },
        { nodeId: "device-b" },
      ],
    });
    expect(snapshot.target).toEqual({ kind: "gateway" });
    expect(snapshot.devices).toEqual([
      {
        deviceId: "device-a",
        displayName: "Desk",
        platform: "darwin",
        connected: true,
      },
      { deviceId: "device-b", connected: true },
    ]);
  });

  it("names the node target with its device facts", () => {
    const snapshot = buildSessionDeviceScopeSnapshot({
      scopeDeviceId: "device-a",
      scopeCwd: "/ws",
      connectedDevices: [{ nodeId: "device-a", displayName: "Desk", platform: "darwin" }],
    });
    expect(snapshot.target).toEqual({
      kind: "node",
      deviceId: "device-a",
      displayName: "Desk",
      platform: "darwin",
      cwd: "/ws",
    });
  });
});

describe("device lease audit facts", () => {
  const admissionToken = createExecutionIdentityAdmissionToken("run-1", {
    contextId: "context-1",
    executionId: "execution-1",
    now: 100,
  });

  function captureDecisionWork() {
    const work: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((item) => {
      work.push(item);
      return true;
    });
    return { clear, work };
  }

  it("queues an enforced acquire fact with bounded correlation for an admitted turn", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      const registry = fixtureRegistry(() => ({
        ok: true,
        payload: {
          ok: true,
          holder: holder(),
          leaseToken: "node-token",
          acquiredAtMs: 5,
        },
      }));
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:root",
          executionIdentityToken: admissionToken,
          receiptAuthority: () => true,
        },
        () =>
          acquireDeviceScopeLease({
            registry,
            deviceId: "device-a",
            rootSessionKey: "agent:main:root",
            sessionId: "sess-1",
            agentId: "main",
            permissionMode: "guarded",
            mintLeaseToken: () => "minted",
          }),
      );
      expect(result.ok).toBe(true);
      expect(work).toHaveLength(1);
      expect(work[0]?.token).toEqual(admissionToken);
      expect(work[0]?.receipt.action).toMatchObject({
        family: "device",
        operation: "device.lease.acquire",
      });
      expect(work[0]?.receipt.decision).toEqual({
        outcome: "allowed",
        reasonCode: "device_lease_acquired",
      });
      expect(work[0]?.receipt.enforcement).toMatchObject({
        coverageState: "enforced",
        policyRefs: ["session-permission-mode:guarded"],
      });
      expect(work[0]?.receipt.source).toMatchObject({
        owner: "device-scope",
        decisionBoundary: "session-device-scope.lease",
      });
      expect(work[0]?.refs).toEqual({
        resource: { namespace: "device", value: "device-a" },
        target: {
          namespace: "session",
          value: JSON.stringify(["main", "agent:main:root"]),
        },
      });
      // The node lease token is a receipt-id discriminator, never retained.
      expect(JSON.stringify(work)).not.toContain("node-token");
      expect(JSON.stringify(work)).not.toContain("minted");
    } finally {
      clear();
    }
  });

  it("queues a reject fact when the node reports the device occupied", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:root",
          executionIdentityToken: admissionToken,
        },
        () =>
          acquireDeviceScopeLease({
            registry: fixtureRegistry(() => ({
              ok: false,
              error: { code: "DEVICE_OCCUPIED", message: "occupied" },
            })),
            deviceId: "device-a",
            rootSessionKey: "agent:main:root",
            sessionId: "sess-1",
            mintLeaseToken: () => "minted",
          }),
      );
      expect(work).toHaveLength(1);
      expect(work[0]?.receipt.decision).toEqual({
        outcome: "denied",
        reasonCode: "device_lease_rejected_occupied",
      });
      expect(work[0]?.receipt.enforcement.coverageState).toBe("enforced");
      expect(work[0]?.receipt.remediation).toHaveLength(1);
    } finally {
      clear();
    }
  });

  it("queues reject facts for disabled, disconnected, and non-executor devices", async () => {
    const { clear, work } = captureDecisionWork();
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:root",
      executionIdentityToken: admissionToken,
    };
    try {
      for (const device of [pairedDevice({ enabled: false }), pairedDevice()]) {
        await withGatewayToolCallerIdentity(identity, () =>
          prepareDeviceScopeSwitch({
            cfg: {} as never,
            registry: fixtureRegistry(() => ({ ok: true, payload: {} })),
            rootSessionKey: "agent:main:root",
            sessionId: "sess-1",
            deviceId: "device-a",
            getPairedDevice: async () => device,
            getNodeSession: () => undefined,
          }),
        );
      }
      await withGatewayToolCallerIdentity(identity, () =>
        prepareDeviceScopeSwitch({
          cfg: {} as never,
          registry: fixtureRegistry(() => ({ ok: true, payload: {} })),
          rootSessionKey: "agent:main:root",
          sessionId: "sess-1",
          deviceId: "device-a",
          getPairedDevice: async () => pairedDevice(),
          getNodeSession: () => nodeSession({ commands: ["system.run"] }),
        }),
      );
      expect(work.map((item) => item.receipt.decision.reasonCode)).toEqual([
        "device_lease_rejected_disabled",
        "device_lease_rejected_disconnected",
        "device_lease_rejected_not_executor",
      ]);
    } finally {
      clear();
    }
  });

  it("queues one attribution-only release fact per dropped mirror with the boundary reason", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "token-1",
        expiresAt: Number.MAX_SAFE_INTEGER,
        admissionToken,
        permissionMode: "workspace",
      });
      await releaseDeviceScopeLease({
        registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
        rootSessionKey: "agent:main:root",
        releaseReason: "turn-end",
      });
      expect(work).toHaveLength(1);
      expect(work[0]?.receipt.decision).toEqual({
        outcome: "not-applicable",
        reasonCode: "device_lease_turn_end",
      });
      expect(work[0]?.receipt.enforcement).toMatchObject({
        coverageState: "attribution-only",
        policyRefs: ["session-permission-mode:workspace"],
      });
      // The release attributes to the acquiring execution via the mirror.
      expect(work[0]?.token).toEqual(admissionToken);
      // A second release of the same root has no mirror left and writes nothing.
      await releaseDeviceScopeLease({
        registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
        rootSessionKey: "agent:main:root",
        releaseReason: "stop",
      });
      expect(work).toHaveLength(1);
    } finally {
      clear();
    }
  });

  it("attributes revoke and delete releases to the mirrored acquiring execution", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "lease-1",
        expiresAt: Number.MAX_SAFE_INTEGER,
        admissionToken,
      });
      await revokeDeviceScopeLeases({
        registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
        deviceId: "device-a",
      });
      recordSessionScopeLease({
        rootSessionKey: "agent:main:other",
        deviceId: "device-b",
        holder: "agent:main:other",
        leaseToken: "lease-2",
        expiresAt: Number.MAX_SAFE_INTEGER,
        admissionToken,
      });
      expect(releaseRemovedDeviceScopeLeases({ deviceId: "device-b" })).toEqual({
        clearedRootSessionKeys: ["agent:main:other"],
      });
      expect(work.map((item) => item.receipt.decision.reasonCode)).toEqual([
        "device_lease_revoked",
        "device_lease_delete",
      ]);
      expect(work.every((item) => item.token === admissionToken)).toBe(true);
    } finally {
      clear();
    }
  });

  it("records a node-reported occupancy release and nothing for an occupied report", () => {
    const { clear, work } = captureDecisionWork();
    try {
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "lease-1",
        expiresAt: Number.MAX_SAFE_INTEGER,
        admissionToken,
      });
      applyNodeOccupancyStatusForDevice({
        deviceId: "device-a",
        occupied: false,
      });
      expect(work.map((item) => item.receipt.decision.reasonCode)).toEqual([
        "device_lease_released",
      ]);
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "lease-2",
        expiresAt: Number.MAX_SAFE_INTEGER,
        admissionToken,
      });
      applyNodeOccupancyStatusForDevice({
        deviceId: "device-a",
        occupied: true,
      });
      expect(work).toHaveLength(1);
    } finally {
      clear();
    }
  });

  it("writes no lease fact without an admitted execution", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      const registry = fixtureRegistry(() => ({
        ok: true,
        payload: {
          ok: true,
          holder: holder(),
          leaseToken: "node-token",
          acquiredAtMs: 5,
        },
      }));
      // No tool caller identity on the ambient context and no mirrored token.
      await acquireDeviceScopeLease({
        registry,
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        sessionId: "sess-1",
        mintLeaseToken: () => "minted",
      });
      await acquireDeviceScopeLease({
        registry: fixtureRegistry(() => ({
          ok: false,
          error: { code: "DEVICE_OCCUPIED", message: "occupied" },
        })),
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        sessionId: "sess-1",
        mintLeaseToken: () => "minted",
      });
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "token-1",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
      await releaseDeviceScopeLease({
        registry: fixtureRegistry(() => ({ ok: true, payload: { ok: true } })),
        rootSessionKey: "agent:main:root",
        releaseReason: "stop",
      });
      expect(work).toHaveLength(0);
    } finally {
      clear();
    }
  });

  it("suppresses the acquire fact when admitted authority is no longer active", async () => {
    const { clear, work } = captureDecisionWork();
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:root",
          executionIdentityToken: admissionToken,
          receiptAuthority: () => false,
        },
        () =>
          acquireDeviceScopeLease({
            registry: fixtureRegistry(() => ({
              ok: true,
              payload: {
                ok: true,
                holder: holder(),
                leaseToken: "node-token",
                acquiredAtMs: 5,
              },
            })),
            deviceId: "device-a",
            rootSessionKey: "agent:main:root",
            sessionId: "sess-1",
            mintLeaseToken: () => "minted",
          }),
      );
      expect(work).toHaveLength(0);
    } finally {
      clear();
    }
  });
});
