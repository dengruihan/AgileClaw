/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_PANEL_IDS } from "./panel-catalog.ts";
import {
  dashboardPanelsStorageKey,
  loadDashboardPanels,
  saveDashboardPanels,
} from "./panel-preferences.ts";

const gatewayUrl = "ws://gateway.example.test/socket";

describe("dashboard panel preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows every panel when this browser stored no selection", () => {
    expect(loadDashboardPanels(gatewayUrl)).toEqual(DASHBOARD_PANEL_IDS);
  });

  it("restores a saved selection in catalog order", () => {
    expect(saveDashboardPanels(gatewayUrl, ["disk", "load"])).toBe(true);
    expect(loadDashboardPanels(gatewayUrl)).toEqual(["load", "disk"]);
  });

  it("keeps an intentional empty selection instead of falling back to every panel", () => {
    saveDashboardPanels(gatewayUrl, []);
    expect(loadDashboardPanels(gatewayUrl)).toEqual([]);
  });

  it("falls back to every panel for unusable stored data", () => {
    localStorage.setItem(dashboardPanelsStorageKey(gatewayUrl), "{not json");
    expect(loadDashboardPanels(gatewayUrl)).toEqual(DASHBOARD_PANEL_IDS);
    localStorage.setItem(dashboardPanelsStorageKey(gatewayUrl), JSON.stringify(["gpu"]));
    expect(loadDashboardPanels(gatewayUrl)).toEqual(DASHBOARD_PANEL_IDS);
  });

  it("scopes the selection to one Gateway origin", () => {
    saveDashboardPanels(gatewayUrl, ["memory"]);
    expect(loadDashboardPanels("ws://other.example.test")).toEqual(DASHBOARD_PANEL_IDS);
  });

  it("keeps the default view when no Gateway URL is known", () => {
    expect(loadDashboardPanels("")).toEqual(DASHBOARD_PANEL_IDS);
    expect(saveDashboardPanels("", ["memory"])).toBe(false);
  });
});
