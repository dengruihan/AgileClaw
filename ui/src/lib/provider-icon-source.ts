// Config-owned provider brand icons. A provider stores the icon chosen when it
// was saved, so display surfaces read that stored value instead of re-matching
// names or model ids. Bootstrap registers the current config reader once; this
// module owns no config state and no icon assets.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";

/** Authored icon presentation stored on one `models.providers` entry. */
export type ProviderIconConfigEntry = {
  /** Authored display name, or null when the provider key is the only label. */
  displayName: string | null;
  /** Stored icon id, or null when the entry has none. */
  icon: string | null;
  /** True when the icon, or its removal, is a user decision. */
  iconManual: boolean;
};

type ProviderIconConfigSource = () => Record<string, unknown> | null;

let configSource: ProviderIconConfigSource | null = null;

/**
 * Bootstrap registration point, called right after the runtime config
 * capability exists. The returned handle unregisters only this source, so a
 * replaced application context cannot keep serving icons from a disposed one.
 */
export function registerProviderIconConfigSource(source: ProviderIconConfigSource): () => void {
  configSource = source;
  return () => {
    if (configSource === source) {
      configSource = null;
    }
  };
}

function readProviderEntry(value: unknown): ProviderIconConfigEntry | null {
  const entry = asConfigRecord(value);
  if (!entry) {
    return null;
  }
  const displayName = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
  return {
    displayName: displayName || null,
    icon: typeof entry.icon === "string" && entry.icon ? entry.icon : null,
    iconManual: entry.iconManual === true,
  };
}

/** Every authored provider entry, keyed by the exact `models.providers` key. */
export function readProviderIconConfigEntries(
  config: Record<string, unknown> | null,
): Record<string, ProviderIconConfigEntry> {
  const providers = asConfigRecord(asConfigRecord(config?.models)?.providers);
  const entries: Record<string, ProviderIconConfigEntry> = {};
  for (const [key, value] of Object.entries(providers ?? {})) {
    const entry = readProviderEntry(value);
    if (entry) {
      entries[key] = entry;
    }
  }
  return entries;
}

/**
 * Stored icon config for a provider key, or null until bootstrap registers a
 * config source. Exact keys win; icon callers also pass canonical (lowercased)
 * provider ids, so a case-insensitive match keeps hand-authored keys reachable.
 */
export function readProviderIconConfig(provider: string): ProviderIconConfigEntry | null {
  const config = configSource?.() ?? null;
  if (!config) {
    return null;
  }
  const key = provider.trim();
  if (!key) {
    return null;
  }
  const entries = readProviderIconConfigEntries(config);
  const exact = entries[key];
  if (exact) {
    return exact;
  }
  const normalized = key.toLowerCase();
  for (const [candidate, entry] of Object.entries(entries)) {
    if (candidate.trim().toLowerCase() === normalized) {
      return entry;
    }
  }
  return null;
}
