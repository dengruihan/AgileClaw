// Provider editor icon picker: the trigger previews the draft's current icon
// and the popover offers the automatic name match, an explicit removal, and
// every bundled brand mark. Choices reach the dialog's draft through onSelect;
// persistence stays with the provider editor.
import "@awesome.me/webawesome/dist/components/popover/popover.js";
import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import {
  matchProviderBrand,
  PROVIDER_BRAND_ICONS,
  type ProviderIconChoice,
} from "./provider-brand-rules.ts";
import { isProviderIconId } from "./provider-icon-ids.ts";
import { renderProviderBrandIcon } from "./provider-icon.ts";
import { syncPopoverExpanded, syncPopoverLabel } from "./web-awesome-popover.ts";
import "../styles/provider-icon-picker.css";

const ARROW_OFFSETS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowDown: 1,
};

export class ProviderIconPicker extends OpenClawLightDomElement {
  /** Provider key, used only to render the trigger mark. */
  @property() provider = "";
  /** Provider draft the editor owns; only `icon` and `iconManual` are read. */
  @property({ attribute: false }) draft: Record<string, unknown> = {};
  /** Live name field text, so an uncommitted rename previews immediately. */
  @property() name = "";
  /** Whether the editable Name field drives the automatic preview. */
  @property({ type: Boolean }) editableName = false;
  @property({ type: Boolean }) disabled = false;
  @property({ attribute: false }) onSelect: (choice: ProviderIconChoice) => void = () => undefined;
  @state() private query = "";
  private readonly triggerId = `provider-icon-trigger-${generateUUID()}`;

  /**
   * The picker's current choice. Without the manual flag the icon is automatic
   * even when a saved icon is present, so a rename is previewed instead.
   */
  private get selection(): ProviderIconChoice {
    if (this.draft.iconManual === true) {
      return typeof this.draft.icon === "string" && this.draft.icon
        ? { kind: "icon", icon: this.draft.icon }
        : { kind: "none" };
    }
    return { kind: "auto" };
  }

  private get committedName(): string {
    return typeof this.draft.displayName === "string" ? this.draft.displayName.trim() : "";
  }

  private get previewIcon(): string | null | undefined {
    const selection = this.selection;
    if (selection.kind === "none") {
      return null;
    }
    if (selection.kind === "icon") {
      return selection.icon;
    }
    // Built-in providers have no Name field; defer to the saved icon and the
    // provider id's built-in mark so their header keeps the brand mark.
    if (!this.editableName) {
      return undefined;
    }
    // Only a rename that is still uncommitted previews its match. Once the name
    // is committed its icon lives in the draft (and later in config), so
    // re-matching here would hide both and show a letter for a saved brand.
    if (this.name.trim() !== this.committedName) {
      return matchProviderBrand(this.name);
    }
    // A stored icon the editor draft holds outranks the provider id's mark; an
    // id that does not name a bundled asset falls through to the same mark.
    const savedIcon =
      typeof this.draft.icon === "string" ? this.draft.icon.trim().toLowerCase() : "";
    return isProviderIconId(savedIcon) ? savedIcon : undefined;
  }

  private get fallbackLabel(): string {
    const typed = this.name.trim();
    return typed || this.committedName || this.provider;
  }

  private isSelected(choice: ProviderIconChoice): boolean {
    const current = this.selection;
    return choice.kind === "icon"
      ? current.kind === "icon" && current.icon === choice.icon
      : current.kind === choice.kind;
  }

  private select(choice: ProviderIconChoice) {
    if (this.disabled) {
      return;
    }
    this.onSelect(choice);
    void this.querySelector<WaPopover>("wa-popover")?.hide();
  }

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void this.querySelector<WaPopover>("wa-popover")?.hide();
      return;
    }
    const offset = ARROW_OFFSETS[event.key];
    const panel = event.currentTarget;
    if (offset === undefined || !(panel instanceof HTMLElement)) {
      return;
    }
    // The search field owns horizontal cursor movement; only the vertical
    // arrows leave it for the option grid.
    if (
      document.activeElement instanceof HTMLInputElement &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      return;
    }
    const options = [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!options.length) {
      return;
    }
    // Focus may sit in the search field; arrows then enter the options at the
    // matching end instead of doing nothing.
    const index = options.findIndex((option) => option === document.activeElement);
    const next =
      index < 0
        ? options[offset > 0 ? 0 : options.length - 1]
        : options[(index + offset + options.length) % options.length];
    event.preventDefault();
    next?.focus();
  };

  private renderFixedChoice(
    choice: ProviderIconChoice,
    label: string,
    glyph: TemplateResult,
  ): TemplateResult {
    return html`<button
      type="button"
      class="provider-icon-picker__choice provider-icon-picker__choice--fixed"
      aria-label=${label}
      aria-pressed=${String(this.isSelected(choice))}
      title=${label}
      ?disabled=${this.disabled}
      @click=${() => this.select(choice)}
    >
      <span class="provider-icon-picker__fixed-glyph" aria-hidden="true">${glyph}</span>
      <span>${label}</span>
    </button>`;
  }

  override render() {
    const query = this.query.trim().toLowerCase();
    const visible = query
      ? PROVIDER_BRAND_ICONS.filter(
          (entry) => entry.icon.includes(query) || entry.label.toLowerCase().includes(query),
        )
      : PROVIDER_BRAND_ICONS;
    return html`
      <button
        id=${this.triggerId}
        type="button"
        class="provider-icon-picker__trigger"
        aria-label=${t("modelProviders.manager.icon")}
        aria-haspopup="dialog"
        aria-expanded="false"
        title=${t("modelProviders.manager.icon")}
        ?disabled=${this.disabled}
      >
        ${renderProviderBrandIcon(this.provider, {
          className: "provider-icon-picker__mark",
          icon: this.previewIcon,
          fallbackLabel: this.fallbackLabel,
        })}
      </button>
      <wa-popover
        ${ref(syncPopoverLabel)}
        class="provider-icon-picker__popover"
        for=${this.triggerId}
        placement="bottom-start"
        without-arrow
        @wa-show=${syncPopoverExpanded}
        @wa-hide=${(event: Event) => {
          syncPopoverExpanded(event);
          if (event.target === event.currentTarget) {
            this.query = "";
          }
        }}
      >
        <div class="provider-icon-picker__panel" @keydown=${this.handleKeydown}>
          <input
            class="provider-icon-picker__search"
            type="search"
            autofocus
            aria-label=${t("modelProviders.manager.iconSearch")}
            placeholder=${t("modelProviders.manager.iconSearch")}
            .value=${this.query}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                this.query = event.currentTarget.value;
              }
            }}
          />
          <div
            class="provider-icon-picker__fixed"
            role="group"
            aria-label=${t("modelProviders.manager.icon")}
          >
            ${this.renderFixedChoice(
              { kind: "auto" },
              t("modelProviders.manager.iconAutomatic"),
              icons.wandSparkles,
            )}
            ${this.renderFixedChoice(
              { kind: "none" },
              t("modelProviders.manager.iconNone"),
              icons.circleX,
            )}
          </div>
          <div
            class="provider-icon-picker__grid"
            role="group"
            aria-label=${t("modelProviders.manager.icon")}
          >
            ${
              visible.length
                ? visible.map(
                    (entry) => html`<button
                      type="button"
                      class="provider-icon-picker__choice"
                      data-provider-icon-choice=${entry.icon}
                      aria-label=${entry.label}
                      aria-pressed=${String(this.isSelected({ kind: "icon", icon: entry.icon }))}
                      title=${entry.label}
                      ?disabled=${this.disabled}
                      @click=${() => this.select({ kind: "icon", icon: entry.icon })}
                    >
                      ${renderProviderBrandIcon(this.provider, {
                        className: "provider-icon-picker__choice-mark",
                        icon: entry.icon,
                        fallbackLabel: entry.label,
                      })}
                    </button>`,
                  )
                : html`<span class="provider-icon-picker__empty"
                    >${t("modelProviders.manager.iconNoMatches")}</span
                  >`
            }
          </div>
        </div>
      </wa-popover>
    `;
  }
}

if (!customElements.get("openclaw-provider-icon-picker")) {
  customElements.define("openclaw-provider-icon-picker", ProviderIconPicker);
}
