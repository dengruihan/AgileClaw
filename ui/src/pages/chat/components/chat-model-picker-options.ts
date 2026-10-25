import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import {
  formatRawProviderLabel,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ModelRuntimeEntry } from "../../../lib/model-runtime-choice.ts";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";

registerModelControlsEnglish();

export type ChatModelPickerOption = {
  agentRuntimeId?: string;
  /** Null is an unknown configured base; undefined is an ordinary model-only row. Both clear a prior pin. */
  agentRuntime?: string | null;
  /** Only explicit alternatives pin a runtime; configured base rows follow current routing. */
  runtimeOverride?: string;
  commitValue: string;
  contextTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  unavailableReason?: ModelRuntimeEntry["unavailableReason"];
  isDefault: boolean;
  label: string;
  provider: string;
  supportsTools?: boolean;
  value: string;
};

export function modelPickerOptionKey(option: ChatModelPickerOption): string {
  return JSON.stringify([option.value, option.agentRuntime ?? null]);
}

export function isModelPickerOptionSelected(
  option: ChatModelPickerOption,
  value: string,
  agentRuntime?: string,
): boolean {
  return (
    (option.value === value || (option.isDefault && value === "")) &&
    (option.agentRuntime === undefined || (option.agentRuntime ?? undefined) === agentRuntime)
  );
}

export type ChatModelPickerTargetGroup = {
  errorLabel: string;
  id: string;
  label: string;
  options: readonly { label: string; value: string }[];
  status: "loading" | "ready" | "error";
};

function formatModelLabel(option: ChatModelPickerOption): string {
  // Grouped rows already carry the provider as the section heading, so a
  // catalog name that repeats it as a prefix or trailing "(Provider)" reads twice.
  const prefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (option.label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return option.label.slice(prefix.length + 1);
    }
    const suffix = ` (${prefix.toLowerCase()})`;
    if (option.label.toLowerCase().endsWith(suffix)) {
      return option.label.slice(0, option.label.length - suffix.length);
    }
  }
  return option.label;
}

export function renderChatModelProviderIcon(provider: string) {
  return renderProviderBrandIcon(provider);
}

/** Simplified model row: name and selected check; state stays in title/aria. */
export function renderChatModelPickerOption(params: {
  disabled: boolean;
  entry: ChatModelPickerOption;
  index: number;
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  sessionModelPinned: boolean;
  onSelect: (entry: ChatModelPickerOption, event: MouseEvent) => void;
  onModelSetup?: () => void;
}) {
  const selected = isModelPickerOptionSelected(
    params.entry,
    params.selectedModelValue,
    params.selectedAgentRuntime,
  );
  const modelLabel = formatModelLabel(params.entry);
  const runtimeLabel =
    formatModelRuntimeLabel(params.entry.provider, params.entry.agentRuntimeId)?.label ?? "";
  const chatOnlyHelp =
    params.entry.supportsTools === false ? t("chat.modelControls.chatOnlyHelp") : "";
  // A session with a recorded pin (even one pinned to the default's own value)
  // can always return to Default when the default model is unavailable: the row
  // commits the reset, not that model. Otherwise an unavailable default routes
  // to sign-in like any other unavailable row.
  const resetsPin = params.entry.isDefault && params.sessionModelPinned;
  const needsAuth =
    params.entry.disabled &&
    (params.entry.unavailableReason === "missing-auth" ||
      params.entry.unavailableReason === "auth-failed");
  const onModelSetup = needsAuth ? params.onModelSetup : undefined;
  const accessibleStatus = needsAuth
    ? t("modelSetup.candidates.signInNeeded")
    : params.entry.unavailableReason === "unsupported-runtime"
      ? t("chat.modelControls.runtimeUnavailable")
      : "";
  return html`<button
    class="chat-controls__inline-select-option chat-controls__model-option ${
      selected ? "chat-controls__inline-select-option--selected" : ""
    }"
    data-chat-model-option=${params.entry.value}
    data-chat-model-runtime=${params.entry.agentRuntime ?? nothing}
    data-chat-model-default=${params.entry.isDefault ? "true" : nothing}
    data-chat-model-index=${params.index}
    data-chat-model-name=${modelLabel.toLocaleLowerCase()}
    role="option"
    aria-selected=${selected ? "true" : "false"}
    title=${accessibleStatus || chatOnlyHelp || nothing}
    aria-label=${[modelLabel, runtimeLabel, accessibleStatus, chatOnlyHelp]
      .filter(Boolean)
      .join(". ")}
    type="button"
    ?disabled=${params.disabled || (params.entry.disabled && !onModelSetup && !resetsPin)}
    @click=${(event: MouseEvent) => {
      // A sign-in-gated model must not dead-end: the row routes to Model
      // Setup instead of silently ignoring the click on a disabled button.
      if (params.entry.disabled && !resetsPin) {
        event.stopPropagation();
        onModelSetup?.();
        return;
      }
      params.onSelect(params.entry, event);
    }}
  >
    <span class="chat-controls__model-option-copy">
      <span class="chat-controls__model-option-title">
        <span class="chat-controls__model-option-name">${modelLabel}</span>
      </span>
    </span>
    <span class="chat-controls__model-option-action">
      ${
        selected
          ? html`<span class="chat-controls__inline-select-check" aria-hidden="true"
              >${icons.check}</span
            >`
          : ""
      }
    </span>
  </button>`;
}

export function renderChatModelPickerTargetOption(params: {
  disabled: boolean;
  entry: ChatModelPickerTargetGroup["options"][number];
  groupId: string;
  groupLabel: string;
  index: number;
  onSelect: (groupId: string, value: string, event: MouseEvent) => void;
}) {
  return html`
    <button
      class="chat-controls__inline-select-option chat-controls__model-option"
      data-chat-model-option=${`target:${params.groupId}:${params.entry.value}`}
      data-chat-model-target=${params.entry.value}
      data-chat-model-index=${params.index}
      data-chat-model-name="${params.entry.label.toLocaleLowerCase()}role"
      ="option"
      aria-selected="false"
      type="button"
      ?disabled=${params.disabled}
      @click=${(event: MouseEvent) => params.onSelect(params.groupId, params.entry.value, event)}
    >
      <span class="chat-controls__target-icon" aria-hidden="true">${icons.terminal}</span>
      <span class="chat-controls__model-option-copy">
        <span class="chat-controls__model-option-title">
          <span class="chat-controls__model-option-name">${params.entry.label}</span>
        </span>
      </span>
      <span class="chat-controls__model-option-action"></span>
    </button>
  `;
}
