import { afterEach, describe, expect, test } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  clearAllSessionScopeLeasesForTest,
  recordSessionScopeLease,
  sessionScopeLeaseHeld,
} from "../session-scope-lease.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import type { GatewayClient } from "./types.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
});

const client: GatewayClient = {
  connId: "conn-scope-release",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  },
} as GatewayClient;

function recordLease(rootSessionKey: string): void {
  recordSessionScopeLease({
    rootSessionKey,
    deviceId: "device-a",
    holder: "conn-device",
    leaseToken: `token-${rootSessionKey}`,
    expiresAt: Number.MAX_SAFE_INTEGER,
    agentId: "main",
  });
}

describe("session scope release on delete and archive", () => {
  test("sessions.delete drops the deleted row's mirrored device lease", async () => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:scoped-delete";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("session-scoped-delete", { scopeDeviceId: "device-a" }),
      },
      storePath,
    });
    recordLease(sessionKey);

    const deleted = await directSessionReq("sessions.delete", { key: sessionKey }, { client });

    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    expect(sessionScopeLeaseHeld(sessionKey)).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  });

  test("archiving through sessions.patch drops the row's mirrored device lease", async () => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:scoped-archive";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("session-scoped-archive", { scopeDeviceId: "device-a" }),
      },
      storePath,
    });
    recordLease(sessionKey);

    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: "session-scoped-archive" },
      { client },
    );

    expect(archived.ok, JSON.stringify(archived)).toBe(true);
    expect(sessionScopeLeaseHeld(sessionKey)).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.archivedAt).toEqual(
      expect.any(Number),
    );
  });

  test("archiving a gateway-scoped session leaves another tree's lease untouched", async () => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:gateway-archive";
    const otherRoot = "agent:main:dashboard:scoped-other";
    await writeSessionStore({
      entries: { [sessionKey]: sessionStoreEntry("session-gateway-archive") },
      storePath,
    });
    recordLease(otherRoot);

    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true, expectedSessionId: "session-gateway-archive" },
      { client },
    );

    expect(archived.ok, JSON.stringify(archived)).toBe(true);
    expect(sessionScopeLeaseHeld(otherRoot)).toBe(true);
  });
});
