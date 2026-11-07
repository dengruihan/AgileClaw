import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  DASHBOARD_PANEL_IDS,
  normalizeDashboardPanels,
  orderPanelSelection,
  type DashboardPanelId,
} from "./panel-catalog.ts";

const STORAGE_KEY_PREFIX = "openclaw.dashboards.panels.v1:";

/**
 * Panel visibility is device-local presentation state for one Gateway origin:
 * it changes what this browser renders and never writes Gateway state.
 */
export function dashboardPanelsStorageKey(gatewayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

/** A missing or unusable selection falls back to every panel, the default view. */
export function loadDashboardPanels(gatewayUrl: string): readonly DashboardPanelId[] {
  const storage = gatewayUrl ? getSafeLocalStorage() : null;
  if (!storage) {
    return DASHBOARD_PANEL_IDS;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(dashboardPanelsStorageKey(gatewayUrl)) ?? "null");
  } catch {
    return DASHBOARD_PANEL_IDS;
  }
  return normalizeDashboardPanels(stored) ?? DASHBOARD_PANEL_IDS;
}

export function saveDashboardPanels(
  gatewayUrl: string,
  panels: readonly DashboardPanelId[],
): boolean {
  const storage = gatewayUrl ? getSafeLocalStorage() : null;
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      dashboardPanelsStorageKey(gatewayUrl),
      JSON.stringify(orderPanelSelection(panels)),
    );
    return true;
  } catch {
    // Disabled or full storage keeps the in-memory selection for this page.
    return false;
  }
}
