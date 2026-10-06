import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  modelProviderModelKey,
  normalizeModelProviderName,
} from "../../../../src/config/model-provider-config.js";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
  isMergePatchObjectKeyAllowed,
} from "../../../../src/config/patch-replace-paths.js";

export { modelReferences } from "../../../../src/config/model-provider-config.js";

export function configuredProvider(
  config: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const providers = asNullableRecord(asNullableRecord(config?.models)?.providers);
  return asNullableRecord(providers?.[key]);
}

export function providerNameConflict(
  config: Record<string, unknown> | null,
  key: string,
  name: string,
): boolean {
  const providers = asNullableRecord(asNullableRecord(config?.models)?.providers);
  const normalized = normalizeModelProviderName(name);
  return (
    !normalized ||
    Object.entries(providers ?? {}).some(
      ([id, value]) =>
        id !== key &&
        normalizeModelProviderName(String(asNullableRecord(value)?.name ?? id)) === normalized,
    )
  );
}

export function providerModels(
  config: Record<string, unknown> | null,
  key: string,
): Record<string, unknown>[] {
  const models = configuredProvider(config, key)?.models;
  return Array.isArray(models) ? models.filter(isRecord) : [];
}

/** Refresh replaces untouched discovered rows while retaining user-maintained definitions. */
export function refreshProviderModels(
  current: readonly Record<string, unknown>[],
  discovered: readonly Record<string, unknown>[],
  baseUrl: string,
): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of discovered) {
    rows.set(modelProviderModelKey(baseUrl, row), { ...row, metadataSource: "provider-discovery" });
  }
  for (const row of current) {
    if (row.metadataSource !== "provider-discovery") {
      rows.set(modelProviderModelKey(baseUrl, row), row);
    }
  }
  return [...rows.values()];
}

export type ProviderModelsPatch = {
  raw: Record<string, unknown>;
  replacePaths: string[];
};

export function providerConnectionPatch(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  touched: ReadonlySet<string>,
  key: string,
): ProviderModelsPatch {
  const providerPath = formatConfigPatchPath("models.providers", key);
  const replacePaths = new Set<string>();
  function changedValue(base: unknown, next: unknown, path: string): unknown {
    if (isRecord(base) && isRecord(next)) {
      const patch: Record<string, unknown> = {};
      for (const childKey of new Set([...Object.keys(base), ...Object.keys(next)])) {
        if (!isMergePatchObjectKeyAllowed(childKey, path)) {
          continue;
        }
        const childPath = formatConfigPatchPath(path, childKey);
        const changed = Object.hasOwn(next, childKey)
          ? changedValue(base[childKey], next[childKey], childPath)
          : changedValue(base[childKey], null, childPath);
        if (changed !== undefined) {
          patch[childKey] = changed;
        }
      }
      return Object.keys(patch).length ? patch : undefined;
    }
    if (JSON.stringify(base) === JSON.stringify(next)) {
      return undefined;
    }
    for (const arrayPath of [
      ...collectBaseArrayPaths(base, path),
      ...collectBaseArrayPaths(next, path),
    ]) {
      replacePaths.add(arrayPath);
    }
    return structuredClone(next);
  }
  const patch: Record<string, unknown> = {};
  for (const field of touched) {
    if (!isMergePatchObjectKeyAllowed(field, providerPath)) {
      continue;
    }
    const changed = changedValue(
      original[field],
      Object.hasOwn(draft, field) ? draft[field] : null,
      formatConfigPatchPath(providerPath, field),
    );
    if (changed !== undefined) {
      patch[field] = changed;
    }
  }
  return {
    raw: { models: { providers: { [key]: patch } } },
    replacePaths: [...replacePaths],
  };
}

export function providerEndpoint(
  config: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const baseUrl = configuredProvider(config, key)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}
