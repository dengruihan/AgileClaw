import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearAllSessionScopeLeasesForTest,
  readSessionScopeLease,
} from "../session-scope-lease.js";
import type { DeviceScopeRegistry } from "./session-device-scope.js";
import {
  beginSessionPatchDeviceScope,
  beginSessionPatchRequestDeviceScope,
  patchManyDeviceScopeError,
} from "./sessions-patch-device-scope.js";

// The root walk reads the store through the sharing owner; supply lineage directly.
const SESSION_LINEAGE: Record<
  string,
  { canonicalKey: string; agentId: string; entry: SessionEntry }
> = {};

vi.mock("../session-sharing.js", () => ({
  resolveSessionSharingTarget: (params: { sessionKey: string }) =>
    SESSION_LINEAGE[params.sessionKey] ?? null,
}));

function lineage(
  sessionKey: string,
  entry: Partial<SessionEntry> & { sessionId?: string } = {},
): void {
  SESSION_LINEAGE[sessionKey] = {
    canonicalKey: sessionKey,
    agentId: "main",
    entry: { sessionId: "sess-1", updatedAt: 1, ...entry } as SessionEntry,
  };
}

function registry(): DeviceScopeRegistry & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    invoke: async (params) => {
      calls.push(params as Record<string, unknown>);
      return {
        ok: true,
        payload: {
          ok: true,
          holder: {
            sessionKey: "agent:main:root",
            sessionId: "sess-1",
            runId: "run-1",
            acquiredAtMs: 1,
            detachedProcesses: 0,
          },
          leaseToken: "node-token",
        },
      } as never;
    },
    get: () => undefined,
  };
}

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
  for (const key of Object.keys(SESSION_LINEAGE)) {
    delete SESSION_LINEAGE[key];
  }
});

describe("beginSessionPatchDeviceScope", () => {
  it("authorizes before acquiring: an unauthorized patch never touches the device", async () => {
    lineage("agent:main:root");
    const rest = registry();
    await expect(
      beginSessionPatchDeviceScope({
        cfg: {} as never,
        registry: rest,
        requestedKey: "agent:main:root",
        requestedScopeDeviceId: "device-a",
        assertAuthorized: () => {
          throw new Error("not authorized");
        },
      }),
    ).rejects.toThrow(/not authorized/);
    expect(rest.calls).toHaveLength(0);
    expect(readSessionScopeLease("agent:main:root")).toBeUndefined();
  });

  it("rejects a subagent scope write: the tree root owns the device", async () => {
    lineage("agent:main:root");
    lineage("agent:main:subagent:child", {
      sessionId: "child-id",
      spawnedBy: "agent:main:root",
      parentSessionKey: "agent:main:root",
    });
    const result = await beginSessionPatchDeviceScope({
      cfg: {} as never,
      registry: registry(),
      requestedKey: "agent:main:subagent:child",
      requestedScopeDeviceId: "device-a",
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.details).toMatchObject({ code: "DEVICE_SCOPE_NOT_ROOT" });
    }
  });

  it("rejects a blank device id without acquiring", async () => {
    lineage("agent:main:root");
    const rest = registry();
    const result = await beginSessionPatchDeviceScope({
      cfg: {} as never,
      registry: rest,
      requestedKey: "agent:main:root",
      requestedScopeDeviceId: "   ",
    });
    expect(result).toMatchObject({ ok: false });
    expect(rest.calls).toHaveLength(0);
  });
});

describe("beginSessionPatchRequestDeviceScope", () => {
  it("rejects scope writes in a multi-target patch", async () => {
    const result = await beginSessionPatchRequestDeviceScope({
      request: { many: true, params: { targets: [], patch: { scopeDeviceId: "device-a" } } },
      context: { getRuntimeConfig: () => ({}), nodeRegistry: registry() } as never,
    });
    expect(result).toMatchObject({ ok: false, error: patchManyDeviceScopeError() });
  });

  it("ignores patches without a scope field", async () => {
    await expect(
      beginSessionPatchRequestDeviceScope({
        request: { many: false, params: { key: "agent:main:root", label: "x" } },
        context: { getRuntimeConfig: () => ({}), nodeRegistry: registry() } as never,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("patch applier ownership", () => {
  it("never writes scopeDeviceId itself: the device-scope owner is the only writer", async () => {
    const { prepareSessionsPatchEntry } = await import("../sessions-patch.js");
    const preparation = prepareSessionsPatchEntry({
      cfg: {} as never,
      storeKey: "agent:main:root",
      agentId: "main",
      isLabelInUse: () => false,
      patch: { scopeDeviceId: "device-a" } as never,
    });
    expect(preparation.kind).toBe("complete");
    if (preparation.kind !== "complete" || !preparation.result.ok) {
      throw new Error("expected a complete patch projection");
    }
    // Evidence for P2-2: the generic applier copies a fixed field set, so the
    // scope write stays single-owned instead of being written twice.
    expect(preparation.result.entry).not.toHaveProperty("scopeDeviceId");
  });
});
