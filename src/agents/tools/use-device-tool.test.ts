import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllSessionScopeLeasesForTest,
  recordSessionScopeLease,
} from "../../gateway/session-scope-lease.js";
import type { DeviceScopeRoutingState } from "./device-routing.js";

const callGatewayTool = vi.fn();
const listNodes = vi.fn();
const resolveNodeIdFromList = vi.fn();
const resolveSessionScopeRoot = vi.fn();

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
  readGatewayCallOptions: () => ({}),
}));
vi.mock("./nodes-utils.js", () => ({
  listNodes: (...args: unknown[]) => listNodes(...args),
  resolveNodeIdFromList: (...args: unknown[]) => resolveNodeIdFromList(...args),
}));
vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  resolveSessionScopeRoot: (...args: unknown[]) => resolveSessionScopeRoot(...args),
}));

const { createUseDeviceTool, USE_DEVICE_TOOL_NAME } = await import("./use-device-tool.js");

function makeState(overrides: Partial<DeviceScopeRoutingState> = {}): {
  state: DeviceScopeRoutingState;
  markScope: ReturnType<typeof vi.fn>;
} {
  const markScope = vi.fn();
  return {
    state: {
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
      runId: "run-1",
      switchPending: false,
      markScope: () => markScope(),
      resolveRoot: () => ({ rootSessionKey: "agent:main:root", agentId: "main" }),
      ...overrides,
    },
    markScope,
  };
}

function toolFor(state: DeviceScopeRoutingState) {
  return createUseDeviceTool({
    state,
    sessionKey: state.sessionKey,
    agentId: state.agentId,
    cfg: {} as never,
  });
}

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
  callGatewayTool.mockReset();
  listNodes.mockReset();
  resolveNodeIdFromList.mockReset();
  resolveSessionScopeRoot.mockReset();
});

describe("use_device", () => {
  it("is a gateway tool with the stable catalog name", () => {
    const tool = toolFor(makeState().state);
    expect(tool.name).toBe(USE_DEVICE_TOOL_NAME);
    expect(tool.executionMode).toBe("sequential");
  });

  it("writes the device scope through the session patch owner and reports the lease", async () => {
    const { state, markScope } = makeState();
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    listNodes.mockResolvedValue([
      { nodeId: "device-a", displayName: "Desk Mac", platform: "darwin", connected: true },
    ]);
    resolveNodeIdFromList.mockReturnValue("device-a");
    callGatewayTool.mockImplementation(async () => {
      // The routing guard must see an in-flight switch while the patch runs.
      expect(state.switchPending).toBe(true);
      recordSessionScopeLease({
        rootSessionKey: "agent:main:root",
        deviceId: "device-a",
        holder: "agent:main:root",
        leaseToken: "lease-1",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
      return { ok: true, key: "agent:main:root", entry: { scopeDeviceId: "device-a" } };
    });
    const result = await toolFor(state).execute("call-1", { device: "Desk Mac" });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "sessions.patch",
      {},
      { key: "agent:main:root", scopeDeviceId: "device-a" },
      undefined,
    );
    expect(state.switchPending).toBe(false);
    expect(markScope).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      scope: "device",
      deviceId: "device-a",
      displayName: "Desk Mac",
      leaseHeld: true,
      previousScopeDeviceId: null,
    });
  });

  it("returns the session to the gateway with a null scope write", async () => {
    const { state } = makeState();
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    callGatewayTool.mockResolvedValue({ ok: true, entry: {} });
    const result = await toolFor(state).execute("call-1", { device: "gateway" });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "sessions.patch",
      {},
      { key: "agent:main:root", scopeDeviceId: null },
      undefined,
    );
    expect(result.details).toMatchObject({
      scope: "gateway",
      deviceId: null,
      leaseHeld: false,
      previousScopeDeviceId: "device-a",
    });
  });

  it("surfaces DEVICE_OCCUPIED with the holder identity and keeps the previous scope", async () => {
    const { state, markScope } = makeState();
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-old" },
    });
    listNodes.mockResolvedValue([{ nodeId: "device-a", connected: true }]);
    resolveNodeIdFromList.mockReturnValue("device-a");
    callGatewayTool.mockRejectedValue(
      Object.assign(new Error("device-a is occupied: device occupied by session agent:other"), {
        details: { code: "DEVICE_OCCUPIED" },
      }),
    );
    await expect(toolFor(state).execute("call-1", { device: "device-a" })).rejects.toThrow(
      /DEVICE_OCCUPIED: .*agent:other.*previous scope \(device-old\)/,
    );
    expect(state.switchPending).toBe(false);
    expect(markScope).not.toHaveBeenCalled();
  });

  it("rejects a switch from a subagent: scope belongs to the root session", async () => {
    const { state } = makeState({ sessionKey: "agent:main:subagent:child" });
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    await expect(toolFor(state).execute("call-1", { device: "device-a" })).rejects.toThrow(
      /call use_device from that root session/,
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("requires a device target", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    await expect(toolFor(makeState().state).execute("call-1", { device: "  " })).rejects.toThrow(
      /requires a device id/,
    );
  });
});
