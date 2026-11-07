/**
 * Resource panels the dashboards monitoring region can show. Every entry has a
 * measurement the Gateway already reports for a machine (load average, memory,
 * disk); no panel exists without data behind it.
 */
export const DASHBOARD_PANELS = [
  {
    id: "load",
    labelKey: "systems.panelCatalog.load.label",
    descriptionKey: "systems.panelCatalog.load.description",
  },
  {
    id: "memory",
    labelKey: "systems.panelCatalog.memory.label",
    descriptionKey: "systems.panelCatalog.memory.description",
  },
  {
    id: "disk",
    labelKey: "systems.panelCatalog.disk.label",
    descriptionKey: "systems.panelCatalog.disk.description",
  },
] as const;

export type DashboardPanel = (typeof DASHBOARD_PANELS)[number];
export type DashboardPanelId = DashboardPanel["id"];

export const DASHBOARD_PANEL_IDS: readonly DashboardPanelId[] = DASHBOARD_PANELS.map(
  (panel) => panel.id,
);

function isDashboardPanelId(value: unknown): value is DashboardPanelId {
  return DASHBOARD_PANEL_IDS.some((id) => id === value);
}

/** Selection in catalog order, so rendering never depends on click order. */
export function orderPanelSelection(ids: Iterable<DashboardPanelId>): DashboardPanelId[] {
  const selected = new Set(ids);
  return DASHBOARD_PANEL_IDS.filter((id) => selected.has(id));
}

/**
 * Stored selections are untrusted browser data. `null` means "unusable, use the
 * defaults"; an empty array is a real choice to show no panels.
 */
export function normalizeDashboardPanels(value: unknown): DashboardPanelId[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return [];
  }
  const known = value.filter(isDashboardPanelId);
  return known.length ? orderPanelSelection(known) : null;
}
