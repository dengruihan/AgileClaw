import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderSettingsEmpty } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import {
  configMutationDisabled,
  renderProviderRow,
  type ModelProvidersViewProps,
} from "./view-provider-card.ts";
import { renderProviderStatus } from "./view-status.ts";

function modelCountLabel(card: ModelProviderCard): string {
  if (card.availableModelCount < card.modelCount) {
    return t("modelProviders.modelsAvailable", {
      available: String(card.availableModelCount),
      count: String(card.modelCount),
    });
  }
  return card.modelCount === 1
    ? t("modelProviders.modelOne")
    : t("modelProviders.models", { count: String(card.modelCount) });
}

/** Provider navigation and the single editor share one selection owner. */
export function renderProviderWorkspace(props: ModelProvidersViewProps) {
  const query = (props.providerQuery ?? "").trim().toLocaleLowerCase();
  const matches = (id: string, name: string) => `${id} ${name}`.toLocaleLowerCase().includes(query);
  const cards = props.cards.filter(
    (card) =>
      matches(card.id, card.displayName) ||
      card.credentialProviderIds.some((id) => matches(id, "")),
  );
  const selected = props.cards.find(
    (card) => (card.configKey ?? card.id) === props.selectedProvider,
  );
  return html` ${props.error ? html`<p class="callout danger" role="alert">${props.error}</p>` : nothing}
    <div class="model-providers__workspace">
      <nav class="model-providers__navigation" aria-label=${t("modelProviders.manager.configured")}>
        <label class="field model-providers__search">
          <input
            type="search"
            aria-label=${t("modelProviders.search")}
            placeholder=${t("modelProviders.search")}
            .value=${props.providerQuery ?? ""}
            @input=${(event: Event) => {
              // SAFETY: currentTarget is the search input carrying this listener.
              props.onProviderQueryChange?.((event.currentTarget as HTMLInputElement).value);
            }}
          />
        </label>
        ${([false, true] as const).map((custom) => {
          const group = cards.filter((card) => Boolean(props.isLocalOrCustom?.(card)) === custom);
          return group.length
            ? html`<div class="model-providers__nav-group">
                <h3>${t(`modelProviders.manager.${custom ? "custom" : "cloud"}`)}</h3>
                ${group.map(
                  (card) => html`<button
                    type="button"
                    class="model-providers__nav-item ${selected === card ? "is-selected" : ""}"
                    data-provider-id=${card.id}
                    data-provider-select=${card.configKey ?? card.id}
                    aria-pressed=${selected === card && !props.creatingProvider}
                    @click=${() => props.onProviderSettings?.(card)}
                  >
                    ${renderProviderBrandIcon(card.id, { className: "model-providers__icon" })}
                    <span class="model-providers__nav-copy"
                      ><strong>${card.displayName}</strong>
                      <span>${modelCountLabel(card)}</span></span
                    >
                    <span class="model-providers__nav-status">${renderProviderStatus(card)}</span>
                  </button>`,
                )}
              </div>`
            : nothing;
        })}
        ${
          props.creatingProvider
            ? html`<button
                type="button"
                class="model-providers__nav-item is-selected"
                aria-pressed="true"
              >
                ${icons.plus}<strong>${t("modelProviders.manager.customProvider")}</strong>
              </button>`
            : nothing
        }
        ${cards.length === 0 && !props.creatingProvider ? html`<p class="model-providers__nav-empty muted">${t(props.cards.length ? "modelProviders.noMatches" : "modelProviders.emptyTitle")}</p>` : nothing}
        ${
          props.cards.length === 0
            ? html`<button
                type="button"
                class="btn primary model-providers__add-empty"
                data-custom-provider
                ?disabled=${configMutationDisabled(props)}
                @click=${props.onCustomProvider}
              >
                ${icons.plus}${t("modelProviders.manager.addProvider")}
              </button>`
            : nothing
        }
      </nav>
      <div class="model-providers__editor">
        ${props.selectedProvider || props.creatingProvider ? props.providerEditor : renderSettingsEmpty(t("modelProviders.manager.selectProvider"))}
        ${selected && !props.creatingProvider ? renderProviderRow(selected, props) : nothing}
      </div>
    </div>`;
}
