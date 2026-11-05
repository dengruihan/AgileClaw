import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAllSessionScopeLeasesForTest,
  recordSessionScopeLease,
} from "../../gateway/session-scope-lease.js";
import {
  bindAgentToolExecutionLocation,
  getAgentToolExecutionLocation,
} from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { textResult } from "./tool-results.js";

const acquireDeviceScopeLease = vi.fn();
const resolveSessionScopeRoot = vi.fn();
const gatewayContext = vi.fn();
const nodeGet = vi.fn();
const callGatewayTool = vi.fn();

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  acquireDeviceScopeLease: (...args: unknown[]) => acquireDeviceScopeLease(...args),
  resolveSessionScopeRoot: (...args: unknown[]) => resolveSessionScopeRoot(...args),
}));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));

const { applyDeviceScopeToolRouting, createDeviceScopeRoutingState } =
  await import("./device-routing.js");

function placementTool(name: string, execute = vi.fn(async () => textResult("local", {}))) {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind: "placement" });
  return { tool, execute };
}

function gatewayTool(name: string, execute = vi.fn(async () => textResult("gateway", {}))) {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind: "gateway" });
  return { tool, execute };
}

function routingState() {
  return createDeviceScopeRoutingState({
    sessionKey: "agent:main:root",
    agentId: "main",
    sessionId: "sess-1",
    runId: "run-1",
  });
}

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
  acquireDeviceScopeLease.mockReset();
  resolveSessionScopeRoot.mockReset();
  gatewayContext.mockReset();
  nodeGet.mockReset();
  callGatewayTool.mockReset();
});

describe("applyDeviceScopeToolRouting", () => {
  it("keeps the tool catalog constant and leaves gateway tools untouched", () => {
    const exec = placementTool("exec");
    const useDevice = gatewayTool("use_device");
    const routed = applyDeviceScopeToolRouting([exec.tool, useDevice.tool], routingState());
    expect(routed.map((tool) => tool.name)).toEqual(["exec", "use_device"]);
    // Gateway tools keep their exact execute identity: they always run on A.
    expect(routed[1]).toBe(useDevice.tool);
    expect(routed[0]).not.toBe(exec.tool);
    expect(getAgentToolExecutionLocation(routed[0]!).kind).toBe("placement");
  });

  it("runs the original placement tool on the Gateway when scope is gateway", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledWith("call-1", { command: "uname" }, undefined, undefined);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("routes exec to the scoped device with the mirrored lease token", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a", platform: "linux" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    callGatewayTool.mockResolvedValue({ payload: { success: true, exitCode: 0, stdout: "ok" } });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    const result = await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).not.toHaveBeenCalled();
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
      expect.objectContaining({
        nodeId: "device-a",
        command: "system.run",
        sessionKey: "agent:main:root",
        params: expect.objectContaining({
          rawCommand: "uname",
          sessionKey: "agent:main:root",
          leaseToken: "lease-1",
        }),
      }),
      undefined,
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("acquires a lease when no mirror exists and surfaces DEVICE_OCCUPIED without gateway fallback", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    acquireDeviceScopeLease.mockResolvedValue({
      ok: false,
      code: "DEVICE_OCCUPIED",
      message: "device-a is occupied: device occupied by session agent:other",
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(/agent:other/);
    expect(exec.execute).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails an unsupported control tool per call instead of running it on A", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const browser = placementTool("browser");
    const [routed] = applyDeviceScopeToolRouting([browser.tool], routingState());
    await expect(routed!.execute("call-1", { action: "snapshot" })).rejects.toThrow(
      /no device-routed transport/,
    );
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("fails an unknown placement tool per call with a clear reason", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const unknown = placementTool("mystery_tool");
    const [routed] = applyDeviceScopeToolRouting([unknown.tool], routingState());
    await expect(routed!.execute("call-1", {})).rejects.toThrow(/no device-routed adapter/);
    expect(unknown.execute).not.toHaveBeenCalled();
  });

  it("refuses the process tool under device scope with a foreground explanation", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    const process = placementTool("process");
    const [routed] = applyDeviceScopeToolRouting([process.tool], routingState());
    await expect(routed!.execute("call-1", { action: "list" })).rejects.toThrow(/foreground/);
    expect(process.execute).not.toHaveBeenCalled();
  });

  it("applies a committed switch to the next placement call", async () => {
    // First call observes gateway scope; after markScope() the state re-reads
    // the entry and the very next call routes to the device.
    resolveSessionScopeRoot
      .mockReturnValueOnce({
        rootSessionKey: "agent:main:root",
        agentId: "main",
        entry: { sessionId: "sess-1" },
      })
      .mockReturnValue({
        rootSessionKey: "agent:main:root",
        agentId: "main",
        entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
      });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    callGatewayTool.mockResolvedValue({ payload: { success: true, exitCode: 0, stdout: "ok" } });
    const state = routingState();
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], state);
    await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).not.toHaveBeenCalled();

    state.markScope();
    await routed!.execute("call-2", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("refuses placement calls while a use_device switch is in flight", async () => {
    const state = routingState();
    state.switchPending = true;
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], state);
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(
      /only placement-affecting call in its step/,
    );
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("refuses device execution when the agent runs outside the Gateway process", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue(undefined);
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(
      /Gateway-hosted session/,
    );
    expect(exec.execute).not.toHaveBeenCalled();
  });
});
