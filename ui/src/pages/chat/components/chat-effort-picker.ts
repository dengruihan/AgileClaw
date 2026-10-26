import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";

registerModelControlsEnglish();

type ChatEffortPanelParams = {
  sessionKey: string;
  thinkingDisabled: boolean;
  thinking: ChatThinkingSelectState;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
};

function formatEffortLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

/** Trigger-facing effort text: the level, with inherited defaults spelled out. */
export function chatEffortTriggerLabel(thinking: ChatThinkingSelectState): string {
  return formatEffortLabel(thinking.selection.displayLabel);
}

export function chatEffortTriggerTitle(thinking: ChatThinkingSelectState): string {
  const label = chatEffortTriggerLabel(thinking);
  return thinking.selection.source === "override"
    ? label
    : t("chat.modelControls.defaultWithLevel", { level: label });
}

// Keep in sync with --chat-effort-knob-width in composer.css: the travel calc
// centers the knob on the stop position and ends the fill at that center.
const REASONING_KNOB_WIDTH_PX = 32;

function reasoningTravelCss(fillPercent: number): string {
  const offset = REASONING_KNOB_WIDTH_PX / 2 - (REASONING_KNOB_WIDTH_PX * fillPercent) / 100;
  return `calc(${fillPercent}% + ${offset.toFixed(2)}px)`;
}

/** Reasoning-effort panel for the combined picker menu: slider, preview, commit. */
export function renderChatEffortPanel(params: ChatEffortPanelParams) {
  const sliderStops = params.thinking.options;
  const selection = params.thinking.selection;
  const hasThinkingOverride = selection.source === "override";
  const selectedThinkingValue = hasThinkingOverride ? selection.value : "";
  const sliderIndex = selection.kind === "anchored" ? selection.index : 0;
  const sliderUnanchored = selection.kind === "unanchored";
  // Binary providers can use a ranked wire value with the display label "On".
  const maximumIndex = sliderStops.findLastIndex(
    (stop) =>
      stop.label !== "On" &&
      ["minimal", "low", "medium", "high", "xhigh", "max"].includes(stop.value),
  );
  const sliderBoost = (index: number) =>
    sliderStops[index]?.value === "ultra" ? "ultra" : index === maximumIndex ? "max" : "";
  const committedBoost = sliderUnanchored ? "" : sliderBoost(sliderIndex);
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const committedFillPercent = sliderFillPercent(sliderIndex);
  const reasoningValueText = formatEffortLabel(selection.displayLabel);
  const reasoningValueLabel = chatEffortTriggerTitle(params.thinking);
  const commitThinking = (value: string) => {
    void params
      .onThinkingSelect(value, params.sessionKey)
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
  };
  const syncSliderPreview = (input: HTMLInputElement, previewIndex?: number) => {
    const preview = previewIndex === undefined ? undefined : sliderStops[previewIndex];
    const index = previewIndex ?? sliderIndex;
    const track = input.closest<HTMLElement>(".chat-controls__reasoning-slider");
    const fillPercent = sliderFillPercent(index);
    track?.style.setProperty("--reasoning-fill", `${fillPercent}%`);
    track?.style.setProperty("--reasoning-travel", reasoningTravelCss(fillPercent));
    input.dataset.effortBoost = preview ? sliderBoost(index) : committedBoost;
    input.setAttribute(
      "aria-valuetext",
      preview ? formatEffortLabel(preview.label) : reasoningValueLabel,
    );
    const panel = input.closest(".chat-controls__reasoning-panel");
    panel?.querySelectorAll<HTMLElement>("[data-chat-thinking-preview-index]").forEach((label) => {
      label.hidden = !preview || label.dataset.chatThinkingPreviewIndex !== input.value;
    });
    const committedLabel = panel?.querySelector<HTMLElement>(
      "[data-chat-thinking-preview-committed]",
    );
    if (committedLabel) {
      committedLabel.hidden = Boolean(preview);
    }
  };
  const resetSliderPreview = (input: HTMLInputElement, restoreValue = false) => {
    if (restoreValue) {
      input.value = String(sliderIndex);
    }
    syncSliderPreview(input);
  };
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const index = Number(input.value);
    if (sliderStops[index]) {
      syncSliderPreview(input, index);
    }
  };
  const onSliderCommit = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    resetSliderPreview(input);
    if (params.thinkingDisabled || !stop || stop.value === selectedThinkingValue) {
      return;
    }
    commitThinking(stop.value);
  };
  const onUnanchoredSliderClick = (event: MouseEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (sliderUnanchored && Number(input.value) === sliderIndex) {
      onSliderCommit(event);
    }
  };
  const onUnanchoredSliderKeyDown = (event: KeyboardEvent) => {
    if (sliderUnanchored && ["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) {
      onSliderCommit(event);
    }
  };
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const onlyStopSelected = selection.kind === "anchored" && selection.index === 0;
  return html`
    <div class="chat-controls__reasoning-panel">
      <div class="chat-controls__reasoning-head">
        <span class="chat-controls__effort-heading"> ${t("chat.modelControls.effort")} </span>
        <span class="chat-controls__effort-value" aria-hidden="true">
          <span data-chat-thinking-preview-committed>${reasoningValueText}</span>
          ${sliderStops.map(
            (stop, index) => html`<span data-chat-thinking-preview-index=${index} hidden
              >${formatEffortLabel(stop.label)}</span
            >`,
          )}
        </span>
      </div>
      ${
        sliderStops.length > 1
          ? html`
              <div
                class="chat-controls__reasoning-slider"
                style=${`--reasoning-fill: ${committedFillPercent}%; --reasoning-travel: ${reasoningTravelCss(committedFillPercent)}`}
              >
                <div class="chat-controls__reasoning-groove" aria-hidden="true">
                  <div class="chat-controls__reasoning-fill"></div>
                  <div class="chat-controls__reasoning-boost"></div>
                </div>
                <div class="chat-controls__reasoning-dots" aria-hidden="true">
                  ${sliderStops.map(
                    (stop) => html`<span
                      class="chat-controls__reasoning-dot"
                      data-stop=${stop.value}
                    ></span>`,
                  )}
                </div>
                <div class="chat-controls__reasoning-knob" aria-hidden="true"></div>
                <input
                  class="chat-controls__reasoning-range ${
                    hasThinkingOverride ? "" : "chat-controls__reasoning-range--inherit"
                  } ${sliderUnanchored ? "chat-controls__reasoning-range--unanchored" : ""}"
                  type="range"
                  min="0"
                  max=${sliderStops.length - 1}
                  step="1"
                  .value=${String(sliderIndex)}
                  data-chat-thinking-slider="true"
                  data-effort-boost=${committedBoost}
                  data-chat-thinking-values=${sliderStops.map((stop) => stop.value).join(",")}
                  aria-label=${t("chat.selectors.thinkingLevel")}
                  aria-valuetext=${reasoningValueLabel}
                  ?disabled=${params.thinkingDisabled}
                  @input=${onSliderDrag}
                  @change=${onSliderCommit}
                  @click=${onUnanchoredSliderClick}
                  @keydown=${onUnanchoredSliderKeyDown}
                  @pointercancel=${(event: PointerEvent) =>
                    resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                  @blur=${(event: FocusEvent) =>
                    resetSliderPreview(event.currentTarget as HTMLInputElement, true)}
                />
              </div>
            `
          : onlyStop
            ? html`
                <button
                  class="chat-controls__reasoning-option ${
                    onlyStopSelected ? "chat-controls__reasoning-option--selected" : ""
                  }"
                  data-chat-thinking-option=${onlyStop.value}
                  type="button"
                  aria-pressed=${onlyStopSelected ? "true" : "false"}
                  ?disabled=${params.thinkingDisabled}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    if (params.thinkingDisabled || onlyStopSelected) {
                      event.preventDefault();
                      return;
                    }
                    commitThinking(onlyStop.value);
                  }}
                >
                  <span>${onlyStop.label}</span>
                  ${
                    onlyStopSelected
                      ? html`<span class="chat-controls__inline-select-check" aria-hidden="true"
                          >${icons.check}</span
                        >`
                      : nothing
                  }
                </button>
              `
            : nothing
      }
    </div>
  `;
}
