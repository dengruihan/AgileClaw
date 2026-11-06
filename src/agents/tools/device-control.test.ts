import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAgentToolExecutionLocation } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import type { ComputerContextEpoch } from "./computer-tool-shared.js";

const gatewayContext = vi.fn();
const nodeGet = vi.fn();
const callGatewayTool = vi.fn();

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  acquireDeviceScopeLease: vi.fn(),
  resolveSessionScopeRoot: vi.fn(),
}));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
  readGatewayCallOptions: () => ({}),
}));

const {
  deviceControlAdapter,
  readBrowserDeviceControlScope,
  runDeviceBrowserControl,
  runDeviceComputerControl,
  withBrowserDeviceControlScope,
} = await import("./device-control.js");
const { createDeviceScopeRoutingState } = await import("./device-routing.js");

function sourceTool(
  name: string,
  execute: AnyAgentTool["execute"] = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: {},
  })),
): AnyAgentTool {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    executionMode: "sequential",
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind: "placement" });
  return tool;
}

function computerCapableDevice(deviceId = "device-a") {
  return {
    nodeId: deviceId,
    platform: "linux",
    commands: ["computer.act", "screen.snapshot", "browser.proxy"],
    client: {},
  };
}

const screenshotPayload = {
  format: "jpeg",
  // Minimal valid 1x1 JPEG; the projection reads real image headers.
  base64:
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  displayFrameId: "display-frame-1",
  width: 1280,
  height: 800,
};

function nodeInvokeCalls(command: string) {
  return callGatewayTool.mock.calls.filter(
    (call) => (call[2] as { command?: string })?.command === command,
  );
}

afterEach(() => {
  gatewayContext.mockReset();
  nodeGet.mockReset();
  callGatewayTool.mockReset();
});

describe("device control scope context", () => {
  it("exposes the scope only inside the routed call", () => {
    expect(readBrowserDeviceControlScope()).toBeUndefined();
    const scope = withBrowserDeviceControlScope(
      { deviceId: "device-a", rootSessionKey: "agent:main:root", leaseToken: "lease-1" },
      () => readBrowserDeviceControlScope(),
    );
    expect(scope).toMatchObject({ deviceId: "device-a", leaseToken: "lease-1" });
    expect(readBrowserDeviceControlScope()).toBeUndefined();
  });
});

describe("runDeviceBrowserControl", () => {
  it("delegates to the plugin tool pinned to the scoped device inside the call context", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const browser = sourceTool("browser", execute);
    await runDeviceBrowserControl({
      source: browser,
      toolCallId: "call-1",
      params: { action: "snapshot", target: "host", node: "other-node" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
    });
    expect(execute).toHaveBeenCalledWith(
      "call-1",
      { action: "snapshot", target: "node", node: "device-a" },
      undefined,
    );
  });

  it("keeps the lease token out of the delegated model-visible params", async () => {
    const seen: unknown[] = [];
    const execute = vi.fn(async (_id: string, params: unknown) => {
      seen.push(params, readBrowserDeviceControlScope());
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    });
    await runDeviceBrowserControl({
      source: sourceTool("browser", execute as AnyAgentTool["execute"]),
      toolCallId: "call-1",
      params: { action: "navigate", url: "https://example.test" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
    });
    expect(JSON.stringify(seen[0])).not.toContain("lease-1");
    expect(seen[1]).toMatchObject({ leaseToken: "lease-1", deviceId: "device-a" });
  });
});

describe("runDeviceComputerControl", () => {
  it("routes a screenshot over screen.snapshot with envelope identity and a params-only token", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const state = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
    });
    const result = (await runDeviceComputerControl({
      toolCallId: "call-1",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      state,
    })) as { content: Array<{ type: string }> };
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    const [invoke] = nodeInvokeCalls("screen.snapshot");
    expect(invoke).toBeDefined();
    // The command params are a closed schema: only the admission token rides
    // inside them, and the session identity stays on the envelope.
    expect(invoke?.[2]).toMatchObject({
      nodeId: "device-a",
      sessionKey: "agent:main:root",
      params: { leaseToken: "lease-1" },
    });
    expect((invoke![2] as { params: Record<string, unknown> }).params.sessionKey).toBeUndefined();
  });

  it("drops per-call host selectors instead of failing the call", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const state = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
    });
    const result = (await runDeviceComputerControl({
      toolCallId: "call-1",
      params: { action: "screenshot", target: "gateway", node: "device-b", environmentId: "env" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      state,
    })) as { content: Array<{ type: string }> };
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    const [invoke] = nodeInvokeCalls("screen.snapshot");
    expect(invoke?.[2]).toMatchObject({ nodeId: "device-a" });
  });

  it("keeps one session per device and rebuilds after a mid-run use_device switch", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockImplementation((deviceId: string) => computerCapableDevice(deviceId));
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const state = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
    });
    await runDeviceComputerControl({
      toolCallId: "call-a",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-a",
      state,
    });
    await runDeviceComputerControl({
      toolCallId: "call-b",
      params: { action: "screenshot" },
      deviceId: "device-b",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-b",
      state,
    });
    const snapshotInvokes = nodeInvokeCalls("screen.snapshot");
    expect(snapshotInvokes.map((call) => (call[2] as { nodeId: string }).nodeId)).toEqual([
      "device-a",
      "device-b",
    ]);
    expect((snapshotInvokes[1]![2] as { params: unknown }).params).toMatchObject({
      leaseToken: "lease-b",
    });
  });

  it("closes the device execution at turn end so the next session is not busy", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const firstTurn = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
    });
    await runDeviceComputerControl({
      toolCallId: "call-1",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      state: firstTurn,
    });
    await firstTurn.closeDeviceControlSessions();
    const closeInvoke = nodeInvokeCalls("computer.act").find((call) =>
      (call[2] as { params?: { action?: string } }).params?.action?.startsWith("__close"),
    );
    expect(closeInvoke).toBeDefined();
    // The close must admit under the same lease identity while it is held.
    expect(closeInvoke?.[2]).toMatchObject({
      nodeId: "device-a",
      sessionKey: "agent:main:root",
      params: expect.objectContaining({ leaseToken: "lease-1" }),
    });

    // The next turn's session opens its own execution without host-busy.
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const secondTurn = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
    });
    const result = (await runDeviceComputerControl({
      toolCallId: "call-2",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-2",
      state: secondTurn,
    })) as { content: Array<{ type: string }> };
    expect(result.content.some((block) => block.type === "image")).toBe(true);
  });

  it("suppresses unchanged screenshots through the shared context epoch", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const contextEpoch: ComputerContextEpoch = { value: 1 };
    const state = createDeviceScopeRoutingState({
      sessionKey: "agent:main:root",
      agentId: "main",
      sessionId: "sess-1",
      computerContextEpoch: contextEpoch,
    });
    // Exercise the adapter the routing layer uses, so the epoch flows the way
    // assembly wires it.
    const routed = deviceControlAdapter("computer", state);
    expect(routed).toBeDefined();
    const call = (toolCallId: string) =>
      routed!({
        toolCallId,
        params: { action: "screenshot" },
        source: sourceTool("computer"),
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        leaseToken: "lease-1",
        agentId: "main",
      });
    const first = (await call("call-1")) as { content: Array<{ type: string }> };
    expect(first.content.some((block) => block.type === "image")).toBe(true);
    expect(contextEpoch.frameImageIdentity).toBeDefined();
    const second = (await call("call-2")) as { content: Array<{ type: string; text?: string }> };
    const unchanged = second.content.find((block) => block.text?.includes("unchanged"));
    expect(unchanged?.text).toContain("screen unchanged since previous frame");
    // The duplicate capture never re-enters model context as a new image.
    expect(second.content.some((block) => block.type === "image")).toBe(false);
  });

  it("fails per call when the scoped device is not connected", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(undefined);
    await expect(
      runDeviceComputerControl({
        toolCallId: "call-1",
        params: { action: "screenshot" },
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        leaseToken: "lease-1",
        state: createDeviceScopeRoutingState({
          sessionKey: "agent:main:root",
          agentId: "main",
        }),
      }),
    ).rejects.toThrow(/device-a is not connected.*no gateway fallback/is);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails per call when the scoped device lacks the computer commands", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a", commands: ["browser.proxy"], client: {} });
    await expect(
      runDeviceComputerControl({
        toolCallId: "call-1",
        params: { action: "screenshot" },
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        leaseToken: "lease-1",
        state: createDeviceScopeRoutingState({
          sessionKey: "agent:main:root",
          agentId: "main",
        }),
      }),
    ).rejects.toThrow(/missing computer\.act, screen\.snapshot/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("propagates a Gateway device rejection without fallback", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockRejectedValueOnce(
      new Error("paired device device-a is disabled; enable it with node.device.enable"),
    );
    await expect(
      runDeviceComputerControl({
        toolCallId: "call-1",
        params: { action: "screenshot" },
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        leaseToken: "lease-1",
        state: createDeviceScopeRoutingState({
          sessionKey: "agent:main:root",
          agentId: "main",
        }),
      }),
    ).rejects.toThrow(/device-a is disabled/);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });
});
