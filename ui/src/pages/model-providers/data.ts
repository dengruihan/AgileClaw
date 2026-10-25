import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type {
  FastMode,
  ModelAuthStatusProvider,
  ModelAuthStatusProfile,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  ModelCatalogProviderOutcome,
} from "../../api/types.ts";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import {
  canonicalModelAuthProviderId,
  isMonitoredAuthProvider,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import type { ModelCatalogPresentation } from "../../lib/model-catalog-store.ts";

type ModelProviderAuthKind = "ok" | "expiring" | "expired" | "missing" | "api-key";

type ModelProviderAuthSummary = {
  kind: ModelProviderAuthKind;
  expiryLabel?: string;
};

export type ModelProviderCard = {
  /** Canonical provider id used for icon + label lookup. */
  id: string;
  /** Exact config map key; provider ids are otherwise normalized for display/runtime use. */
  configKey?: string;
  configAuthMode?: string;
  apiKeySupported?: boolean;
  /** Provider ids that own credentials merged into this card. */
  credentialProviderIds: string[];
  displayName: string;
  auth?: ModelProviderAuthSummary;
  profiles: ModelAuthStatusProfile[];
  /** Gateway auth owner used for priority changes to each visible profile. */
  profileProviderIds: Record<string, string>;
  apiKey?: ModelAuthStatusProvider["apiKey"];
  hasConfigApiKey: boolean;
  modelCount: number;
  availableModelCount: number;
  catalogStatus?: ModelCatalogProviderOutcome["status"];
  checkingModels?: boolean;
  /** Auth-status revision used to invalidate inspected credentials without a config change. */
  credentialRevision?: number;
};

type ModelProviderCardsInput = {
  authStatus: ModelAuthStatusResult | null;
  models: ModelCatalogEntry[] | null;
  providerOutcomes?: ModelCatalogProviderOutcome[];
  pendingProviders?: readonly string[];
  configProviderIds?: string[] | null;
  configApiKeyProviderIds?: string[] | null;
  configProviderAuthModes?: Record<string, string> | null;
};

type CardDraft = {
  ids: Set<string>;
  card: ModelProviderCard;
  hasModelAuth: boolean;
  catalogOutcome?: ModelCatalogProviderOutcome;
};

const CATALOG_OUTCOME_PRIORITY = {
  provider: ["auth-rejected", "unavailable", "ready"],
  profile: ["ready", "auth-rejected", "unavailable"],
} as const;

function findDraft(drafts: CardDraft[], ids: string[]): CardDraft | undefined {
  return drafts.find((draft) => ids.some((id) => draft.ids.has(id)));
}

function ensureDraft(drafts: CardDraft[], id: string, displayName: string): CardDraft {
  const existing = findDraft(drafts, [id]);
  if (existing) {
    return existing;
  }
  const draft: CardDraft = {
    ids: new Set([id]),
    card: {
      id,
      displayName,
      profiles: [],
      profileProviderIds: {},
      credentialProviderIds: [],
      hasConfigApiKey: false,
      modelCount: 0,
      availableModelCount: 0,
    },
    hasModelAuth: false,
  };
  drafts.push(draft);
  return draft;
}

function addProviderId(ids: string[], provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (normalized && !ids.some((candidate) => normalizeProviderId(candidate) === normalized)) {
    ids.push(provider);
  }
}

/**
 * Builds the provider card list. A provider qualifies as "configured" when it
 * has model-provider auth or catalog models (the default models.list view only contains
 * configured or auth-backed entries). Model presence alone is enough: a configured API-key provider
 * with a broken credential reports available=false and no auth row, and the
 * page must surface that state rather than hide the provider.
 */
export function buildModelProviderCards(input: ModelProviderCardsInput): ModelProviderCard[] {
  const drafts: CardDraft[] = [];
  const apiKeyCapabilities = new Map<string, boolean>();
  for (const capability of input.authStatus?.providerCapabilities ?? []) {
    const id = canonicalModelAuthProviderId(capability.provider);
    if (!id) {
      continue;
    }
    apiKeyCapabilities.set(id, apiKeyCapabilities.get(id) === true || capability.apiKeySupported);
  }

  for (const provider of input.configProviderIds ?? []) {
    const id = canonicalModelAuthProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configKey ??= provider;
    }
  }
  for (const provider of input.configApiKeyProviderIds ?? []) {
    const id = canonicalModelAuthProviderId(provider);
    if (id) {
      const card = ensureDraft(drafts, id, providerDisplayLabel(id)).card;
      card.configKey = provider;
      card.hasConfigApiKey = true;
      addProviderId(card.credentialProviderIds, provider);
    }
  }
  for (const [provider, authMode] of Object.entries(input.configProviderAuthModes ?? {})) {
    const id = canonicalModelAuthProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.configAuthMode = authMode;
    }
  }

  for (const provider of input.pendingProviders ?? []) {
    const id = canonicalModelAuthProviderId(provider);
    if (id) {
      ensureDraft(drafts, id, providerDisplayLabel(id)).card.checkingModels = true;
    }
  }

  for (const outcome of input.providerOutcomes ?? []) {
    const id = canonicalModelAuthProviderId(outcome.provider);
    if (!id) {
      continue;
    }
    const draft = ensureDraft(drafts, id, providerDisplayLabel(id));
    const current = draft.catalogOutcome;
    const providerWide = outcome.profileId === undefined;
    const priority = CATALOG_OUTCOME_PRIORITY[providerWide ? "provider" : "profile"];
    // Unscoped diagnostics own the provider card. Within profile-scoped results,
    // one ready profile keeps a rejected sibling from hiding the usable catalog.
    if (
      !current ||
      (providerWide !== (current.profileId === undefined)
        ? providerWide
        : priority.indexOf(outcome.status) < priority.indexOf(current.status))
    ) {
      draft.catalogOutcome = outcome;
    }
  }

  for (const entry of input.models ?? []) {
    const id = canonicalModelAuthProviderId(entry.provider);
    if (!id) {
      continue;
    }
    const draft = ensureDraft(drafts, id, providerDisplayLabel(id));
    draft.card.modelCount += 1;
    if (entry.available === true) {
      draft.card.availableModelCount += 1;
    }
  }

  for (const provider of input.authStatus?.providers ?? []) {
    const id = canonicalModelAuthProviderId(provider.provider);
    if (!id) {
      continue;
    }
    const draft = findDraft(drafts, [id]) ?? ensureDraft(drafts, id, providerDisplayLabel(id));
    draft.card.displayName = provider.displayName || draft.card.displayName;
    draft.card.profiles.push(...provider.profiles);
    if (provider.profiles.length > 0) {
      const authProvider = provider.authProvider || provider.provider;
      for (const profile of provider.profiles) {
        draft.card.profileProviderIds[profile.profileId] = authProvider;
      }
    }
    if (provider.apiKey || provider.profiles.length > 0) {
      addProviderId(draft.card.credentialProviderIds, provider.provider);
    }
    draft.card.apiKey ??= provider.apiKey;
    // Generic auth discovery also includes tool-only API keys; those alone do not make a model card.
    draft.hasModelAuth ||= isMonitoredAuthProvider(provider) || apiKeyCapabilities.has(id);
  }

  for (const provider of listEffectiveModelAuthProviders(input.authStatus?.providers ?? [])) {
    const draft = findDraft(drafts, [canonicalModelAuthProviderId(provider.provider)]);
    if (draft) {
      draft.card.auth = {
        kind: provider.status === "static" ? "api-key" : provider.status,
        ...(provider.expiry?.label ? { expiryLabel: provider.expiry.label } : {}),
      };
    }
  }

  return drafts
    .filter(
      (draft) =>
        draft.hasModelAuth ||
        (input.configProviderIds ?? []).some(
          (id) => canonicalModelAuthProviderId(id) === draft.card.id,
        ) ||
        draft.card.modelCount > 0 ||
        Boolean(draft.catalogOutcome) ||
        draft.card.checkingModels,
    )
    .map((draft) => {
      const apiKeySupported = apiKeyCapabilities.get(draft.card.id);
      return Object.assign(
        {},
        draft.card,
        { credentialRevision: input.authStatus?.ts },
        draft.catalogOutcome ? { catalogStatus: draft.catalogOutcome.status } : {},
        apiKeySupported === undefined ? {} : { apiKeySupported },
      );
    })
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

export type DefaultModelSelection = {
  primary: string;
  fallbacks: string[];
  /** null = automatic/unset; empty string = explicitly disabled. */
  utilityModel: string | null;
  /** Unset or null disables decisions globally. */
  decisionModel?: string | null;
};

export type ModelPickerEntry = ModelCatalogEntry & { selectionRef?: string };
export type ModelBehaviorConfig = {
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
};
export type DefaultsDraft = DefaultModelSelection & ModelBehaviorConfig;

export function resolveDefaultModelPresentation(
  catalog: ModelCatalogPresentation,
  configured: DefaultsDraft,
  draft: DefaultsDraft | null,
): { defaults: DefaultsDraft; configuredModels: ModelPickerEntry[] } {
  if (catalog.retired || catalog.modelSelectionPolicy?.restricted) {
    return {
      defaults: {
        ...configured,
        primary: catalog.modelSelectionPolicy?.defaultModel ?? "",
        fallbacks: [],
        utilityModel: null,
        decisionModel: null,
      },
      configuredModels: catalog.models.filter((model) => model.manualSelectionAllowed !== false),
    };
  }
  const defaults = draft ?? configured;
  return {
    defaults,
    configuredModels: buildSelectableDefaultModels(
      catalog.hasSnapshot ? catalog.models : null,
      defaults,
    ),
  };
}

export function modelCatalogRef(model: ModelPickerEntry): string {
  if (model.selectionRef !== undefined) {
    return model.selectionRef;
  }
  return model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
}

function buildSelectableDefaultModels(
  models: ModelCatalogEntry[] | null,
  selection: DefaultModelSelection,
): ModelPickerEntry[] {
  const selected = new Set<string>(
    [selection.primary, ...selection.fallbacks, selection.utilityModel].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const selectable: ModelPickerEntry[] = (models ?? []).filter(
    (model) => model.available !== false || selected.has(modelCatalogRef(model)),
  );
  const seen = new Set(selectable.map(modelCatalogRef));
  // An unavailable catalog cannot establish that a saved model is unavailable.
  const availability = models === null ? {} : { available: false as const };
  for (const ref of selected) {
    if (seen.has(ref)) {
      continue;
    }
    const { model: modelRef, profile } = splitTrailingAuthProfile(ref);
    if (profile) {
      const match = (models ?? []).find((model) => modelCatalogRef(model) === modelRef);
      if (match) {
        selectable.push({ ...match, selectionRef: ref });
        continue;
      }
    }
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) {
      const normalized = ref.trim().toLowerCase();
      const match = (models ?? []).find(
        (model) =>
          model.alias?.trim().toLowerCase() === normalized || model.id.trim() === ref.trim(),
      );
      selectable.push({
        ...(match ?? { provider: "", id: ref, name: ref, ...availability }),
        selectionRef: ref,
      });
      continue;
    }
    selectable.push({
      provider: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      name: ref,
      ...availability,
    });
  }
  return selectable;
}

export function readModelProviderConfig(config: Record<string, unknown> | null): {
  providerIds: string[];
  apiKeyProviderIds: string[];
  providerAuthModes: Record<string, string>;
  defaults: DefaultModelSelection;
} {
  const models = asRecord(config?.models);
  const providers = asRecord(models?.providers);
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const modelObject = asRecord(model);
  const primary =
    typeof model === "string"
      ? model
      : typeof modelObject?.primary === "string"
        ? modelObject.primary
        : "";
  const fallbacks = Array.isArray(modelObject?.fallbacks)
    ? modelObject.fallbacks.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    providerIds: Object.keys(providers ?? {}),
    apiKeyProviderIds: Object.entries(providers ?? {})
      .filter(([, value]) => {
        const provider = asRecord(value);
        return provider ? Object.hasOwn(provider, "apiKey") && provider.apiKey != null : false;
      })
      .map(([id]) => id),
    providerAuthModes: Object.fromEntries(
      Object.entries(providers ?? {}).flatMap(([id, value]) => {
        const auth = asRecord(value)?.auth;
        return typeof auth === "string" ? [[id, auth]] : [];
      }),
    ),
    defaults: {
      primary,
      fallbacks,
      utilityModel: typeof defaults?.utilityModel === "string" ? defaults.utilityModel : null,
      ...(typeof defaults?.decisionModel === "string"
        ? { decisionModel: defaults.decisionModel }
        : {}),
    },
  };
}

export type ProviderOption = { id: string; displayName: string };

type ModelProviderCapability = NonNullable<ModelAuthStatusResult["providerCapabilities"]>[number];

export function buildUnconfiguredProviderOptions(
  capabilities: ModelProviderCapability[] | undefined,
  configuredProviderIds: Iterable<string>,
): ProviderOption[] {
  const configured = new Set(Array.from(configuredProviderIds, canonicalModelAuthProviderId));
  const options = new Map<string, ProviderOption>();
  for (const capability of capabilities ?? []) {
    const id = canonicalModelAuthProviderId(capability.provider);
    if (capability.quickApiKeySetup && id && !configured.has(id) && !options.has(id)) {
      options.set(id, { id, displayName: providerDisplayLabel(id) });
    }
  }
  return [...options.values()].toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}
