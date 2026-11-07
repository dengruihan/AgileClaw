/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { MonitoringInventory, MonitoringRow } from "./monitoring-data.ts";
import {
  renderMonitoring,
  type MonitoringPanelsState,
  type MonitoringViewState,
} from "./monitoring-view.ts";
import { DASHBOARD_PANEL_IDS } from "./panel-catalog.ts";

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

function panelsState(overrides: Partial<MonitoringPanelsState> = {}): MonitoringPanelsState {
  return {
    visible: DASHBOARD_PANEL_IDS,
    libraryOpen: false,
    toggle: vi.fn(),
    showAll: vi.fn(),
    openLibrary: vi.fn(),
    closeLibrary: vi.fn(),
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

  it("orders machines by availability and renders reported measurements", () => {
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
    expect(container.querySelectorAll("openclaw-sparkline")).toHaveLength(3);
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

  it("renders nothing when the dashboards page has no monitoring owner", () => {
    const container = document.createElement("div");
    render(html`${renderMonitoring(undefined)}`, container);
    expect(container.querySelector("[data-monitoring]")).toBeNull();
  });

  it("renders the full default view without a panel library owner", () => {
    const container = document.createElement("div");
    render(renderMonitoring(state()), container);

    expect(container.querySelectorAll("openclaw-sparkline")).toHaveLength(3);
    expect(container.querySelector(".dashboards-monitoring__panels")).toBeNull();
    expect(container.querySelector("[data-panel-library]")).toBeNull();
  });

  it("renders only the panels in the saved selection", () => {
    const container = document.createElement("div");
    render(renderMonitoring(state(), panelsState({ visible: ["memory"] })), container);

    expect(container.querySelectorAll("openclaw-sparkline")).toHaveLength(1);
    expect(container.querySelector(".dashboards-monitoring__vital--memory")).not.toBeNull();
    expect(container.querySelector(".dashboards-monitoring__vital--load")).toBeNull();
    expect(container.querySelector(".dashboards-monitoring__vital--disk")).toBeNull();
    // Every machine stays listed; only the panels shrink.
    expect(container.querySelectorAll("[data-monitoring-machine]")).toHaveLength(3);
    expect(container.textContent).toContain("1/3");
  });

  it("offers every catalog panel in the library and reports the current choice", () => {
    const panels = panelsState({ visible: ["load"], libraryOpen: true });
    const container = document.createElement("div");
    render(renderMonitoring(state(), panels), container);

    const options = Array.from(
      container.querySelectorAll<HTMLInputElement>("[data-panel-option] input"),
      (input) => [
        input.closest<HTMLElement>("[data-panel-option]")!.dataset.panelOption,
        input.checked,
      ],
    );
    expect(options).toEqual([
      ["load", true],
      ["memory", false],
      ["disk", false],
    ]);
    expect(container.textContent).toContain("CPU load");
    expect(container.textContent).toContain("Memory used");
    expect(container.textContent).toContain("Disk available");

    container
      .querySelector<HTMLInputElement>('[data-panel-option="memory"] input')
      ?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(panels.toggle).toHaveBeenCalledWith("memory");
  });

  it("adds every panel back from the library and closes it from the footer", () => {
    const panels = panelsState({ visible: [], libraryOpen: true });
    const container = document.createElement("div");
    render(renderMonitoring(state(), panels), container);

    const showAll = container.querySelector<HTMLButtonElement>(
      ".dashboards-panel-library__footer .btn--ghost",
    );
    expect(showAll?.disabled).toBe(false);
    showAll?.click();
    expect(panels.showAll).toHaveBeenCalledTimes(1);

    container
      .querySelector<HTMLButtonElement>(".dashboards-panel-library__footer .btn.primary")
      ?.click();
    expect(panels.closeLibrary).toHaveBeenCalledTimes(1);
  });

  it("keeps the library trigger reachable while the inventory loads", () => {
    const container = document.createElement("div");
    render(
      renderMonitoring(
        state({ inventory: null, rows: [], sampledAtMs: null }),
        panelsState({ visible: ["load"] }),
      ),
      container,
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector(".dashboards-monitoring__panels")?.textContent).toContain(
      "Panels",
    );
  });

  it("shows an empty state with one way back into the library when nothing is selected", () => {
    const panels = panelsState({ visible: [] });
    const container = document.createElement("div");
    render(renderMonitoring(state(), panels), container);

    const empty = container.querySelector("[data-monitoring-no-panels]");
    expect(empty?.textContent).toContain("No machine panels selected");
    expect(container.querySelectorAll("[data-monitoring-machine]")).toHaveLength(0);
    expect(container.querySelectorAll("openclaw-sparkline")).toHaveLength(0);
    // Machine availability stays visible while panels are hidden.
    expect(container.textContent).toContain("2 Online");

    empty?.querySelector<HTMLButtonElement>("button")?.click();
    expect(panels.openLibrary).toHaveBeenCalledTimes(1);
  });

  it("keeps the error callout visible while no panels are selected", () => {
    const container = document.createElement("div");
    render(
      renderMonitoring(
        state({
          inventory: null,
          rows: [],
          sampledAtMs: null,
          error: "Inventory unavailable",
        }),
        panelsState({ visible: [], libraryOpen: true }),
      ),
      container,
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Inventory unavailable",
    );
    expect(container.querySelector("[data-monitoring-no-panels]")).toBeNull();
    expect(container.querySelector("[data-panel-library]")).not.toBeNull();
  });
});
