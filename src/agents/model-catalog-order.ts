import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";

/**
 * Provider catalogs declare models strongest-first. Preserve that owner order
 * after registry/config merges instead of falling back to alphabetical names.
 */
export function assignProviderModelOrder(
  entries: readonly ModelCatalogEntry[],
  existingEntries: readonly ModelCatalogEntry[] = [],
  options: { appendUnknown?: boolean } = {},
): ModelCatalogEntry[] {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const orderByModel = new Map<string, number>();
  const nextOrderByProvider = new Map<string, number>();
  for (const entry of existingEntries) {
    if (entry.providerOrder === undefined) {
      continue;
    }
    const provider = normalizeProviderId(entry.provider);
    const key = keyOf(entry);
    orderByModel.set(key, entry.providerOrder);
    nextOrderByProvider.set(
      provider,
      Math.max(nextOrderByProvider.get(provider) ?? 0, entry.providerOrder + 1),
    );
  }
  return entries.map((entry) => {
    const provider = normalizeProviderId(entry.provider);
    const key = keyOf(entry);
    const existingOrder = orderByModel.get(key);
    if (existingOrder !== undefined) {
      return { ...entry, providerOrder: existingOrder };
    }
    if (options.appendUnknown === false) {
      return entry;
    }
    const providerOrder = nextOrderByProvider.get(provider) ?? 0;
    nextOrderByProvider.set(provider, providerOrder + 1);
    orderByModel.set(key, providerOrder);
    return { ...entry, providerOrder };
  });
}

export function compareModelCatalogEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  const providerComparison = normalizeProviderId(a.provider).localeCompare(
    normalizeProviderId(b.provider),
  );
  if (providerComparison !== 0) {
    return providerComparison;
  }
  const orderComparison =
    (a.providerOrder ?? Number.MAX_SAFE_INTEGER) - (b.providerOrder ?? Number.MAX_SAFE_INTEGER);
  return orderComparison || a.id.localeCompare(b.id) || a.name.localeCompare(b.name);
}

/**
 * Authoritative authored order from `models.providers.*`: provider declaration
 * order plus each provider's `models[]` array order (the Model Settings order).
 * Keys use the catalog identity resolver so aliases and manifest-normalized ids
 * match the prepared rows.
 */
export type AuthoredModelCatalogOrder = {
  keyOf: (entry: Pick<ModelCatalogEntry, "provider" | "id">) => string;
  providerRank: ReadonlyMap<string, number>;
  modelRank: ReadonlyMap<string, number>;
};

export function compareModelCatalogEntriesWithAuthoredOrder(
  a: ModelCatalogEntry,
  b: ModelCatalogEntry,
  authoredOrder: AuthoredModelCatalogOrder,
): number {
  const aModelRank = authoredOrder.modelRank.get(authoredOrder.keyOf(a));
  const bModelRank = authoredOrder.modelRank.get(authoredOrder.keyOf(b));
  if (aModelRank !== undefined && bModelRank !== undefined) {
    const aProviderRank = authoredOrder.providerRank.get(normalizeProviderId(a.provider));
    const bProviderRank = authoredOrder.providerRank.get(normalizeProviderId(b.provider));
    return (
      (aProviderRank ?? Number.MAX_SAFE_INTEGER) - (bProviderRank ?? Number.MAX_SAFE_INTEGER) ||
      aModelRank - bModelRank ||
      compareModelCatalogEntries(a, b)
    );
  }
  // Authored rows lead discovered-only rows; the catalog owner never had an
  // authored position to preserve for the latter.
  if (aModelRank !== undefined) {
    return -1;
  }
  if (bModelRank !== undefined) {
    return 1;
  }
  return compareModelCatalogEntries(a, b);
}

/**
 * Normalize a display projection to the catalog owner's order. Authored model
 * settings order wins whenever a row was declared in `models.providers.*`;
 * rows with no authored position keep the provider-owned (manifest/providerOrder)
 * ranking. Selection is presentation state and never moves rows.
 */
export function orderModelCatalogForPicker(
  entries: readonly ModelCatalogEntry[],
  authoredOrder?: AuthoredModelCatalogOrder,
): ModelCatalogEntry[] {
  return entries.toSorted((a, b) =>
    authoredOrder
      ? compareModelCatalogEntriesWithAuthoredOrder(a, b, authoredOrder)
      : compareModelCatalogEntries(a, b),
  );
}
