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
      // The empty select option restores protocol inheritance; an empty API
      // string is not a valid adapter id in persisted configuration.
      field === "api" && draft[field] === ""
        ? null
        : Object.hasOwn(draft, field)
          ? draft[field]
          : null,
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

function modelRemovePatch(
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
function modelEntryHasAuthorFields(entry: Record<string, unknown>): boolean {
  return Object.keys(entry).some((field) => !ENTRY_BOOKKEEPING_FIELDS.has(field));
}

/** Whether a config entry hides its model from the invocable list. */
export function modelEntryHidden(entry: Record<string, unknown> | undefined): boolean {
  return entry?.hidden === true;
}

/** The config entry without its hide marker, for toggling visibility back on. */
function modelEntryWithoutHidden(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([field]) => field !== "hidden"));
}

/**
 * Deletes one model from the dialog list: drop any authored entry, and keep
 * endpoint-discovered rows excluded with a bare hide marker.
 */
export function modelDeletePatch(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
  catalog: { listed: boolean; name?: string },
): ProviderModelsPatch {
  const models = providerModels(config, key);
  const rest = models.filter((model) => model.id !== id);
  if (catalog.listed) {
    const marker = { id, name: catalog.name ?? id, hidden: true };
    const index = models.findIndex((model) => model.id === id);
    if (index < 0) {
      rest.push(marker);
    } else {
      rest.splice(index, 0, marker);
    }
  }
  return modelsPatch(key, rest);
}

/** Restores a deleted model: bare hide markers drop, authored entries keep their fields. */
export function modelRestorePatch(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
  catalogName: string | undefined,
): ProviderModelsPatch {
  const current = providerModels(config, key).find((entry) => entry.id === id);
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

function referencePath(parent: string, key: string | number): string {
  if (typeof key === "number") {
    return `${parent}[${key}]`;
  }
  if (/^[a-zA-Z_$][\w$]*$/.test(key)) {
    return parent ? `${parent}.${key}` : key;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function segmentsToPath(segments: readonly (string | number)[]): string {
  return segments.reduce<string>(
    (path, segment) =>
      typeof segment === "number" ? `${path}[${segment}]` : referencePath(path, segment),
    "",
  );
}

/** One config site naming a model reference: an object field or an array element. */
export type ProviderReferenceSite = {
  /** Display path from the config root, e.g. "agents.defaults.model.fallbacks[1]". */
  path: string;
  kind: "field" | "arrayItem";
  /** Segments from the config root to the containing object or array. */
  parentSegments: (string | number)[];
  /** Containing object key or array index holding the reference. */
  key: string | number;
};

function collectReferenceSites(
  config: Record<string, unknown> | null,
  matches: (value: string) => boolean,
): ProviderReferenceSite[] {
  const sites: ProviderReferenceSite[] = [];
  function visit(
    value: unknown,
    segments: (string | number)[],
    parent: Record<string, unknown> | unknown[] | null,
    key: string | number | null,
  ): void {
    if (typeof value === "string") {
      if (parent !== null && key !== null && matches(value)) {
        sites.push({
          path: segmentsToPath(segments),
          kind: typeof key === "number" ? "arrayItem" : "field",
          parentSegments: segments.slice(0, -1),
          key,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...segments, index], value, index));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [entryKey, entry] of Object.entries(value)) {
      // Provider definitions describe models; their own IDs are not consumers.
      if (segments.length === 1 && segments[0] === "models" && entryKey === "providers") {
        continue;
      }
      if (matches(entryKey)) {
        sites.push({
          path: segmentsToPath([...segments, entryKey]),
          kind: "field",
          parentSegments: segments,
          key: entryKey,
        });
      }
      visit(entry, [...segments, entryKey], value, entryKey);
    }
  }
  visit(config, [], null, null);
  return sites;
}

export function modelReferences(
  config: Record<string, unknown> | null,
  key: string,
  id: string,
): string[] {
  const target = `${key}/${id}`;
  return [
    ...new Set(
      collectReferenceSites(
        config,
        (value) => splitTrailingAuthProfile(value).model === target,
      ).map((site) => site.path),
    ),
  ];
}

/** Every config site referencing any model of one provider, for provider deletion. */
export function providerReferenceSites(
  config: Record<string, unknown> | null,
  key: string,
): ProviderReferenceSite[] {
  const prefix = `${key}/`;
  return collectReferenceSites(config, (value) =>
    splitTrailingAuthProfile(value).model.startsWith(prefix),
  );
}

function resolveSegments(
  root: Record<string, unknown> | null,
  segments: readonly (string | number)[],
): unknown {
  let value: unknown = root;
  for (const segment of segments) {
    value =
      typeof segment === "number"
        ? Array.isArray(value)
          ? value[segment]
          : undefined
        : isRecord(value)
          ? value[segment]
          : undefined;
    if (value === undefined) {
      return undefined;
    }
  }
  return value;
}

/**
 * Deletes a provider entry and clears every config site referencing its models.
 * Object fields null out (merge-patch deletes the key); fallback-style arrays
 * rebuild without the deleted provider's entries, confirmed via replacePaths;
 * and resetting a primary takes the whole model selection object with it so no
 * selection is left with fallbacks but no primary.
 */
export function providerDeletePatch(
  config: Record<string, unknown> | null,
  key: string,
  sites: readonly ProviderReferenceSite[],
): ProviderModelsPatch {
  const raw: Record<string, unknown> = {};
  const replacePaths = new Set<string>();
  const setRaw = (segments: readonly (string | number)[], value: unknown): void => {
    let node: Record<string, unknown> = raw;
    let path = "";
    for (const segment of segments.slice(0, -1)) {
      if (typeof segment !== "string") {
        return;
      }
      if (!isMergePatchObjectKeyAllowed(segment, path)) {
        return;
      }
      const child = node[segment];
      const next = isRecord(child) ? child : {};
      node[segment] = next;
      node = next;
      path = formatConfigPatchPath(path, segment);
    }
    const last = segments.at(-1);
    if (typeof last === "string" && isMergePatchObjectKeyAllowed(last, path)) {
      node[last] = value;
    }
  };
  const resetPrefixes: (readonly (string | number)[])[] = [];
  const withinReset = (segments: readonly (string | number)[]) =>
    resetPrefixes.some(
      (prefix) =>
        prefix.length <= segments.length &&
        prefix.every((segment, index) => segment === segments[index]),
    );
  const arraysByName = new Map<string, { segments: (string | number)[]; indexes: Set<number> }>();
  for (const site of sites) {
    if (site.kind === "arrayItem") {
      if (typeof site.key === "number") {
        const arrayPath = segmentsToPath(site.parentSegments);
        const group = arraysByName.get(arrayPath) ?? {
          segments: [...site.parentSegments],
          indexes: new Set<number>(),
        };
        group.indexes.add(site.key);
        arraysByName.set(arrayPath, group);
      }
      continue;
    }
    const resetsModelSelection = site.key === "primary" && site.parentSegments.at(-1) === "model";
    const segments = resetsModelSelection
      ? site.parentSegments
      : [...site.parentSegments, site.key];
    if (resetsModelSelection) {
      resetPrefixes.push(segments);
    }
    setRaw(segments, null);
  }
  for (const group of arraysByName.values()) {
    if (withinReset(group.segments)) {
      continue;
    }
    const array = resolveSegments(config, group.segments);
    if (!Array.isArray(array)) {
      continue;
    }
    setRaw(
      group.segments,
      array.filter((_, index) => !group.indexes.has(index)),
    );
    replacePaths.add(
      group.segments.reduce<string>(
        (path, segment) =>
          typeof segment === "number"
            ? `${path}[${segment}]`
            : formatConfigPatchPath(path, segment),
        "",
      ),
    );
  }
  setRaw(["models", "providers", key], null);
  return { raw, replacePaths: [...replacePaths] };
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
  // information stays cloud so it remains grouped with cloud providers.
  const known = knownProviderIds.size > 0 && knownProviderIds.has(key);
  return (
    (provider !== null && !known) ||
    provider?.api === "ollama" ||
    isRecord(provider?.localService) ||
    isRecord(provider?.agentRuntime) ||
    catalogModels.some((model) => model.provider === key && model.local === true)
  );
}
