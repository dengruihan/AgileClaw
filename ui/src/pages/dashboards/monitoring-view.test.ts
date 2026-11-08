/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { MonitoringInventory, MonitoringRow } from "./monitoring-data.ts";
import { renderMonitoring, type MonitoringViewState } from "./monitoring-view.ts";

const environments: EnvironmentSummary[] = [
  { id: "gateway", type: "local", status: "available" },
  { id: "worker-one", type: "worker", status: "available", label: "Cloud worker" },
  { id: "worker-off", type: "worker", status: "unavailable", label: "Offline worker" },
];

function inventory(overrides: Partial<MonitoringInventory> = {}): MonitoringInventory {
  return {
    environments,
    nodes: [],
    gatewaySystemInfo: {
      machineName: "Gateway machine",
      hostname: "gateway-host",
      platform: "linux",
      release: "test",
      arch: "x64",
      osLabel: "Linux",
      nodeVersion: "v26",
      pid: 1,
      uptimeMs: 1_000,
      cpuCount: 4,
      memoryTotalBytes: 8_192,
      memoryFreeBytes: 4_096,
      loadAverage: [0.5, 0.4, 0.3],
      diskTotalBytes: 16_384,
      diskAvailableBytes: 8_192,
    },
    gatewaySampledAtMs: Date.now(),
    errors: {},
    ...overrides,
  };
}

function state(overrides: Partial<MonitoringViewState> = {}): MonitoringViewState {
  const value = inventory();
  const rows: MonitoringRow[] = value.environments.map((environment) => ({
    environment,
    gatewaySystemInfo: environment.id === "gateway" ? value.gatewaySystemInfo! : undefined,
    sessions: [],
  }));
  return {
    inventory: value,
    rows,
    loading: false,
    error: null,
    connected: true,
    sampledAtMs: value.gatewaySampledAtMs,
    telemetryHistory: () => [],
    refresh: async () => undefined,
    ...overrides,
  };
}

describe("dashboards machine monitoring", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("orders machines by availability and renders every installed measurement", () => {
    const container = document.createElement("div");
    render(renderMonitoring(state()), container);

    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-monitoring-machine]"),
        (machine) => [machine.dataset.monitoringMachine, machine.dataset.status],
      ),
    ).toEqual([
      ["gateway", "available"],
      ["worker-one", "available"],
      ["worker-off", "unavailable"],
    ]);
    expect(container.textContent).toContain("2 Online");
    expect(container.textContent).toContain("1 Offline");
    // The installed preset covers CPU load, memory used, and disk available.
    expect(container.querySelectorAll("openclaw-sparkline")).toHaveLength(3);
    expect(container.querySelector(".dashboards-monitoring__vital--load")).not.toBeNull();
    expect(container.querySelector(".dashboards-monitoring__vital--memory")).not.toBeNull();
    expect(container.querySelector(".dashboards-monitoring__vital--disk")).not.toBeNull();
    expect(
      container.querySelector(".dashboards-monitoring__vitals")?.getAttribute("data-stale"),
    ).toBe("false");
  });

  it.each([
    ["loading", state({ inventory: null, rows: [], sampledAtMs: null }), "Loading machines"],
    [
      "empty",
      state({ inventory: inventory({ environments: [] }), rows: [] }),
      "No machines are available",
    ],
    [
      "error",
      state({ inventory: null, rows: [], error: "Inventory unavailable" }),
      "Inventory unavailable",
    ],
  ] as const)("renders the %s state", (_label, value, copy) => {
    const container = document.createElement("div");
    render(renderMonitoring(value), container);

    expect(container.textContent).toContain(copy);
    expect(container.querySelectorAll("[data-monitoring-machine]")).toHaveLength(0);
  });

  it("marks retained measurements stale and keeps the gateway notice visible", () => {
    const container = document.createElement("div");
    render(
      renderMonitoring(
        state({
          connected: false,
          sampledAtMs: Date.now() - 120_000,
          inventory: inventory({ gatewaySampledAtMs: Date.now() - 120_000 }),
        }),
      ),
      container,
    );

    expect(
      container.querySelector(".dashboards-monitoring__vitals")?.getAttribute("data-stale"),
    ).toBe("true");
    expect(container.textContent).toContain("Gateway disconnected");
    expect(container.textContent).toContain("Last reported");
  });

  it("refreshes from the region control through the owning state", () => {
    const refresh = vi.fn(async () => undefined);
    const container = document.createElement("div");
    render(renderMonitoring(state({ refresh })), container);

    container.querySelector<HTMLButtonElement>(".dashboards-monitoring__refresh")?.click();
    expect(refresh).toHaveBeenCalledWith("manual");
  });

  it("renders nothing when no monitoring preset is installed", () => {
    const container = document.createElement("div");
    render(renderMonitoring(undefined), container);
    expect(container.querySelector("[data-monitoring]")).toBeNull();
  });

  it("keeps the legacy disk reading when the volume list is empty", async () => {
    // `system.info` can report `disks: []` together with the legacy aggregate
    // fields; the tile must still plot the reported availability.
    const gatewaySystemInfo = {
      ...inventory().gatewaySystemInfo!,
      disks: [],
      diskTotalBytes: 16_384,
      diskAvailableBytes: 8_192,
    };
    const value = inventory({ gatewaySystemInfo });
    const rows: MonitoringRow[] = [
      { environment: value.environments[0]!, gatewaySystemInfo, sessions: [] },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    render(renderMonitoring(state({ inventory: value, rows })), container);

    const disks = container.querySelectorAll<
      HTMLElement & { samples: readonly { value: number }[] }
    >("openclaw-sparkline.dashboards-monitoring__vital--disk");
    expect(disks).toHaveLength(1);
    expect(disks[0]!.samples.map((sample) => sample.value)).toEqual([8_192]);
    await (disks[0] as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(disks[0]!.textContent).toContain("8.0 KB");
  });
});
