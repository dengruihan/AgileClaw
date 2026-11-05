import { afterEach, expect, it } from "vitest";
import {
  clearAllSessionScopeLeasesForTest,
  clearSessionScopeLeasesForDevice,
  readSessionScopeLease,
  recordSessionScopeLease,
  releaseSessionScopeLease,
  sessionScopeLeaseHeld,
} from "./session-scope-lease.js";

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
});

it("mirrors the latest node-reported lease per root and replaces prior grants", () => {
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    agentId: "main",
  });
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(true);
  expect(readSessionScopeLease("agent:main:scoped")).toMatchObject({
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
  });

  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-2",
    leaseToken: "token-2",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  expect(readSessionScopeLease("agent:main:scoped")).toMatchObject({
    holder: "conn-2",
    leaseToken: "token-2",
  });
});

it("refuses to release a replaced lease through a stale token", () => {
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-2",
    leaseToken: "token-2",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  expect(releaseSessionScopeLease("agent:main:scoped", { leaseToken: "token-1" })).toBeUndefined();
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(true);
  expect(releaseSessionScopeLease("agent:main:scoped", { leaseToken: "token-2" })).toMatchObject({
    leaseToken: "token-2",
  });
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(false);
});

it("drops the mirror when the holder connection disconnects or the device releases", () => {
  const connection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: connection.signal,
  });
  recordSessionScopeLease({
    rootSessionKey: "agent:main:other",
    deviceId: "device-b",
    holder: "conn-1",
    leaseToken: "token-1b",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: connection.signal,
  });
  connection.abort("disconnect");
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(false);
  expect(sessionScopeLeaseHeld("agent:main:other")).toBe(false);

  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-3",
    leaseToken: "token-3",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  expect(clearSessionScopeLeasesForDevice("device-a")).toEqual(["agent:main:scoped"]);
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(false);
});

it("treats a locally expired mirror as absent without deciding node occupancy", () => {
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: 1,
  });
  expect(readSessionScopeLease("agent:main:scoped", 2)).toBeUndefined();
  expect(sessionScopeLeaseHeld("agent:main:scoped", 2)).toBe(false);
});

it("never lets a replaced holder's connection clear the newer lease mirror", () => {
  const previousConnection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: previousConnection.signal,
  });
  const currentConnection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-2",
    leaseToken: "token-2",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: currentConnection.signal,
  });

  previousConnection.abort("disconnect");
  expect(readSessionScopeLease("agent:main:scoped")).toMatchObject({
    holder: "conn-2",
    leaseToken: "token-2",
  });

  currentConnection.abort("disconnect");
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(false);
});

it("detaches a previous holder watch when the replacement reports no connection", () => {
  const previousConnection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: previousConnection.signal,
  });
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "node-transport",
    leaseToken: "token-2",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });

  previousConnection.abort("disconnect");
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(true);
});

it("cleans holder watches on release and device-cleared mirrors", () => {
  const previousConnection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-1",
    leaseToken: "token-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: previousConnection.signal,
  });
  expect(releaseSessionScopeLease("agent:main:scoped")).toMatchObject({ leaseToken: "token-1" });

  // A released key can be re-recorded under another connection without the old
  // abort reaching it; the old watch was dropped with the release.
  const currentConnection = new AbortController();
  recordSessionScopeLease({
    rootSessionKey: "agent:main:scoped",
    deviceId: "device-a",
    holder: "conn-2",
    leaseToken: "token-2",
    expiresAt: Number.MAX_SAFE_INTEGER,
    connectionSignal: currentConnection.signal,
  });
  previousConnection.abort("disconnect");
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(true);

  expect(clearSessionScopeLeasesForDevice("device-a")).toEqual(["agent:main:scoped"]);
  // The cleared holder's later disconnect is a no-op, not a second clear.
  currentConnection.abort("disconnect");
  expect(sessionScopeLeaseHeld("agent:main:scoped")).toBe(false);
});
