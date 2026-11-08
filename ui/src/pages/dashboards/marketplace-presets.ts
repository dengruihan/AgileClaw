import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { getSafeLocalStorage } from "../../local-storage.ts";

/**
 * Built-in dashboard presets the marketplace offers. Every entry names the
 * region it installs and the measurements that region renders; a preset never
 * exists without its backing implementation.
 */
export const MARKETPLACE_PRESETS = [
  {
    id: "system-monitoring",
    nameKey: "systems.preset.name",
    descriptionKey: "systems.preset.description",
    measurementIds: ["load", "memory", "disk"],
  },
] as const;

export type MarketplacePreset = (typeof MARKETPLACE_PRESETS)[number];
export type MarketplacePresetId = MarketplacePreset["id"];

export const MARKETPLACE_PRESET_IDS: readonly MarketplacePresetId[] = MARKETPLACE_PRESETS.map(
  (preset) => preset.id,
);

/** Measurements a preset card presents; the System monitoring preset renders all of them. */
export const MARKETPLACE_MEASUREMENTS = {
  load: {
    labelKey: "systems.measurements.load.label",
    descriptionKey: "systems.measurements.load.description",
  },
  memory: {
    labelKey: "systems.measurements.memory.label",
    descriptionKey: "systems.measurements.memory.description",
  },
  disk: {
    labelKey: "systems.measurements.disk.label",
    descriptionKey: "systems.measurements.disk.description",
  },
} as const;

export type MarketplaceMeasurementId = keyof typeof MARKETPLACE_MEASUREMENTS;

function isMarketplacePresetId(value: unknown): value is MarketplacePresetId {
  return MARKETPLACE_PRESET_IDS.some((id) => id === value);
}

/** Installed ids in catalog order, so rendering never depends on click order. */
export function orderMarketplacePresets(ids: Iterable<MarketplacePresetId>): MarketplacePresetId[] {
  const selected = new Set(ids);
  return MARKETPLACE_PRESET_IDS.filter((id) => selected.has(id));
}

/**
 * Stored installs are untrusted browser data. `null` means "unusable, treat as
 * not installed"; a fresh browser also starts with nothing installed.
 */
export function normalizeInstalledMarketplacePresets(value: unknown): MarketplacePresetId[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return orderMarketplacePresets(value.filter(isMarketplacePresetId));
}

const STORAGE_KEY_PREFIX = "openclaw.dashboards.marketplace.v1:";

/**
 * Installed presets are device-local presentation state for one Gateway
 * origin: they change what this browser renders and never write Gateway state.
 */
export function marketplacePresetsStorageKey(gatewayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

/** A missing, unusable, or URL-less state installs nothing. */
export function loadInstalledMarketplacePresets(
  gatewayUrl: string,
): readonly MarketplacePresetId[] {
  const storage = gatewayUrl ? getSafeLocalStorage() : null;
  if (!storage) {
    return [];
  }
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(marketplacePresetsStorageKey(gatewayUrl)) ?? "null");
  } catch {
    return [];
  }
  return normalizeInstalledMarketplacePresets(stored) ?? [];
}

export function saveInstalledMarketplacePresets(
  gatewayUrl: string,
  ids: readonly MarketplacePresetId[],
): boolean {
  const storage = gatewayUrl ? getSafeLocalStorage() : null;
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(
      marketplacePresetsStorageKey(gatewayUrl),
      JSON.stringify(orderMarketplacePresets(ids)),
    );
    return true;
  } catch {
    // Disabled or full storage keeps the in-memory install for this page.
    return false;
  }
}
