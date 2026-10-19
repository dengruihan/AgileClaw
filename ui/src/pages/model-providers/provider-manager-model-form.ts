import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { t } from "../../i18n/index.ts";
import "../../components/multi-select-registration.ts";

/** Input modalities a model entry can advertise. */
const MODEL_INPUT_TYPES = ["text", "image", "audio", "video", "document"] as const;

const MODEL_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Canonical thinking levels a model entry can map to provider effort values. */
export const MODEL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

/** Raw input value for a thinking level; a null level stays blank but hidden. */
function thinkingInputValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Raw input value for a number field; blank means inherit or omit. */
function numberInputValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Coerces a form value to a finite number; blank stays undefined. */
function numberValue(value: unknown, min: number): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : undefined;
  return parsed !== undefined && Number.isFinite(parsed) && parsed >= min ? parsed : undefined;
}

/**
 * Normalizes an edited draft into a config model entry: numbers coerce from
 * input strings, blank optional fields drop so the entry inherits catalog
 * and provider defaults, and fields the form does not show ride along.
 * `original` is the authored entry the draft started from, if any.
 * `thinkingPrefill` is the catalog map the form displayed for a catalog-only
 * row; an untouched prefill stays inherited instead of being frozen into
 * config, because an authored map replaces the catalog map wholesale.
 */
export function modelConfigEntry(
  draft: Record<string, unknown>,
  original: Record<string, unknown> | undefined,
  thinkingPrefill: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const text = (value: unknown) => (typeof value === "string" ? value : "").trim();
  const entry: Record<string, unknown> = { ...draft, id: text(draft.id), name: text(draft.name) };
  for (const key of ["contextWindow", "maxTokens"] as const) {
    const parsed = numberValue(draft[key], 1);
    if (parsed === undefined) {
      delete entry[key];
    } else {
      entry[key] = parsed;
    }
  }
  const input = Array.isArray(draft.input)
    ? draft.input.filter((value): value is string => typeof value === "string")
    : undefined;
  if (!input?.length) {
    delete entry.input;
  } else {
    entry.input = input;
  }
  // A fresh draft carries no reasoning key, so a false value can only come
  // from the user toggling the checkbox; both cases stay explicit overrides.
  // An untouched catalog row keeps inheriting its capability instead.
  if (draft.reasoning !== undefined || original?.reasoning !== undefined) {
    entry.reasoning = draft.reasoning === true;
  } else {
    delete entry.reasoning;
  }
  if (isRecord(draft.cost)) {
    const cost: Record<string, unknown> = { ...draft.cost };
    let hasRate = false;
    for (const key of MODEL_COST_FIELDS) {
      // Zero is a valid free-model rate; only blanks drop the key.
      const parsed = numberValue(draft.cost[key], 0);
      if (parsed === undefined) {
        delete cost[key];
      } else {
        cost[key] = parsed;
        hasRate = true;
      }
    }
    if (hasRate) {
      entry.cost = cost;
    } else {
      delete entry.cost;
    }
  } else {
    delete entry.cost;
  }
  if (isRecord(draft.thinkingLevelMap)) {
    const userEdited =
      original?.thinkingLevelMap === undefined &&
      JSON.stringify(draft.thinkingLevelMap) !== JSON.stringify(thinkingPrefill);
    if (original?.thinkingLevelMap !== undefined || userEdited) {
      const map: Record<string, unknown> = {};
      for (const [level, value] of Object.entries(draft.thinkingLevelMap)) {
        if (value === null) {
          // A null level is hidden from the picker, not reset to its name.
          map[level] = null;
        } else if (typeof value === "string" && value.trim() !== "") {
          map[level] = value.trim();
        }
      }
      // A fully cleared map stays as an explicit empty override: falling back
      // to the catalog map would silently restore what the user just erased.
      entry.thinkingLevelMap = map;
    } else {
      delete entry.thinkingLevelMap;
    }
  } else {
    delete entry.thinkingLevelMap;
  }
  return entry;
}

/** Curated add/edit model form body for one provider-manager dialog. */
export function providerModelForm(params: {
  disabled: boolean;
  draft: Record<string, unknown>;
  /** Editing an existing row locks its ID; new entries choose their own. */
  lockId: boolean;
  onCostField: (key: (typeof MODEL_COST_FIELDS)[number], value: string) => void;
  onField: (patch: Record<string, unknown>) => void;
  onThinkingField: (level: ModelThinkingLevel, value: string) => void;
}) {
  const { disabled, draft, lockId, onCostField, onField, onThinkingField } = params;
  const cost = isRecord(draft.cost) ? draft.cost : {};
  const input = Array.isArray(draft.input) ? draft.input.map(String) : [];
  return html` <div class="provider-manager__fields">
      <label class="field"
        ><span>${t("modelProviders.manager.modelName")}</span
        ><input
          name="name"
          required
          .value=${String(draft.name ?? "")}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            onField({ name: (event.target as HTMLInputElement).value });
          }}
      /></label>
      <label class="field"
        ><span>${t("modelProviders.manager.modelIdLabel")}</span
        ><input
          name="id"
          required
          .value=${String(draft.id ?? "")}
          ?disabled=${disabled || lockId}
          @input=${(event: Event) => {
            onField({ id: (event.target as HTMLInputElement).value });
          }}
      /></label>
      <label class="field"
        ><span>${t("modelProviders.manager.contextWindow")}</span
        ><input
          name="contextWindow"
          type="number"
          min="1"
          step="1"
          .value=${numberInputValue(draft.contextWindow)}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            onField({ contextWindow: (event.target as HTMLInputElement).value });
          }}
      /></label>
      <label class="field"
        ><span>${t("modelProviders.manager.maxOutputTokens")}</span
        ><input
          name="maxTokens"
          type="number"
          min="1"
          step="1"
          .value=${numberInputValue(draft.maxTokens)}
          ?disabled=${disabled}
          @input=${(event: Event) => {
            onField({ maxTokens: (event.target as HTMLInputElement).value });
          }}
      /></label>
    </div>
    <details class="provider-manager__advanced">
      <summary>${t("modelProviders.manager.advanced")}</summary>
      <div class="provider-manager__fields">
        <div class="field">
          <span>${t("modelProviders.manager.inputTypes")}</span>
          <openclaw-multi-select
            .options=${MODEL_INPUT_TYPES.map((value) => ({ value, label: value }))}
            .value=${input}
            .disabled=${disabled}
            accessibleLabel=${t("modelProviders.manager.inputTypes")}
            .onChange=${(value: string[]) => {
              onField({ input: value });
            }}
          ></openclaw-multi-select>
        </div>
        <label class="field provider-manager__toggle"
          ><input
            type="checkbox"
            name="reasoning"
            .checked=${draft.reasoning === true}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              onField({ reasoning: (event.target as HTMLInputElement).checked });
            }}
          /><span>${t("modelProviders.manager.reasoningSupport")}</span></label
        >
        <fieldset class="provider-manager__thinking">
          <legend>${t("modelProviders.manager.thinkingLevels.title")}</legend>
          <p class="muted provider-manager__thinking-help">
            ${t("modelProviders.manager.thinkingLevels.help")}
          </p>
          ${MODEL_THINKING_LEVELS.map((level) => {
            const levelValue = isRecord(draft.thinkingLevelMap)
              ? draft.thinkingLevelMap[level]
              : undefined;
            return html`<label class="field"
              ><span>${t(`modelProviders.manager.thinkingLevels.${level}`)}</span
              ><input
                name="thinking-${level}"
                .value=${thinkingInputValue(levelValue)}
                placeholder=${t(
                  levelValue === null
                    ? "modelProviders.manager.thinkingLevels.hidden"
                    : "modelProviders.manager.thinkingLevels.placeholder",
                )}
                ?disabled=${disabled}
                @input=${(event: Event) => {
                  onThinkingField(level, (event.target as HTMLInputElement).value);
                }}
            /></label>`;
          })}
        </fieldset>
        <fieldset class="provider-manager__cost">
          <legend>${t("modelProviders.manager.costTitle")}</legend>
          ${MODEL_COST_FIELDS.map(
            (key) =>
              html`<label class="field"
                ><span>${t(`modelProviders.manager.cost.${key}`)}</span
                ><input
                  name="cost-${key}"
                  type="number"
                  min="0"
                  step="any"
                  .value=${numberInputValue(cost[key])}
                  ?disabled=${disabled}
                  @input=${(event: Event) => {
                    onCostField(key, (event.target as HTMLInputElement).value);
                  }}
              /></label>`,
          )}
        </fieldset>
      </div>
    </details>`;
}
