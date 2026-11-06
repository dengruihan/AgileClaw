import "./browser-tool.test-support.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../plugin-registration.js";
import { createBrowserTool } from "./browser-tool.js";
const {
  browserClientMocks: client,
  browserHostAvailabilityMocks: host,
  configMocks: config,
  gatewayMocks: gateway,
  nodesUtilsMocks: nodes,
  resetBrowserToolMocks,
  deviceScopeMocks,
} = await import("./browser-tool.test-support.js");

vi.mock("../register.runtime.js", () => ({
  createBrowserTool,
  hasBrowserNodeHostWork: () => false,
}));

beforeEach(resetBrowserToolMocks);

function registeredTool(context: OpenClawPluginToolContext) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  registerBrowserPlugin(
    createTestPluginApi({
      registerTool,
      runtime: {
        state: { openKeyedStore: () => ({ register: vi.fn(), entries: vi.fn() }) },
      } as unknown as OpenClawPluginApi["runtime"],
    }),
  );
  const factory = registerTool.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("expected registered browser factory");
  }
  const tool = factory(context);
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected one registered browser tool");
  }
  return tool;
}

type Policy = NonNullable<NonNullable<OpenClawConfig["gateway"]>["nodes"]>["browser"];
const pin = { mode: "manual", node: "node-1" } as const;
const bridge = "http://127.0.0.1:9999";

it.each<{
  name: string;
  policy?: Policy;
  browser?: OpenClawPluginToolContext["browser"];
  route: "host" | "node" | "sandbox" | "blocked";
  guidance: string;
}>([
  {
    name: "manual pin",
    policy: pin,
    route: "node",
    guidance: "Default: configured browser node.",
  },
  {
    name: "auto pin",
    policy: { mode: "auto", node: " node-1 " },
    route: "node",
    guidance: "Default: configured browser node.",
  },
  {
    name: "automatic node selection",
    route: "node",
    guidance: "Default: host.",
  },
  {
    name: "manual without pin",
    policy: { mode: "manual" },
    route: "host",
    guidance: "Default: host.",
  },
  {
    name: "off with pin",
    policy: { mode: "off", node: "node-1" },
    route: "host",
    guidance: "Default: host.",
  },
  {
    name: "sandbox before pin with denied host control",
    policy: pin,
    browser: { sandboxBridgeUrl: bridge, allowHostControl: false },
    route: "sandbox",
    guidance: "Default: sandbox.",
  },
  {
    name: "denied host control without sandbox",
    policy: pin,
    browser: { allowHostControl: false },
    route: "blocked",
    guidance: "Host target blocked by policy.",
  },
])("aligns registered guidance with dispatch for $name", async (scenario) => {
  const runtimeConfig = { browser: {}, gateway: { nodes: { browser: scenario.policy } } };
  config.loadConfig.mockReturnValue(runtimeConfig);
  host.isBrowserHostAvailable.mockReturnValue(Boolean(scenario.policy?.node));
  nodes.listNodes.mockResolvedValue([
    { nodeId: "node-1", connected: true, caps: ["browser"], commands: ["browser.proxy"] },
  ]);
  const tool = registeredTool({
    browser: scenario.browser,
    config: { gateway: { nodes: { browser: { mode: "off" } } } },
    getRuntimeConfig: () => runtimeConfig,
  });
  const execution = tool.execute("routing-proof", { action: "status" });
  if (scenario.route === "blocked") {
    await expect(execution).rejects.toThrow("Host browser control is disabled");
  } else {
    await execution;
  }
  if (scenario.route === "node") {
    expect(gateway.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "node-1" }),
      expect.anything(),
    );
    expect(client.browserStatus).not.toHaveBeenCalled();
  } else {
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
    if (scenario.route === "blocked") {
      expect(client.browserStatus).not.toHaveBeenCalled();
    } else {
      expect(client.browserStatus).toHaveBeenCalledWith(
        scenario.route === "sandbox" ? bridge : undefined,
        { profile: undefined },
      );
    }
  }
  expect(tool.description).toContain(scenario.guidance);
  if (scenario.policy?.node && scenario.policy.mode !== "off" && !scenario.browser) {
    expect(tool.description).not.toContain("Prefer the host browser");
    expect(tool.description).toContain("it bypasses configured node routing");
    expect(tool.description).toContain("report the routing error rather than switching to host");
  }
});

describe("device-scoped browser routing", () => {
  const scopedDevice = {
    deviceId: "device-9",
    rootSessionKey: "agent:main:root",
    leaseToken: "lease-9",
  };

  function scopedDeviceNode(overrides: Record<string, unknown> = {}) {
    return {
      nodeId: "device-9",
      connected: true,
      caps: ["browser"],
      commands: ["browser.proxy", "browser.proxy.upload.v1"],
      ...overrides,
    };
  }

  it("pins the browser tool to the session's device and admits the proxy under the lease", async () => {
    deviceScopeMocks.readBrowserDeviceControlScope.mockReturnValue(scopedDevice);
    config.loadConfig.mockReturnValue({ browser: {} });
    // An available host must not win, and neither may another browser node.
    host.isBrowserHostAvailable.mockReturnValue(true);
    nodes.listNodes.mockResolvedValue([
      { nodeId: "node-1", connected: true, caps: ["browser"], commands: ["browser.proxy"] },
      scopedDeviceNode(),
    ]);
    const tool = registeredTool({
      config: { gateway: { nodes: { browser: { mode: "off" } } } },
      getRuntimeConfig: () => ({ browser: {} }),
    });
    await tool.execute("device-proof", { action: "status" });
    const nodeInvoke = gateway.callGatewayTool.mock.calls.find((call) => call[0] === "node.invoke");
    expect(nodeInvoke).toBeDefined();
    expect(nodeInvoke?.[2]).toMatchObject({
      nodeId: "device-9",
      command: "browser.proxy",
      sessionKey: "agent:main:root",
      params: expect.objectContaining({ leaseToken: "lease-9" }),
    });
    expect(
      (nodeInvoke![2] as { params: Record<string, unknown> }).params.sessionKey,
    ).toBeUndefined();
    expect(client.browserStatus).not.toHaveBeenCalled();
  });

  it("fails per call when the scoped device does not advertise browser control", async () => {
    deviceScopeMocks.readBrowserDeviceControlScope.mockReturnValue(scopedDevice);
    config.loadConfig.mockReturnValue({ browser: {} });
    // A browser capability alone is not enough: the proxy command must be
    // advertised, because that is what device-scope control dispatches to.
    nodes.listNodes.mockResolvedValue([scopedDeviceNode({ caps: ["browser"], commands: [] })]);
    const tool = registeredTool({
      config: { gateway: { nodes: { browser: { mode: "off" } } } },
      getRuntimeConfig: () => ({ browser: {} }),
    });
    await expect(tool.execute("device-proof", { action: "status" })).rejects.toThrow(
      /device-9 does not advertise browser control \(browser\.proxy\).*no gateway fallback/is,
    );
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails per call when the scoped device is not connected", async () => {
    deviceScopeMocks.readBrowserDeviceControlScope.mockReturnValue(scopedDevice);
    config.loadConfig.mockReturnValue({ browser: {} });
    nodes.listNodes.mockResolvedValue([scopedDeviceNode({ connected: false })]);
    const tool = registeredTool({
      config: { gateway: { nodes: { browser: { mode: "off" } } } },
      getRuntimeConfig: () => ({ browser: {} }),
    });
    await expect(tool.execute("device-proof", { action: "status" })).rejects.toThrow(
      /device-9 is not connected.*no gateway fallback/is,
    );
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails per call when node browser proxying is disabled", async () => {
    deviceScopeMocks.readBrowserDeviceControlScope.mockReturnValue(scopedDevice);
    config.loadConfig.mockReturnValue({
      browser: {},
      gateway: { nodes: { browser: { mode: "off" } } },
    });
    nodes.listNodes.mockResolvedValue([scopedDeviceNode()]);
    const tool = registeredTool({
      config: { gateway: { nodes: { browser: { mode: "off" } } } },
      getRuntimeConfig: () => ({ browser: {}, gateway: { nodes: { browser: { mode: "off" } } } }),
    });
    await expect(tool.execute("device-proof", { action: "status" })).rejects.toThrow(
      /gateway\.nodes\.browser\.mode=off/,
    );
    expect(gateway.callGatewayTool).not.toHaveBeenCalled();
  });
});
