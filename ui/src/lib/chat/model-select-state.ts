import type {
  FastMode,
  GatewaySessionRow,
  ModelCatalogEntry,
  ModelCatalogResult,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import type { ModelRuntimeEntry } from "../model-runtime-choice.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelProviderId,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

registerModelControlsEnglish();

type ChatModelSelectStateInput = {
  activeSession?: GatewaySessionRow;
  agentDefaultModel?: string;
  chatModelCatalog: ModelCatalogEntry[];
  /**
   * Authored model refs (`models.providers.*.models[]`) the picker lists.
   * Non-null filters catalog-only rows out; the active selection and default
   * stay visible either way. Null keeps the catalog unfiltered.
   */
  customModelRefs?: ReadonlySet<string> | null;
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  catalogRetired?: boolean;
  catalogInitialized?: boolean;
};

type ChatModelSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  unavailableReason?: ModelCatalogEntry["unavailableReason"];
};

type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultLabel: string;
  modelOverrideSource: GatewaySessionRow["modelOverrideSource"];
  options: ChatModelSelectOption[];
};

// Preserve existing controls only when the selected request's applicability is unknown.
const FAST_MODE_PROVIDER_IDS = new Set(["anthropic", "minimax", "minimax-portal", "openai", "xai"]);

export function isChatFastModeProviderSupported(provider: string | null | undefined): boolean {
  return FAST_MODE_PROVIDER_IDS.has(normalizeChatModelProviderId(provider ?? ""));
}

function resolveModelOverrideSource(state: ChatModelSelectStateInput) {
  // A local selection is newer than the row that still reports the previous
  // provenance, so it owns the answer until the refreshed row lands.
  if (Object.hasOwn(state.modelOverrides, state.sessionKey)) {
    return state.modelOverrides[state.sessionKey] == null ? null : "user";
  }
  return state.activeSession?.modelOverrideSource;
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  const sharedOverrides = state.modelOverrides;
  if (Object.hasOwn(sharedOverrides, state.sessionKey)) {
    return normalizeChatModelOverrideValue(sharedOverrides[state.sessionKey], catalog);
  }

  const active = state.activeSession;
  return resolvePreferredServerChatModelValue(active?.model, active?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  if (state.catalogRetired || state.catalogInitialized === false) {
    return "";
  }
  if (state.modelSelectionPolicy?.restricted) {
    return state.modelSelectionPolicy.defaultModel ?? "";
  }
  const agentDefault = resolvePreferredServerChatModelValue(
    state.agentDefaultModel,
    undefined,
    state.chatModelCatalog ?? [],
  );
  if (agentDefault) {
    return agentDefault;
  }
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function normalizeChatModelAvailabilityKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf("/");
  if (separator <= 0) {
    return normalized;
  }
  return `${normalizeChatModelProviderId(normalized.slice(0, separator))}/${normalized.slice(
    separator + 1,
  )}`;
}

function catalogModelAvailabilityKey(entry: ModelCatalogEntry): string {
  return normalizeChatModelAvailabilityKey(buildQualifiedChatModelValue(entry.id, entry.provider));
}

function isCanonicalChatModelRouteValue(value: string): boolean {
  const separator = value.indexOf("/");
  if (separator <= 0) {
    return true;
  }
  const provider = value.slice(0, separator).trim().toLowerCase();
  return provider === normalizeChatModelProviderId(provider);
}

function resolveCatalogChatModelValue(value: string, options: ChatModelSelectOption[]): string {
  const exactValue = value.trim().toLowerCase();
  if (!exactValue) {
    return value;
  }
  const normalizedValue = normalizeChatModelAvailabilityKey(value);
  // Equivalent routes (for example a legacy `codex/` alias beside `openai/`)
  // keep their authored row positions; only the resolved value prefers the
  // canonical provider spelling so a committed patch uses the server's route.
  for (const disabled of [false, true]) {
    const scoped = options.filter((option) => Boolean(option.disabled) === disabled);
    const exactMatches = scoped.filter(
      (option) => option.value.trim().toLowerCase() === exactValue,
    );
    const normalizedMatches = scoped.filter(
      (option) => normalizeChatModelAvailabilityKey(option.value) === normalizedValue,
    );
    const canonical =
      exactMatches.find((option) => isCanonicalChatModelRouteValue(option.value)) ??
      normalizedMatches.find((option) => isCanonicalChatModelRouteValue(option.value));
    if (canonical) {
      return canonical.value;
    }
    const match = exactMatches[0] ?? normalizedMatches[0];
    if (match) {
      return match.value;
    }
  }
  return value;
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  // Preserve the catalog's authored order: model settings and the published
  // configuration own row order, and availability must not re-rank it.
  for (const entry of catalog) {
    if (entry.manualSelectionAllowed === false) {
      continue;
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    const value = option.value.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      ...option,
      ...(entry.available === false
        ? { disabled: true, unavailableReason: entry.unavailableReason }
        : {}),
    });
  }
  return options;
}

export function resolveChatModelUnavailableReason(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry["unavailableReason"] {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  const key = normalizeChatModelAvailabilityKey(value);
  const matches = catalog.filter((entry) => catalogModelAvailabilityKey(entry) === key);
  if (
    !matches.length ||
    matches.some((entry) => entry.available !== false || !entry.unavailableReason)
  ) {
    return undefined;
  }
  // Any recovering route can still serve the selection. Do not let an alias's
  // permanent auth failure turn a transient catalog snapshot into a send gate.
  if (matches.some((entry) => entry.unavailableReason === "cooldown")) {
    return "cooldown";
  }
  return matches.some((entry) => entry.unavailableReason === "auth-failed")
    ? "auth-failed"
    : "missing-auth";
}

export function hasChatModelCatalogSelection(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): boolean {
  const key = normalizeChatModelAvailabilityKey(
    resolvePreferredServerChatModelValue(model, provider, catalog),
  );
  return catalog.some(
    (entry) => entry.manualSelectionAllowed !== false && catalogModelAvailabilityKey(entry) === key,
  );
}

export function chatModelUnavailableMessage(
  reason: ModelRuntimeEntry["unavailableReason"],
): string | undefined {
  if (reason === "missing-auth") {
    return t("modelSetup.missingAuth");
  }
  if (reason === "unsupported-runtime") {
    return t("chat.modelControls.runtimeUnavailable");
  }
  return reason === "auth-failed"
    ? `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`
    : undefined;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const availableKeys = new Set(
    catalog.filter((entry) => entry.available !== false).map(catalogModelAvailabilityKey),
  );
  // Catalog members already have a qualified identity. Prepare one retained inventory
  // so unavailable aliases cannot disambiguate labels for their selectable sibling.
  const pickerCatalog = catalog.filter(
    (entry) => entry.available !== false || !availableKeys.has(catalogModelAvailabilityKey(entry)),
  );
  // The picker lists authored models; the resolved selection and default stay
  // visible so a catalog model already in use never disappears mid-session.
  const normalizedCustomRefs = state.customModelRefs
    ? new Set([...state.customModelRefs].map(normalizeChatModelAvailabilityKey))
    : null;
  const selectedKey = normalizeChatModelAvailabilityKey(resolveChatModelOverrideValue(state));
  const defaultKey = normalizeChatModelAvailabilityKey(resolveDefaultModelValue(state));
  const visibleCatalog =
    normalizedCustomRefs === null
      ? pickerCatalog
      : pickerCatalog.filter(
          (entry) =>
            normalizedCustomRefs.has(catalogModelAvailabilityKey(entry)) ||
            catalogModelAvailabilityKey(entry) === selectedKey ||
            catalogModelAvailabilityKey(entry) === defaultKey,
        );
  const displayLookup = buildCatalogDisplayLookup(visibleCatalog);
  const options = buildChatModelOptions(visibleCatalog, displayLookup);
  const currentOverride = resolveCatalogChatModelValue(
    resolveChatModelOverrideValue(state),
    options,
  );
  const defaultModel = resolveCatalogChatModelValue(resolveDefaultModelValue(state), options);
  const defaultLabel = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultLabel: defaultModel ? `Default (${defaultLabel})` : "Default model",
    modelOverrideSource: resolveModelOverrideSource(state),
    options,
  };
}

export function normalizeChatFastModeInput(raw: string): FastMode | undefined {
  if (raw === "auto" || raw === "ultrafast") {
    return raw;
  }
  if (raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  return undefined;
}

export function resolveChatFastModeStatus(session: GatewaySessionRow | undefined): string {
  const mode = session?.effectiveFastMode ?? session?.fastMode;
  const value =
    mode === "auto"
      ? t("chat.commandResults.fast.autoValue", {
          seconds: String(session?.fastAutoOnSeconds ?? 60),
        })
      : mode === "ultrafast"
        ? t("chat.modelControls.ultrafast")
        : t(mode === true ? "chat.commandResults.fast.on" : "chat.commandResults.fast.off");
  const source = session?.effectiveFastModeSource;
  const sourceSuffix =
    source === "session"
      ? t("chat.commandResults.fast.sourceSession")
      : source === "agent"
        ? t("chat.commandResults.fast.sourceAgent")
        : source === "config"
          ? t("chat.commandResults.fast.sourceModel")
          : source === "default"
            ? t("chat.commandResults.fast.sourceDefault")
            : "";
  return `${t("chat.commandResults.fast.current", { value })}${sourceSuffix}.`;
}
