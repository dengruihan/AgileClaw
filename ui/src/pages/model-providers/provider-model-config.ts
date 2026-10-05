import { asNullableRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
  isMergePatchObjectKeyAllowed,
} from "../../../../src/config/patch-replace-paths.js";

export function configuredProvider(
  config: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const providers = asNullableRecord(asNullableRecord(config?.models)?.providers);
  return asNullableRecord(providers?.[key]);
}

export function providerModels(
  config: Record<string, unknown> | null,
  key: string,
): Record<string, unknown>[] {
  const models = configuredProvider(config, key)?.models;
  return Array.isArray(models) ? models.filter(isRecord) : [];
}

/** Merges discovery rows with authored config rows; authored fields win. */
export function mergeProviderModelRows(
  catalog: readonly { id: unknown }[],
  configRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of catalog) {
    if (typeof row.id === "string") {
      rows.set(row.id, row as Record<string, unknown>);
    }
  }
  for (const row of configRows) {
    if (typeof row.id === "string") {
      rows.set(row.id, { ...rows.get(row.id), ...row });
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

function modelsPatch(key: string, models: Record<string, unknown>[]): ProviderModelsPatch {
  return {
    raw: { models: { providers: { [key]: { models } } } },
    replacePaths: [formatConfigPatchPath(formatConfigPatchPath("models.providers", key), "models")],
  };
}

export function modelWritePatch(
  config: Record<string, unknown> | null,
  key: string,
  model: Record<string, unknown>,
  originalId?: string,
): ProviderModelsPatch {
  const models = providerModels(config, key);
  const existingIndex = models.findIndex((entry) => entry.id === (originalId ?? model.id));
  const savedModel = {
    ...model,
    ...(originalId === undefined && existingIndex < 0 ? { metadataSource: "models-add" } : {}),
  };
  const next = [...models];
  if (existingIndex < 0) {
    next.push(savedModel);
  } else {
    next[existingIndex] = savedModel;
  }
  return modelsPatch(key, next);
}

export function modelRemovePatch(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
): ProviderModelsPatch {
  return modelsPatch(
    key,
    providerModels(config, key).filter((model) => model.id !== id),
  );
}

const ENTRY_BOOKKEEPING_FIELDS = new Set(["id", "name", "hidden"]);

/** Whether a config entry carries user-authored fields beyond the hide marker. */
export function modelEntryHasAuthorFields(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).some((field) => !ENTRY_BOOKKEEPING_FIELDS.has(field));
}

/** Whether a config entry hides its model from the invocable list. */
export function modelEntryHidden(entry: Record<string, unknown> | undefined): boolean {
  return entry?.hidden === true;
}

/** The config entry without its hide marker, for toggling visibility back on. */
export function modelEntryWithoutHidden(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "hidden"));
}

/** Hides or unhides one model: overlay entry for hide, cleanup or removal for show. */
export function modelVisibilityPatch(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
  hidden: boolean,
  catalogName: string | undefined,
): ProviderModelsPatch {
  const current = providerModels(config, key).find((entry) => entry.id === id);
  if (!hidden) {
    const rest = current ? modelEntryWithoutHidden(current) : undefined;
    const renamed = typeof rest?.name === "string" && rest.name !== catalogName;
    if (
      rest &&
      (modelEntryHasAuthorFields(rest) || renamed || rest.metadataSource === "models-add")
    ) {
      return modelWritePatch(config, key, rest, id);
    }
    // The entry existed only to hide the model; drop it entirely.
    return modelRemovePatch(config, key, id);
  }
  return modelWritePatch(
    config,
    key,
    { ...(current ?? { id, name: catalogName ?? id }), hidden: true },
    id,
  );
}

function referencePath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  if (/^[a-zA-Z_$][\w$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

export function modelReferences(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
): string[] {
  const target = `${key}/${id}`;
  const references = new Set<string>();
  const matches = (value: string) => splitTrailingAuthProfile(value).model === target;
  function visit(value: unknown, path: string): void {
    if (typeof value === "string") {
      if (matches(value)) {
        references.add(path);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, referencePath(path, index)));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [entryKey, entry] of Object.entries(value)) {
      const childPath = referencePath(path, entryKey);
      // Provider definitions describe models; their own IDs are not consumers.
      if (path === "models" && entryKey === "providers") {
        continue;
      }
      if (matches(entryKey)) {
        references.add(childPath);
      }
      visit(entry, childPath);
    }
  }
  visit(config, "");
  return [...references];
}

export function localOrCustomProvider(
  config: Record<string, unknown> | null,
  key: string,
  knownProviderIds: ReadonlySet<string>,
  catalogModels: readonly { provider: string; local?: boolean }[],
): boolean {
  const provider = configuredProvider(config, key);
  // An explicit config entry outside the known catalog is a custom provider even
  // when no capabilities loaded; a card with neither config nor capability
  // information stays cloud so it is not hidden from the default tab.
  const known = knownProviderIds.size > 0 && knownProviderIds.has(key);
  return (
    (provider !== null && !known) ||
    provider?.api === "ollama" ||
    isRecord(provider?.localService) ||
    isRecord(provider?.agentRuntime) ||
    catalogModels.some((model) => model.provider === key && model.local === true)
  );
}

export function providerEndpoint(
  config: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const baseUrl = configuredProvider(config, key)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}
