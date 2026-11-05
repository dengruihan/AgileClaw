/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createInitialDevicesState,
  type DevicesPageDataState,
} from "../../lib/nodes/page-operations.ts";
import "./devices-page.ts";
import type { DevicesRouteData } from "./devices-page.ts";

type TestDevicesPage = HTMLElement & {
  context: ApplicationContext;
  pageState: DevicesPageDataState;
  updateComplete: Promise<boolean>;
  routeData?: DevicesRouteData;
};

function gatewaySnapshot(
  client: GatewayBrowserClient,
  methods: string[],
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin", "operator.pairing"] },
      features: { methods },
    },
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
}

function mountPage(snapshot: ApplicationGatewaySnapshot) {
  const currentGateway = {
    snapshot,
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
  const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
  page.context = {
    gateway: currentGateway,
    runtimeConfig: {
      state: { configSnapshot: {}, configLoading: false },
      subscribe: vi.fn(() => () => undefined),
    },
  } as unknown as ApplicationContext;
  document.body.append(page);
  return { page, currentGateway };
}

describe("DevicesPage execution-device registry", () => {
  it("enables a disabled execution device through the registry switch", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "node.list") {
        return {
          nodes: [
            {
              nodeId: "office-pc",
              displayName: "Office PC",
              platform: "win32",
              paired: true,
              connected: true,
              enabled: false,
            },
          ],
        };
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return { paired: [], pending: [] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, ["node.list", "device.pair.list"]);
    const { page, currentGateway } = mountPage(snapshot);
    try {
      page.routeData = {
        gateway: currentGateway,
        gatewaySnapshot: snapshot,
        devices: createInitialDevicesState({ client, connected: true }),
      };
      await page.updateComplete;
      await vi.waitFor(() => expect(page.pageState.nodes).toHaveLength(1));
      const toggle = page.querySelector<HTMLElement & { checked: boolean }>(
        '[data-device-id="office-pc"] wa-switch.settings-toggle',
      );
      if (!toggle) {
        throw new Error("Expected execution-device toggle");
      }
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("node.device.enable", { nodeId: "office-pc" }),
      );
    } finally {
      page.remove();
    }
  });
});
