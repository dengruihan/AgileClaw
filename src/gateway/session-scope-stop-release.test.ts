import { afterEach, expect, it } from "vitest";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { SessionEntry } from "../config/sessions.js";
import type { DeviceScopeRegistry } from "./server-methods/session-device-scope.js";
import {
  clearAllSessionScopeLeasesForTest,
  recordSessionScopeLease,
  sessionScopeLeaseHeld,
} from "./session-scope-lease.js";
import { releaseScopeLeaseOnStop } from "./session-scope-stop-release.js";

function entry(scopeDeviceId?: string): SessionEntry {
  return {
    sessionId: "sess-1",
    updatedAt: 1,
    ...(scopeDeviceId ? { scopeDeviceId } : {}),
  } as SessionEntry;
}

function fakeRegistry(
  handler: (params: Record<string, unknown>) => {
    ok: boolean;
    error?: unknown;
  },
): DeviceScopeRegistry & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    invoke: async (params) => {
      calls.push(params as Record<string, unknown>);
      return handler(params as Record<string, unknown>) as never;
    },
  };
}

function seedLease(): void {
  recordSessionScopeLease({
    rootSessionKey: "agent:main:root",
    deviceId: "device-a",
    holder: "agent:main:root",
    leaseToken: "lease-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
}

function contextFor(registry: DeviceScopeRegistry) {
  return { getRuntimeConfig: () => ({}) as never, nodeRegistry: registry };
}

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
});

it("releases the node lease with the mirrored holder token and clears the mirror", async () => {
  seedLease();
  const fake = fakeRegistry(() => ({ ok: true }));
  await expect(
    releaseScopeLeaseOnStop(
      contextFor(fake),
      entry("device-a"),
      "agent:main:root",
      "agent:main:root",
      "main",
    ),
  ).resolves.toBe(true);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({
    nodeId: "device-a",
    command: "occupancy.release.v1",
    sessionKey: "agent:main:root",
    params: { sessionKey: "agent:main:root", leaseToken: "lease-1" },
  });
  expect(sessionScopeLeaseHeld("agent:main:root")).toBe(false);
});

it("drops the mirror when the node is disconnected and records the failure", async () => {
  seedLease();
  // A disconnected node clears its own occupancy; stop must not keep a mirror
  // the session no longer holds, and the invoke failure is only a warning.
  const fake = fakeRegistry(() => ({
    ok: false,
    error: { code: "NOT_CONNECTED", message: "node not connected" },
  }));
  await expect(
    releaseScopeLeaseOnStop(
      contextFor(fake),
      entry("device-a"),
      "agent:main:root",
      "agent:main:root",
      "main",
    ),
  ).resolves.toBe(true);
  expect(fake.calls).toHaveLength(1);
  expect(sessionScopeLeaseHeld("agent:main:root")).toBe(false);
});

it("does nothing for a gateway-scoped session", async () => {
  const fake = fakeRegistry(() => ({ ok: true }));
  await expect(
    releaseScopeLeaseOnStop(
      contextFor(fake),
      entry(),
      "agent:main:root",
      "agent:main:root",
      "main",
    ),
  ).resolves.toBe(false);
  expect(fake.calls).toHaveLength(0);
});

it("attributes the stop release to the acquiring execution with the stop reason", async () => {
  const admissionToken = createExecutionIdentityAdmissionToken("run-stop", {
    contextId: "context-stop",
    executionId: "execution-stop",
    now: 5,
  });
  recordSessionScopeLease({
    rootSessionKey: "agent:main:root",
    deviceId: "device-a",
    holder: "agent:main:root",
    leaseToken: "lease-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    admissionToken,
  });
  const work: ExecutionDecisionWork[] = [];
  const clear = configureExecutionDecisionWorkSink((item) => {
    work.push(item);
    return true;
  });
  try {
    const fake = fakeRegistry(() => ({ ok: true }));
    await expect(
      releaseScopeLeaseOnStop(
        contextFor(fake),
        entry("device-a"),
        "agent:main:root",
        "agent:main:root",
        "main",
      ),
    ).resolves.toBe(true);
  } finally {
    clear();
  }
  expect(work).toHaveLength(1);
  expect(work[0]?.receipt.decision.reasonCode).toBe("device_lease_stop");
  expect(work[0]?.receipt.action.operation).toBe("device.lease.release");
  expect(work[0]?.token).toEqual(admissionToken);
});
