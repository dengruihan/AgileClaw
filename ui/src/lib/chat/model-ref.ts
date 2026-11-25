import { isLegacyCodexProviderId } from "../../../../src/config/legacy-codex-provider.js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  resolveProviderDisplayName,
  type ProviderDisplayNames,
} from "../../components/provider-icon.ts";

export function normalizeChatModelProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return isLegacyCodexProviderId(normalized) ? "openai" : normalized;
}

export function buildQualifiedChatModelValue(model: string, provider?: string | null): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = provider?.trim();
  if (!trimmedProvider) {
    return trimmedModel;
  }
  const providerPrefix = `${trimmedProvider.toLowerCase()}/`;
  return trimmedModel.toLowerCase().startsWith(providerPrefix)
    ? trimmedModel
    : `${trimmedProvider}/${trimmedModel}`;
}

export function normalizeChatModelOverrideValue(
  value: string | null | undefined,
  catalog: readonly ModelCatalogEntry[],
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("/")
    ? trimmed
    : resolveUniqueCatalogValueById(trimmed, catalog) || trimmed;
}

function hasCatalogQualifiedValue(catalog: readonly ModelCatalogEntry[], value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return catalog.some((entry) => createQualifiedCatalogKey(entry) === normalized);
}

function resolveUniqueCatalogValueById(
  model: string,
  catalog: readonly ModelCatalogEntry[],
): string {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) {
    return "";
  }

  let matchedValue = "";
  for (const entry of catalog) {
    if (entry.id.trim().toLowerCase() !== normalizedModel) {
      continue;
    }
    const candidate = buildQualifiedChatModelValue(entry.id, entry.provider);
    if (!matchedValue) {
      matchedValue = candidate;
      continue;
    }
    if (matchedValue.toLowerCase() !== candidate.toLowerCase()) {
      return "";
    }
  }

  return matchedValue;
}

export function resolvePreferredServerChatModelValue(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: readonly ModelCatalogEntry[],
): string {
  if (typeof model !== "string") {
    return "";
  }
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }

  const trimmedProvider = provider?.trim();

  if (!trimmedProvider) {
    return normalizeChatModelOverrideValue(trimmedModel, catalog);
  }

  if (!trimmedModel.includes("/")) {
    const normalized = normalizeChatModelOverrideValue(trimmedModel, catalog);
    return normalized !== trimmedModel
      ? normalized
      : buildQualifiedChatModelValue(trimmedModel, trimmedProvider);
  }

  const qualifiedServerValue = buildQualifiedChatModelValue(trimmedModel, trimmedProvider);
  const normalizedModel = trimmedModel.toLowerCase();
  const normalizedProvider = normalizeChatModelProviderId(trimmedProvider);
  const serverProviderOwnsRawModelId = catalog.some(
    (entry) =>
      entry.id.trim().toLowerCase() === normalizedModel &&
      normalizeChatModelProviderId(entry.provider) === normalizedProvider,
  );

  // Session model/provider fields form one server-owned pair. Prefer the provider-qualified
  // route only when the catalog confirms that provider owns this raw nested model id.
  if (serverProviderOwnsRawModelId && hasCatalogQualifiedValue(catalog, qualifiedServerValue)) {
    return qualifiedServerValue;
  }

  if (hasCatalogQualifiedValue(catalog, trimmedModel)) {
    return trimmedModel;
  }

  if (hasCatalogQualifiedValue(catalog, qualifiedServerValue)) {
    return qualifiedServerValue;
  }

  const matchedCatalogValue = resolveUniqueCatalogValueById(trimmedModel, catalog);
  if (matchedCatalogValue) {
    return matchedCatalogValue;
  }

  // Without catalog confirmation, preserve slash-containing server values as-is.
  // Re-qualifying them here can turn an already-qualified ref under a stale
  // provider into a nonsense double-prefix like "zai/openai/gpt-5-mini".
  return trimmedModel;
}

function formatChatModelDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return trimmed;
  }
  return `${trimmed.slice(separator + 1)} · ${trimmed.slice(0, separator)}`;
}

function formatRawCatalogLabel(entry: ModelCatalogEntry, providerLabel?: string): string {
  const provider = providerLabel ?? entry.provider?.trim();
  return provider ? `${entry.id} · ${provider}` : entry.id;
}

function resolveCatalogDisplayName(entry: ModelCatalogEntry): string {
  const name = entry.name.trim();
  const alias = entry.alias?.trim();
  if (!name || !alias) {
    return name || alias || "";
  }
  if (alias.toLowerCase() === name.toLowerCase()) {
    return name;
  }
  // Aliases are selectable metadata, not a replacement for model identity.
  // Preserve richer custom labels only when they already contain the full name.
  return alias.toLowerCase().includes(name.toLowerCase()) ? alias : `${name} · ${alias}`;
}

function createQualifiedCatalogKey(entry: ModelCatalogEntry): string {
  return buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase();
}

function createNameProviderKey(name: string, providerName?: string | null): string {
  return `${name.toLowerCase()}\u0000${providerName?.trim().toLowerCase() ?? ""}`;
}

type DuplicateDetailInput = {
  name: string;
  providerName: string;
  /** Rows sharing this (name, provider name) pair. */
  rowsUnderProvider: number;
  /** Distinct provider ids behind those rows. */
  distinctProviders: number;
};

/**
 * Disambiguating part after a repeated model name. The provider name separates a
 * name repeated across providers; when several providers resolve to one name only
 * their ids can, and a model id already equal to the name keeps the provider id
 * alone. Ids are the last resort, never a shorter stand-in for the name.
 */
function resolveDuplicateDetail(entry: ModelCatalogEntry, input: DuplicateDetailInput): string {
  if (input.rowsUnderProvider <= 1) {
    return input.providerName || entry.provider?.trim() || entry.id;
  }
  if (input.distinctProviders > 1) {
    return entry.id.trim().toLowerCase() === input.name.toLowerCase()
      ? entry.provider?.trim() || entry.id
      : formatRawCatalogLabel(entry);
  }
  // One provider's ids share the name: the model id separates them, and the
  // provider part stays the name it is displayed under.
  return formatRawCatalogLabel(entry, input.providerName);
}

type ChatModelDisplayLookup = ReadonlyMap<string, string>;

/**
 * Labels every catalog row, suffixing the provider name only when the friendly
 * name alone would not identify the row. A provider id appears only when it is
 * what separates the rows: several providers that resolve to one name. Without
 * `authoredProviderNames` the names come from the registered provider config
 * source, the same one provider icons read.
 */
export function buildCatalogDisplayLookup(
  catalog: ModelCatalogEntry[],
  authoredProviderNames?: ProviderDisplayNames | null,
): Map<string, string> {
  const nameToValues = new Map<string, Set<string>>();
  const nameProviderToValues = new Map<string, Set<string>>();
  const nameProviderIds = new Map<string, Set<string>>();
  // Resolved names walk the provider config, so one lookup per provider per render.
  const providerNames = new Map<string, string>();
  const resolveProviderName = (provider: string) => {
    const key = provider.trim().toLowerCase();
    const cached = providerNames.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveProviderDisplayName(provider, authoredProviderNames);
    providerNames.set(key, resolved);
    return resolved;
  };
  const entries = catalog.map((entry) => {
    const name = resolveCatalogDisplayName(entry);
    const providerName = resolveProviderName(entry.provider);
    return {
      entry,
      name,
      providerName,
      qualifiedKey: normalizeAgentModelRefForConfig(
        buildQualifiedChatModelValue(entry.id, entry.provider),
      ),
      nameKey: name.toLowerCase(),
      providerKey: createNameProviderKey(name, providerName),
    };
  });

  for (const { entry, name, qualifiedKey, nameKey, providerKey } of entries) {
    if (!name) {
      continue;
    }
    const nameValues = nameToValues.get(nameKey) ?? new Set<string>();
    nameValues.add(qualifiedKey);
    nameToValues.set(nameKey, nameValues);

    const nameProviderValues = nameProviderToValues.get(providerKey) ?? new Set<string>();
    nameProviderValues.add(qualifiedKey);
    nameProviderToValues.set(providerKey, nameProviderValues);

    // Distinct provider ids for one (name, provider name) pair. More than one
    // means several providers share the name, and only their ids tell rows apart.
    const nameProviderIdValues = nameProviderIds.get(providerKey) ?? new Set<string>();
    nameProviderIdValues.add(entry.provider?.trim().toLowerCase() ?? "");
    nameProviderIds.set(providerKey, nameProviderIdValues);
  }

  return new Map(
    entries.map(({ entry, name, providerName, qualifiedKey, nameKey, providerKey }) => {
      let label = name || formatRawCatalogLabel(entry);
      if (name && (nameToValues.get(nameKey)?.size ?? 0) > 1) {
        label = `${name} · ${resolveDuplicateDetail(entry, {
          name,
          providerName,
          rowsUnderProvider: nameProviderToValues.get(providerKey)?.size ?? 0,
          distinctProviders: nameProviderIds.get(providerKey)?.size ?? 0,
        })}`;
      }
      return [qualifiedKey, label];
    }),
  );
}

export function formatCatalogChatModelDisplayFromLookup(
  value: string,
  displayLookup: ChatModelDisplayLookup,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return (
    displayLookup.get(normalizeAgentModelRefForConfig(trimmed)) ?? formatChatModelDisplay(trimmed)
  );
}

export function buildChatModelOptionFromLookup(
  entry: ModelCatalogEntry,
  displayLookup: ChatModelDisplayLookup,
): { value: string; label: string } {
  const value = buildQualifiedChatModelValue(entry.id, entry.provider);
  return {
    value,
    label:
      displayLookup.get(normalizeAgentModelRefForConfig(value)) ?? formatRawCatalogLabel(entry),
  };
}
