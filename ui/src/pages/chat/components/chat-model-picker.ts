import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
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
  describeModelProviderAuth,
  type ModelProviderAuthLabel,
} from "../../../lib/model-provider-auth-label.ts";
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
  /** Provider access pills; null/absent (new-session page) simply hides them. */
  modelAuthStatusResult?: ModelAuthStatusResult | null;
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

function providerAuthLabel(
  result: ModelAuthStatusResult | null | undefined,
  provider: string,
): ModelProviderAuthLabel | undefined {
  const status = result?.providers.find((entry) => entry.provider === provider);
  const label = status ? describeModelProviderAuth(status) : undefined;
  // "Sign-in needed" is an error state, not an identity: only positive access
  // kinds ride beside the provider name.
  return label?.kind === "api" || label?.kind === "subscription" ? label : undefined;
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
  const providerGroupEntries = [...providerGroups];
  // The window shows one provider's models at a time; the selection decides
  // which one, and the provider flyout switches it.
  const leadingProvider = leadingModelOption?.provider ?? providerGroupEntries[0]?.[0];
  const leadingGroupOptions =
    leadingProvider === undefined ? undefined : providerGroups.get(leadingProvider);
  const orderedOptions = providerGroupEntries.flatMap(([, options]) => options);
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
    // The card stays open after a model commit so the effort slider below
    // stays reachable; the moved check mark is the selection feedback.
    void params
      .onModelSelect(
        entry.commitValue,
        params.sessionKey,
        entry.runtimeOverride ??
          (entry.isDefault || entry.agentRuntime !== undefined ? null : undefined),
      )
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const selectTarget = (groupId: string, value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked) {
      event.preventDefault();
      return;
    }
    params.onTargetSelect?.(groupId, value);
  };
  const selectProvider = (provider: string, event: MouseEvent) => {
    const options = providerGroups.get(provider) ?? [];
    // A provider switch commits its leading usable model (ZCode-style): the
    // card re-renders onto the new provider without extra picker state. Only
    // the flyout closes; the card stays open showing the refreshed list.
    const entry =
      options.find((option) => !option.disabled && !option.isDefault) ??
      options.find((option) => !option.disabled);
    if (!entry) {
      event.preventDefault();
      return;
    }
    const flyout = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
    if (flyout) {
      flyout.open = false;
      if (event.detail === 0) {
        flyout.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
    }
    selectModel(entry, event);
  };
  const openModelSetupFromProviderMenu = (event: MouseEvent) => {
    event.stopPropagation();
    // Navigate from a clean slate: close every picker layer this menu sits in.
    const root = (event.currentTarget as HTMLElement).closest(".chat-controls__model-picker");
    if (root) {
      for (const details of root.querySelectorAll("details[open]")) {
        (details as HTMLDetailsElement).open = false;
      }
      if (root instanceof HTMLDetailsElement) {
        root.open = false;
      }
    }
    params.onModelSetup?.();
  };
  const renderProviderBadge = (provider: string) => {
    const label = providerAuthLabel(params.modelAuthStatusResult, provider);
    return label
      ? html`<span
          class="chat-controls__provider-badge"
          data-chat-provider-auth=${label.kind}
          title=${label.detail ?? nothing}
          >${label.label}</span
        >`
      : nothing;
  };
  const providerMenu = html`
    <div
      class="chat-controls__inline-select-menu chat-controls__provider-menu"
      aria-label=${t("chat.modelControls.providers")}
    >
      <div
        class="chat-controls__provider-menu-list"
        role="listbox"
        data-chat-model-provider-list="true"
      >
        ${repeat(
          providerGroupEntries,
          ([provider]) => provider,
          ([provider, options]) => {
            const current = provider === leadingProvider;
            const noUsableOption = !options.some((option) => !option.disabled);
            return html`
              <button
                class="chat-controls__inline-select-option chat-controls__provider-option ${
                  current ? "chat-controls__inline-select-option--selected" : ""
                }"
                type="button"
                role="option"
                aria-selected=${current ? "true" : "false"}
                data-chat-model-provider-option=${provider}
                ?disabled=${params.disabled || params.modelSelectionLocked || noUsableOption}
                title=${noUsableOption ? t("chat.modelControls.noModelsAvailable") : nothing}
                @click=${(event: MouseEvent) => selectProvider(provider, event)}
              >
                <span class="chat-controls__provider-heading-icon" aria-hidden="true"
                  >${renderChatModelProviderIcon(provider)}</span
                >
                <span class="chat-controls__provider-option-name"
                  >${providerDisplayLabel(provider)}</span
                >
                ${renderProviderBadge(provider)}
                <span class="chat-controls__model-option-action">
                  ${
                    current
                      ? html`<span class="chat-controls__inline-select-check" aria-hidden="true"
                          >${icons.check}</span
                        >`
                      : nothing
                  }
                </span>
              </button>
            `;
          },
        )}
      </div>
      ${
        params.onModelSetup
          ? html`
              <button
                class="chat-controls__provider-manage"
                type="button"
                data-chat-model-manage="true"
                @click=${openModelSetupFromProviderMenu}
              >
                <span class="chat-controls__provider-heading-icon" aria-hidden="true"
                  >${icons.settings}</span
                >
                ${t("chat.modelControls.emptyModelsAction")}
              </button>
            `
          : nothing
      }
    </div>
  `;
  // Card body for the unlocked picker: provider row, that provider's model
  // list, and the context footer rows. The locked state replaces all of it.
  const cardBody = html`
    ${renderChatModelCatalogState(
      params.modelCatalogState,
      params.modelOptions.length > 0,
      hasSelectableModelOptions,
      params.onModelSetup,
    )}
    ${
      leadingProvider !== undefined && leadingGroupOptions !== undefined
        ? html`
            <details
              class="chat-controls__inline-select chat-controls__provider-window"
              @toggle=${(event: Event) => {
                const details = event.currentTarget as HTMLDetailsElement;
                handleChatComposerDetailsToggle(event);
                // Beside the card, not above it: the composer sits near the
                // viewport's right edge, so the flyout prefers the left side.
                syncChatPickerOverlay(details, { side: "left", alignment: "start" });
              }}
            >
              <summary
                class="chat-controls__combined-model-row chat-controls__provider-row"
                aria-disabled=${params.disabled ? "true" : "false"}
                aria-label=${t("chat.modelControls.providerModels", {
                  provider: providerDisplayLabel(leadingProvider),
                })}
                @click=${(event: MouseEvent) => {
                  if (params.disabled) {
                    event.preventDefault();
                  }
                }}
              >
                <span class="chat-controls__provider-heading-icon" aria-hidden="true"
                  >${renderChatModelProviderIcon(leadingProvider)}</span
                >
                <span class="chat-controls__combined-model-value"
                  >${providerDisplayLabel(leadingProvider)}</span
                >
                ${renderProviderBadge(leadingProvider)}
                <span class="chat-controls__inline-select-chevron" aria-hidden="true"
                  >${icons.chevronRight}</span
                >
              </summary>
              <wa-popup data-anchored-overlay>${providerMenu}</wa-popup>
            </details>
            <div class="chat-controls__combined-divider" aria-hidden="true"></div>
          `
        : nothing
    }
    <div class="chat-controls__model-options">
      ${
        leadingGroupOptions
          ? html`
              <div class="chat-controls__provider-heading chat-controls__model-section-heading">
                <span class="chat-controls__provider-label"
                  >${t("chat.selectors.modelSection")}</span
                >
              </div>
              <div
                class="chat-controls__provider-model-list"
                data-chat-model-list="true"
                data-chat-model-provider=${leadingProvider ?? nothing}
                role="listbox"
                aria-label=${t("chat.modelControls.providerModels", {
                  provider: providerDisplayLabel(leadingProvider ?? ""),
                })}
              >
                ${repeat(leadingGroupOptions, modelPickerOptionKey, (entry) =>
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
            `
          : nothing
      }
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
          // The provider flyout must not survive hidden inside a closed popup.
          details.querySelector("details.chat-controls__provider-window")?.removeAttribute("open");
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
              .querySelector<HTMLElement>(".chat-controls__provider-row")
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
              : cardBody
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
