import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import type {
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveModelRuntimeEntry, type ModelRuntimeEntry } from "../model-runtime-choice.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { sessionModelMatchesDefaults } from "../session-model-defaults.ts";
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";
import { buildQualifiedChatModelValue, normalizeChatModelOverrideValue } from "./model-ref.ts";

type ThinkingSessionDefaults = SessionsListResult["defaults"] | undefined;

type ChatThinkingSelection = {
  source: "override" | "default";
  value: string;
  displayLabel: string;
} & ({ kind: "anchored"; index: number } | { kind: "unanchored" });

export type ChatThinkingTarget = Pick<
  GatewaySessionRow,
  | "agentRuntime"
  | "model"
  | "modelProvider"
  | "thinkingDefault"
  | "thinkingLevel"
  | "thinkingLevels"
  | "thinkingOptions"
>;

export type ChatThinkingSelectState = {
  selection: ChatThinkingSelection;
  inherited: { value: string; displayLabel: string };
  options: Array<{ value: string; label: string }>;
};

type ThinkingProfile = Pick<
  ChatThinkingTarget,
  "agentRuntime" | "thinkingLevels" | "thinkingDefault"
> & {
  reasoning?: boolean;
};

export function resolveThinkingProfileForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[],
): ThinkingProfile | undefined {
  // A partial session identity cannot borrow its missing half from defaults.
  const target = session?.model || session?.modelProvider ? session : defaults;
  const catalogEntry = resolveThinkingCatalogEntry(
    catalog,
    target?.modelProvider ?? null,
    target?.model ?? null,
    session?.agentRuntime?.id,
  );
  const candidates: Array<
    | Pick<
        ChatThinkingTarget,
        "agentRuntime" | "thinkingLevels" | "thinkingOptions" | "thinkingDefault"
      >
    | undefined
  > = [
    session,
    sessionModelMatchesDefaults(session, defaults) ? defaults : undefined,
    catalogEntry,
  ];
  const profile = candidates.find(
    (candidate) =>
      candidate?.thinkingLevels !== undefined ||
      candidate?.thinkingOptions !== undefined ||
      candidate?.thinkingDefault !== undefined,
  );
  if (!profile) {
    return undefined;
  }
  return {
    agentRuntime: profile.agentRuntime,
    thinkingLevels:
      profile.thinkingLevels ??
      profile.thinkingOptions?.map((label) => ({
        id: normalizeThinkingOptionValue(label),
        label,
      })),
    thinkingDefault: profile.thinkingDefault,
    reasoning: catalogEntry?.reasoning,
  };
}

/**
 * While a user model selection is pending, the session row still carries the
 * previous model's identity and thinking fields. Rebase the thinking target onto
 * the optimistic selection so controls offer the pending model's levels from the
 * local catalog instead of waiting for the patched row.
 *
 * The rebased target keeps the row's runtime pin; a pending selection whose
 * catalog entry serves only a different runtime stays unmatched and fails closed
 * until the patch lands (modelOverrides carries no runtime of its own).
 *
 * Returns undefined when no optimistic selection exists (the row target stays
 * authoritative). A pending selection the catalog cannot identify keeps the
 * pending model id without row thinking facts, so profile resolution finds no
 * candidate and the control fails closed until the patch settles.
 */
export function resolvePendingModelThinkingTarget(params: {
  catalog: readonly ModelCatalogEntry[];
  defaults?: ThinkingSessionDefaults;
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  session: ChatThinkingTarget | undefined;
  sessionKey: string;
}): ChatThinkingTarget | undefined {
  if (!Object.hasOwn(params.modelOverrides, params.sessionKey)) {
    return undefined;
  }
  const override = params.modelOverrides[params.sessionKey];
  const {
    thinkingDefault: _thinkingDefault,
    thinkingLevel: _thinkingLevel,
    thinkingLevels: _thinkingLevels,
    thinkingOptions: _thinkingOptions,
    ...row
  } = params.session ?? {};
  if (override === null) {
    // Clearing to the default keeps the defaults row's own identity verbatim so
    // its thinking facts stay reachable even when the catalog lacks the model.
    return {
      ...row,
      model: params.defaults?.model?.trim() ?? "",
      modelProvider: params.defaults?.modelProvider ?? undefined,
    };
  }
  const value = normalizeChatModelOverrideValue(override, params.catalog);
  const identity = resolvePendingModelIdentity(value, params.catalog);
  return {
    ...row,
    model: identity?.model ?? value,
    modelProvider: identity?.provider,
  };
}

function resolvePendingModelIdentity(
  value: string,
  catalog: readonly ModelCatalogEntry[],
): { provider: string; model: string } | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  // A qualified value names provider/model directly; a router provider's deep
  // id can carry the same text as another provider's qualified value, so the
  // qualified match wins and bare ids only resolve when exactly one exists.
  // Runtime variants share one provider/model identity; either supplies it.
  const qualified = new Map<string, { provider: string; model: string }>();
  const bare = new Map<string, { provider: string; model: string }>();
  for (const entry of catalog) {
    const identity = { provider: entry.provider, model: entry.id };
    const key = `${entry.provider.trim().toLowerCase()}\0${entry.id.trim().toLowerCase()}`;
    if (
      buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase() === normalized
    ) {
      qualified.set(key, identity);
    } else if (entry.id.trim().toLowerCase() === normalized) {
      bare.set(key, identity);
    }
  }
  return pickUniqueIdentity(qualified) ?? pickUniqueIdentity(bare);
}

function pickUniqueIdentity(
  identities: Map<string, { provider: string; model: string }>,
): { provider: string; model: string } | undefined {
  return identities.size === 1 ? [...identities.values()][0] : undefined;
}

export function resolveThinkingCommandArgOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string[] {
  const levels = resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels ?? [];
  const options = levels.map((level) => normalizeThinkingOptionValue(level.id));
  return options.length > 0
    ? ["default", ...new Set(options.filter((option) => option && option !== "default"))]
    : [];
}

export function formatThinkingCommandOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string {
  const levels = resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels;
  if (levels === undefined) {
    return t("common.unknown");
  }
  const options = levels.map((level) => level.label);
  return options.length === 0
    ? t("common.none")
    : (options.includes("default") ? options : ["default", ...options]).join(", ");
}

export function resolveThinkingLevelInput(
  rawLevel: string,
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
): string | undefined {
  const normalized = normalizeThinkLevel(rawLevel);
  if (normalized) {
    return normalized;
  }
  const rawKey = normalizeLowercaseStringOrEmpty(rawLevel);
  return (resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels ?? [])
    .map((option) => ({
      id: normalizeThinkingOptionValue(option.id),
      label: normalizeLowercaseStringOrEmpty(option.label),
    }))
    .find((option) => option.id === rawKey || option.label === rawKey)?.id;
}

export function isThinkingLevelOptionForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  level: string,
  catalog: readonly ModelCatalogEntry[] = [],
): boolean | undefined {
  return resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels?.some(
    (option) => {
      const id = normalizeThinkingOptionValue(option.id);
      return id === level || normalizeThinkLevel(option.label) === level;
    },
  );
}

export function resolveCurrentThinkingLevel(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  models: ModelCatalogEntry[],
): string {
  const persisted = session?.thinkingLevel?.trim();
  const profile = resolveThinkingProfileForSession(session, defaults, models);
  if (persisted) {
    return (
      profile?.thinkingLevels?.find(
        (level) =>
          normalizeThinkingOptionValue(level.id) === normalizeThinkingOptionValue(persisted),
      )?.label ?? persisted
    );
  }
  return profile?.thinkingDefault ?? t("common.unknown");
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const level of levels) {
    const normalizedValue = normalizeThinkingOptionValue(level.id);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, level.label),
    );
  }
  return options;
}

function resolveThinkingCatalogEntry(
  catalog: readonly ModelCatalogEntry[],
  provider: string | null,
  model: string | null,
  runtimeId?: string,
): ModelRuntimeEntry | undefined {
  const runtime = runtimeId?.trim();
  const entry = catalog.find((candidate) => {
    const entryRuntime = candidate.agentRuntime?.id?.trim();
    // Agent-scoped catalogs must not supply another runtime's session thinking profile.
    return (
      candidate.provider === provider &&
      candidate.id === model &&
      (!runtime ||
        !entryRuntime ||
        runtime === entryRuntime ||
        candidate.runtimeChoices?.some((choice) => choice.agentRuntime.id === runtime))
    );
  });
  return runtime && (entry?.agentRuntime?.id || entry?.runtimeChoices?.length)
    ? resolveModelRuntimeEntry(entry, runtime)
    : entry;
}

export function resolveChatThinkingSelectState(params: {
  catalog: readonly ModelCatalogEntry[];
  defaults?: SessionsListResult["defaults"];
  session?: ChatThinkingTarget;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
}): ChatThinkingSelectState {
  const session =
    params.session ??
    params.sessionsResult?.sessions?.find((row) =>
      areUiSessionKeysEquivalent(row.key, params.sessionKey),
    );
  const persisted = session?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = params.defaults ?? params.sessionsResult?.defaults;
  const profile = resolveThinkingProfileForSession(session, defaults, params.catalog);
  const supportedLevels = profile?.thinkingLevels ?? [];
  const nonReasoningOffOnly =
    profile?.reasoning === false &&
    supportedLevels.length > 0 &&
    supportedLevels.every(
      (level) => normalizeThinkingOptionValue(level.id || level.label) === "off",
    );
  const levels = nonReasoningOffOnly ? [] : supportedLevels;
  const defaultLevel = profile?.thinkingDefault ?? "";
  const effectiveOverride = nonReasoningOffOnly && currentOverride === "off" ? "" : currentOverride;
  const options = buildThinkingOptions(levels);
  const defaultValue = normalizeThinkingOptionValue(defaultLevel);
  const inherited = {
    value: defaultValue,
    displayLabel: formatInheritedThinkingLabel(defaultLevel),
  };
  const selectionValue = effectiveOverride || defaultValue;
  const selectionIndex = options.findIndex((option) => option.value === selectionValue);
  const source = effectiveOverride ? "override" : "default";
  const displayLabel = effectiveOverride
    ? (options[selectionIndex]?.label ?? formatThinkingOverrideLabel(effectiveOverride))
    : inherited.displayLabel;
  return {
    selection:
      selectionIndex >= 0
        ? { kind: "anchored", source, value: selectionValue, displayLabel, index: selectionIndex }
        : { kind: "unanchored", source, value: selectionValue, displayLabel },
    inherited,
    options,
  };
}

export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  if (!effectiveLevel) {
    return t("common.unknown");
  }
  const normalized = normalizeThinkingOptionValue(effectiveLevel);
  return `Inherited: ${formatThinkingLevelDisplayLabel(normalized)}`;
}

export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") {
    return "Off";
  }
  return formatThinkingLevelDisplayLabel(label?.trim() || normalized);
}

function formatThinkingLevelDisplayLabel(value: string): string {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (["on", "enable", "enabled"].includes(raw)) {
    return "On";
  }
  const normalized = normalizeThinkingOptionValue(value);
  switch (normalized) {
    case "adaptive":
      return "Adaptive";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    case "ultra":
      return "Ultra";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
