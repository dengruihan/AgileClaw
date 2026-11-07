import { describe, expect, it } from "vitest";
import {
  DASHBOARD_PANEL_IDS,
  normalizeDashboardPanels,
  orderPanelSelection,
} from "./panel-catalog.ts";

describe("dashboard panel catalog", () => {
  it("lists only the panels the Gateway reports measurements for", () => {
    expect(DASHBOARD_PANEL_IDS).toEqual(["load", "memory", "disk"]);
  });

  it("orders a selection by the catalog instead of click order", () => {
    expect(orderPanelSelection(["disk", "load"])).toEqual(["load", "disk"]);
    expect(orderPanelSelection([])).toEqual([]);
  });

  it("treats a missing selection as unusable and an empty one as a real choice", () => {
    expect(normalizeDashboardPanels(null)).toBeNull();
    expect(normalizeDashboardPanels({})).toBeNull();
    expect(normalizeDashboardPanels(["gpu"])).toBeNull();
    expect(normalizeDashboardPanels([])).toEqual([]);
    expect(normalizeDashboardPanels(["memory", "memory", "gpu"])).toEqual(["memory"]);
  });
});
