import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export function modelRefKey(provider: string, id: string): string {
  return `${provider.trim().toLowerCase()}/${id.trim().toLowerCase()}`;
}

/**
 * Qualified lowercase `provider/model` refs of user-authored model entries
 * (`models.providers.*.models[]`). Returns null when no config snapshot is
 * loaded or no authored entry exists, so callers without a custom roster keep
 * the full catalog instead of emptying their lists.
 */
export function customModelRefs(
  config: Record<string, unknown> | null | undefined,
): ReadonlySet<string> | null {
  if (config === null || config === undefined) {
    return null;
  }
  const refs = new Set<string>();
  const providers = asNullableRecord(asNullableRecord(config.models)?.providers);
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const models = asNullableRecord(provider)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      for (const model of models) {
        const id = asNullableRecord(model)?.id;
        if (typeof id === "string" && id.trim()) {
          refs.add(modelRefKey(providerId, id));
        }
      }
    }
  }
  return refs.size ? refs : null;
}

/**
 * Catalog filter for model pickers: keeps user-authored entries plus
 * explicitly retained refs (the current selection). An unloaded config keeps
 * every row.
 */
export function filterCustomModelCatalog<T extends { provider: string; id: string }>(
  models: readonly T[],
  config: Record<string, unknown> | null | undefined,
  retainedRefs: readonly string[] = [],
): T[] {
  const refs = customModelRefs(config);
  if (refs === null) {
    return [...models];
  }
  const retained = new Set(retainedRefs.map((ref) => ref.trim().toLowerCase()));
  return models.filter((entry) => {
    const key = modelRefKey(entry.provider, entry.id);
    return refs.has(key) || retained.has(key);
  });
}
