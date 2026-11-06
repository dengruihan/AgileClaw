import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAgentToolExecutionLocation } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";

const gatewayContext = vi.fn();
const nodeGet = vi.fn();
const callGatewayTool = vi.fn();

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
  readGatewayCallOptions: () => ({}),
}));

const {
  readBrowserDeviceControlScope,
  runDeviceBrowserControl,
  runDeviceComputerControl,
  withBrowserDeviceControlScope,
} = await import("./device-control.js");

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

function computerCapableDevice() {
  return {
    nodeId: "device-a",
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
  it("routes a screenshot over screen.snapshot with the root session identity and lease token", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValue({ payload: screenshotPayload });
    const result = (await runDeviceComputerControl({
      toolCallId: "call-1",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      cacheKey: {},
    })) as { content: Array<{ type: string }> };
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId: "device-a",
        command: "screen.snapshot",
        sessionKey: "agent:main:root",
        params: expect.objectContaining({
          sessionKey: "agent:main:root",
          leaseToken: "lease-1",
        }),
      }),
      undefined,
    );
  });

  it("keeps one routed computer session per routing state and routes input over computer.act", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    callGatewayTool.mockResolvedValueOnce({ payload: screenshotPayload });
    const cacheKey = {};
    const first = (await runDeviceComputerControl({
      toolCallId: "call-shot",
      params: { action: "screenshot" },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      cacheKey,
    })) as { details?: { frameId?: string } };
    const frameId = first.details?.frameId;
    expect(frameId).toMatch(/^[0-9a-f-]{36}$/);

    callGatewayTool.mockResolvedValueOnce({ payload: { ok: true } });
    await runDeviceComputerControl({
      toolCallId: "call-click",
      params: { action: "left_click", coordinate: [10, 20], frameId },
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      cacheKey,
    });
    const actCall = callGatewayTool.mock.calls.find(
      (call) => (call[2] as { command?: string })?.command === "computer.act",
    );
    expect(actCall).toBeDefined();
    expect(actCall?.[2]).toMatchObject({
      nodeId: "device-a",
      command: "computer.act",
      sessionKey: "agent:main:root",
      params: expect.objectContaining({
        action: "left_click",
        sessionKey: "agent:main:root",
        leaseToken: "lease-1",
      }),
    });
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
        cacheKey: {},
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
        cacheKey: {},
      }),
    ).rejects.toThrow(/missing computer\.act, screen\.snapshot/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("refuses a per-call node selector that targets another device", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(computerCapableDevice());
    await expect(
      runDeviceComputerControl({
        toolCallId: "call-1",
        params: { action: "screenshot", node: "device-b" },
        deviceId: "device-a",
        rootSessionKey: "agent:main:root",
        leaseToken: "lease-1",
        cacheKey: {},
      }),
    ).rejects.toThrow(/bound to device device-a/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});
