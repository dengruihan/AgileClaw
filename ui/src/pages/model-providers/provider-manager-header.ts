// Provider editor header: the identity block with the icon picker, plus the
// provider actions menu. Kept out of provider-manager.ts, whose line budget is
// already exhausted.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import type { ProviderIconChoice } from "../../components/provider-brand-rules.ts";
import "../../components/provider-icon-picker.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";

export type ProviderEditorHeaderProps = {
  provider: string;
  title: string;
  draft: Record<string, unknown>;
  name: string;
  editableName: boolean;
  disabled: boolean;
  card: ModelProviderCard | null;
  canDeleteProvider: ((card: ModelProviderCard) => boolean) | null;
  onDeleteProvider: ((card: ModelProviderCard) => void) | null;
  onIconSelect: (choice: ProviderIconChoice) => void;
};

/** Icon picker, title, provider key, and the page-owned delete action. */
export function providerEditorHeader(props: ProviderEditorHeaderProps) {
  return html`<header class="provider-manager__header">
    <div class="provider-manager__identity">
      <openclaw-provider-icon-picker
        .provider=${props.provider}
        .draft=${props.draft}
        .name=${props.name}
        .editableName=${props.editableName}
        .disabled=${props.disabled || !props.editableName}
        .onSelect=${props.onIconSelect}
      ></openclaw-provider-icon-picker>
      <div>
        <h2>${props.title}</h2>
        <span class="muted">${props.provider}</span>
      </div>
    </div>
    ${providerActionsMenu(props)}
  </header>`;
}

function providerActionsMenu(
  props: Pick<
    ProviderEditorHeaderProps,
    "card" | "disabled" | "canDeleteProvider" | "onDeleteProvider"
  >,
): TemplateResult | typeof nothing {
  const card = props.card;
  // Deletion applies to authored entries only; the page owns that decision and
  // the confirm/logout flow, so the menu just forwards the current card.
  if (!card || props.canDeleteProvider?.(card) !== true) {
    return nothing;
  }
  const actionsLabel = t("modelProviders.manager.providerActions", { name: card.displayName });
  return html`
    <wa-dropdown
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (event.detail.item.value === "delete") {
          props.onDeleteProvider?.(card);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--icon provider-manager__menu-trigger"
        aria-label=${actionsLabel}
        title=${actionsLabel}
        ?disabled=${props.disabled}
      >
        ${icons.moreHorizontal}
      </button>
      <wa-dropdown-item
        value="delete"
        variant="danger"
        data-models-delete-provider=${card.id}
        ?disabled=${props.disabled}
      >
        ${t("modelProviders.delete.action")}
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}
