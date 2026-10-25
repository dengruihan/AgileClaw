import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import {
  hasProviderBrandIcon,
  providerDisplayLabel,
  renderProviderBrandIcon,
} from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";
import {
  type ChatContextWindowControlParams,
  renderContextWindowControl,
} from "./chat-context-window-control.ts";
import {
  chatEffortTriggerLabel,
  chatEffortTriggerTitle,
  renderChatEffortPanel,
} from "./chat-effort-picker.ts";
import { renderChatModelCatalogState } from "./chat-model-catalog-state.ts";
import {
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  renderChatModelPickerOption,
  renderChatModelPickerTargetOption,
  renderChatModelProviderIcon,
  type ChatModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

registerModelControlsEnglish();

type ChatModelPickerParams = {
  contextWindow?: ChatContextWindowControlParams;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ChatModelCatalogState;
  modelSelectionLocked: boolean;
  selectionScopeDescription?: string;
  modelOptions: ChatModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  /** Pin recorded on the session row; only then does an unavailable Default row reset. */
  sessionModelPinned: boolean;
  sessionKey: string;
  thinking: ChatThinkingSelectState;
  thinkingDisabled: boolean;
  triggerModelLabel: string;
  triggerModelValue?: string;
  triggerStatusLabel?: string;
  triggerLoading?: boolean;
  triggerStarting?: boolean;
  onModelSetup?: () => void;
  onOpen?: () => unknown;
  onOpenChange?: (open: boolean) => void;
  onModelSelect: (
    value: string,
    sessionKey: string,
    agentRuntime?: string | null,
  ) => Promise<unknown>;
  onTargetRetry?: (groupId: string) => unknown;
  onTargetSelect?: (groupId: string, value: string) => unknown;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
};

function closeModelPickerAfterSelection(event: MouseEvent) {
  const details = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
  if (details) {
    details.open = false;
    if (event.detail === 0) {
      details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  }
}

export function renderChatModelPicker(params: ChatModelPickerParams) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption = params.modelOptions.find((option) =>
    isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
  );
  const leadingModelOption = activeModelOption ?? defaultModelOption;
  const triggerModelValue = params.triggerModelValue;
  const triggerModelOption =
    triggerModelValue === undefined
      ? activeModelOption
      : triggerModelValue === ""
        ? undefined
        : params.modelOptions.find((option) =>
            isModelPickerOptionSelected(option, triggerModelValue, params.selectedAgentRuntime),
          );
  const modelToolsUnavailable = triggerModelOption?.supportsTools === false;
  const selectedContextWindowOption = params.contextWindow?.options.find(
    (option) => option.id === params.contextWindow?.selected,
  );
  const showContextWindowBadge =
    selectedContextWindowOption !== undefined &&
    params.contextWindow?.selected !== params.contextWindow?.defaultId;
  const showEffort = params.thinking.options.length > 0;
  const effortLabel = chatEffortTriggerLabel(params.thinking);
  const effortTitle = chatEffortTriggerTitle(params.thinking);
  const triggerTitle = [
    params.triggerStatusLabel ?? params.triggerModelLabel,
    params.triggerStarting ? t("chat.modelControls.modelStarting") : "",
    modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const triggerAriaLabel = `${t("chat.selectors.model")}: ${triggerTitle}${
    params.selectionScopeDescription ? `. ${params.selectionScopeDescription}` : ""
  }${showEffort ? ` · ${t("chat.selectors.thinkingLevel")}: ${effortTitle}` : ""}`;
  // Brand mark ahead of the model name, and only when one actually ships:
  // hasProviderBrandIcon gates out the lettered fallback badge, so a provider
  // without a mark renders nothing rather than a placeholder.
  const triggerProviderIcon =
    !params.triggerLoading &&
    !params.triggerStatusLabel &&
    triggerModelOption &&
    hasProviderBrandIcon(triggerModelOption.provider)
      ? renderProviderBrandIcon(triggerModelOption.provider, {
          className: "chat-controls__trigger-provider-icon",
        })
      : nothing;
  const providerGroups = new Map<string, ChatModelPickerOption[]>();
  for (const option of params.modelOptions) {
    const existing = providerGroups.get(option.provider);
    if (existing) {
      // Default restores inheritance; it stays ahead of ranked model choices.
      if (option.isDefault) {
        existing.unshift(option);
      } else if (option === leadingModelOption) {
        existing.splice(existing[0]?.isDefault ? 1 : 0, 0, option);
      } else {
        existing.push(option);
      }
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const orderedProviderGroups = [...providerGroups];
  const selectedProviderIndex = orderedProviderGroups.findIndex(
    ([provider]) => provider === leadingModelOption?.provider,
  );
  if (selectedProviderIndex > 0) {
    const [selectedGroup] = orderedProviderGroups.splice(selectedProviderIndex, 1);
    if (selectedGroup) {
      orderedProviderGroups.unshift(selectedGroup);
    }
  }
  const orderedOptions = orderedProviderGroups.flatMap(([, options]) => options);
  const optionIndex = new Map(
    orderedOptions.map((option, index) => [modelPickerOptionKey(option), index]),
  );
  const targetGroups = params.targetGroups ?? [];
  const hasSelectableModelOptions = params.modelOptions.some((option) => !option.disabled);
  const selectModel = (entry: ChatModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    // An unavailable Default row still clears a recorded pin: it commits the reset, not the model.
    const resetsPin = entry.isDefault && params.sessionModelPinned;
    if (params.disabled || params.modelSelectionLocked || (entry.disabled && !resetsPin)) {
      event.preventDefault();
      return;
    }
    void params
      .onModelSelect(
        entry.commitValue,
        params.sessionKey,
        entry.runtimeOverride ??
          (entry.isDefault || entry.agentRuntime !== undefined ? null : undefined),
      )
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
    closeModelPickerAfterSelection(event);
  };
  const selectTarget = (groupId: string, value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked) {
      event.preventDefault();
      return;
    }
    params.onTargetSelect?.(groupId, value);
    closeModelPickerAfterSelection(event);
  };
  const modelRowLabel = params.triggerStatusLabel ?? params.triggerModelLabel;
  const modelMenu = html`
    <div
      class="chat-controls__inline-select-menu chat-controls__model-menu"
      aria-label=${t("chat.selectors.model")}
    >
      ${renderChatModelCatalogState(
        params.modelCatalogState,
        params.modelOptions.length > 0,
        hasSelectableModelOptions,
        params.onModelSetup,
      )}
      <div class="chat-controls__model-options">
        ${repeat(
          orderedProviderGroups,
          ([provider]) => provider,
          ([provider, options]) => html`
            <section
              class="chat-controls__provider-model-group"
              data-chat-model-provider-group=${provider}
              aria-label=${t("chat.modelControls.providerModels", {
                provider: providerDisplayLabel(provider),
              })}
            >
              <div class="chat-controls__provider-heading">
                ${renderChatModelProviderIcon(provider)}
                <span class="chat-controls__provider-label">${providerDisplayLabel(provider)}</span>
              </div>
              <div
                class="chat-controls__provider-model-list"
                data-chat-model-list="true"
                role="listbox"
                aria-label=${t("chat.modelControls.providerModels", {
                  provider: providerDisplayLabel(provider),
                })}
              >
                ${repeat(options, modelPickerOptionKey, (entry) =>
                  renderChatModelPickerOption({
                    disabled: params.disabled,
                    entry,
                    index: optionIndex.get(modelPickerOptionKey(entry)) ?? 0,
                    selectedModelValue: params.selectedModelValue,
                    selectedAgentRuntime: params.selectedAgentRuntime,
                    sessionModelPinned: params.sessionModelPinned,
                    onSelect: selectModel,
                    onModelSetup: params.onModelSetup,
                  }),
                )}
              </div>
            </section>
          `,
        )}
        ${repeat(
          targetGroups,
          (group) => group.id,
          (group) => html`
            <section
              class="chat-controls__provider-model-group"
              data-chat-model-target-group=${group.id}
              aria-label=${group.label}
            >
              <div class="chat-controls__provider-heading">
                <span class="chat-controls__provider-heading-icon" aria-hidden="true"
                  >${icons.terminal}</span
                >
                <span class="chat-controls__provider-label">${group.label}</span>
              </div>
              ${
                group.status === "ready"
                  ? nothing
                  : renderChatModelCatalogState(
                      { hasSnapshot: false, status: group.status },
                      false,
                      false,
                      undefined,
                      group.errorLabel,
                      params.onTargetRetry
                        ? {
                            disabled: params.disabled,
                            groupId: group.id,
                            onRetry: params.onTargetRetry,
                          }
                        : undefined,
                    )
              }
              <div
                class="chat-controls__provider-model-list"
                data-chat-model-list="true"
                role="listbox"
                aria-label=${group.label}
              >
                ${repeat(
                  group.options,
                  (entry) => entry.value,
                  (entry, targetIndex) =>
                    renderChatModelPickerTargetOption({
                      disabled: params.disabled,
                      entry,
                      groupId: group.id,
                      groupLabel: group.label,
                      index: orderedOptions.length + targetIndex,
                      onSelect: selectTarget,
                    }),
                )}
              </div>
            </section>
          `,
        )}
      </div>
      ${
        params.contextWindow
          ? renderContextWindowControl(params.contextWindow, params.sessionKey)
          : nothing
      }
      ${
        params.modelCatalogState?.modelSelectionPolicy?.restricted
          ? html`<div class="chat-controls__model-catalog-state" data-chat-model-policy>
              ${t("chat.modelControls.restrictedModelsHelp")}
            </div>`
          : nothing
      }
    </div>
  `;
  return html`
    <details
      class="chat-controls__inline-select chat-controls__model-picker"
      ?open=${params.open === true}
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        params.onOpenChange?.(details.open);
        handleChatComposerDetailsToggle(event);
        syncChatPickerOverlay(details);
        if (!details.open) {
          // The model window must not survive hidden inside a closed popup.
          details.querySelector("details.chat-controls__model-window")?.removeAttribute("open");
          return;
        }
        void params.onOpen?.();
        const active = details.ownerDocument.activeElement;
        // wa-popup can hide and reopen its top layer while resolving the anchor.
        // Focus after that opening work, not on every catalog render.
        requestAnimationFrame(() => {
          if (
            details.isConnected &&
            details.open &&
            details.ownerDocument.activeElement === active
          ) {
            details
              .querySelector<HTMLElement>(".chat-controls__combined-model-row")
              ?.focus({ preventScroll: true });
          }
        });
      }}
    >
      <summary
        class="chat-controls__inline-select-trigger chat-controls__model-trigger ${
          params.triggerLoading ? "chat-controls__model-trigger--loading" : ""
        } ${params.disabled ? "chat-controls__inline-select-trigger--disabled" : ""}"
        data-chat-model-select="true"
        data-chat-thinking-select="true"
        data-chat-thinking-value=${
          params.thinking.selection.source === "override" ? params.thinking.selection.value : ""
        }
        data-chat-thinking-disabled=${params.thinkingDisabled ? "true" : "false"}
        data-chat-model-locked=${params.modelSelectionLocked ? "true" : "false"}
        data-chat-select-value=${params.selectedModelValue}
        data-chat-model-tools=${modelToolsUnavailable ? "unavailable" : "available"}
        aria-label=${triggerAriaLabel}
        aria-busy=${params.triggerLoading || params.triggerStarting ? "true" : "false"}
        aria-disabled=${params.disabled ? "true" : "false"}
        title=${params.disabledReason?.trim() || nothing}
        @click=${(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
            return;
          }
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        ${
          modelToolsUnavailable
            ? html`
                <openclaw-tooltip .content=${t("chat.modelControls.chatOnlyHelp")}>
                  <span class="chat-controls__model-capability-badge" aria-hidden="true">
                    ${icons.alertTriangle}
                    <span>${t("chat.modelControls.chatOnly")}</span>
                  </span>
                </openclaw-tooltip>
              `
            : nothing
        }
        ${triggerProviderIcon}
        <span class="chat-controls__inline-select-label">
          ${
            params.triggerLoading
              ? html`<span
                  class="skeleton chat-controls__model-trigger-skeleton"
                  aria-hidden="true"
                ></span>`
              : (params.triggerStatusLabel ?? params.triggerModelLabel)
          }
        </span>
        ${
          showEffort && !params.triggerLoading && !params.triggerStatusLabel
            ? html`<span class="chat-controls__model-trigger-effort">${effortLabel}</span>`
            : nothing
        }
        ${
          showContextWindowBadge
            ? html`
                <span
                  class="chat-controls__locked-model-badge chat-controls__model-context-badge"
                  data-chat-model-context-badge
                >
                  ${selectedContextWindowOption.label}
                </span>
              `
            : nothing
        }
        <span class="chat-controls__inline-select-chevron" aria-hidden="true"
          >${
            params.triggerStarting ? html`<span class="btn__spinner"></span>` : icons.chevronUp
          }</span
        >
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__combined-menu"
          aria-label=${t("chat.selectors.model")}
        >
          ${
            params.modelSelectionLocked
              ? html`
                  <div
                    class="chat-controls__locked-model"
                    aria-label=${t("chat.selectors.modelLockedLabel")}
                  >
                    <span class="chat-controls__inline-select-section-label">
                      ${t("chat.selectors.modelSection")}
                    </span>
                    <span class="chat-controls__locked-model-value"
                      >${params.triggerModelLabel}</span
                    >
                    <span class="chat-controls__locked-model-badge">
                      ${t("chat.selectors.modelLocked")}
                    </span>
                  </div>
                `
              : html`
                  <details
                    class="chat-controls__inline-select chat-controls__model-window"
                    @toggle=${(event: Event) => {
                      const details = event.currentTarget as HTMLDetailsElement;
                      handleChatComposerDetailsToggle(event);
                      syncChatPickerOverlay(details);
                    }}
                  >
                    <summary
                      class="chat-controls__combined-model-row"
                      aria-disabled=${params.disabled ? "true" : "false"}
                      @click=${(event: MouseEvent) => {
                        if (params.disabled) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <span class="chat-controls__inline-select-section-label">
                        ${t("chat.selectors.modelSection")}
                      </span>
                      <span class="chat-controls__combined-model-value">${modelRowLabel}</span>
                      <span class="chat-controls__inline-select-chevron" aria-hidden="true"
                        >${icons.chevronRight}</span
                      >
                    </summary>
                    <wa-popup data-anchored-overlay>${modelMenu}</wa-popup>
                  </details>
                `
          }
          ${
            showEffort
              ? html`
                  <div class="chat-controls__combined-divider" aria-hidden="true"></div>
                  ${renderChatEffortPanel({
                    sessionKey: params.sessionKey,
                    thinkingDisabled: params.thinkingDisabled,
                    thinking: params.thinking,
                    onThinkingSelect: params.onThinkingSelect,
                    onRequestUpdate: params.onRequestUpdate,
                  })}
                `
              : nothing
          }
        </div>
      </wa-popup>
    </details>
  `;
}
