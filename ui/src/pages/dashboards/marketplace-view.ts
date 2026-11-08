import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import {
  MARKETPLACE_MEASUREMENTS,
  MARKETPLACE_PRESETS,
  type MarketplacePreset,
  type MarketplacePresetId,
} from "./marketplace-presets.ts";

registerSystemsEnglish();

/** Preset installation the dashboards page owns; this drawer only renders and reports intent. */
export type MarketplaceState = {
  open: boolean;
  installed: readonly MarketplacePresetId[];
  openMarketplace: () => void;
  closeMarketplace: () => void;
  install: (id: MarketplacePresetId) => void;
  uninstall: (id: MarketplacePresetId) => void;
};

/** Page-level action: always rendered, so it stays reachable with data, an empty gallery, or a failed load. */
export function renderMarketplaceTrigger(marketplace?: MarketplaceState) {
  return html`<button
    type="button"
    class="dashboards-marketplace-trigger"
    data-marketplace-trigger
    aria-haspopup="dialog"
    aria-expanded=${String(marketplace?.open ?? false)}
    title=${t("dashboardsPage.marketplaceHint")}
    @click=${() => marketplace?.openMarketplace()}
  >
    ${icons.layoutGrid}
    <span>${t("dashboardsPage.marketplace")}</span>
  </button>`;
}

function renderPresetMeasurements(preset: MarketplacePreset) {
  return html`<ul class="dashboards-marketplace__measurements">
    ${preset.measurementIds.map((id) => {
      const measurement = MARKETPLACE_MEASUREMENTS[id];
      return html`<li data-marketplace-measurement=${id}>
        <span class="dashboards-marketplace__measurement-label">${t(measurement.labelKey)}</span>
        <span class="dashboards-marketplace__measurement-description"
          >${t(measurement.descriptionKey)}</span
        >
      </li>`;
    })}
  </ul>`;
}

function renderPresetCard(preset: MarketplacePreset, marketplace: MarketplaceState) {
  const installed = marketplace.installed.includes(preset.id);
  const name = t(preset.nameKey);
  return html`<li>
    <article
      class="dashboards-marketplace__preset"
      data-marketplace-preset=${preset.id}
      data-installed=${String(installed)}
    >
      <div class="dashboards-marketplace__preset-head">
        <h3>${name}</h3>
        ${
          installed
            ? html`<span class="dashboards-marketplace__installed">
                ${icons.check}${t("dashboardsPage.marketplaceInstalled")}
              </span>`
            : nothing
        }
      </div>
      <p class="dashboards-marketplace__preset-description">${t(preset.descriptionKey)}</p>
      ${renderPresetMeasurements(preset)}
      <div class="dashboards-marketplace__preset-actions">
        ${
          installed
            ? html`<button
                type="button"
                class="btn btn--ghost"
                data-marketplace-remove
                aria-label=${t("dashboardsPage.marketplaceRemove", { preset: name })}
                @click=${() => marketplace.uninstall(preset.id)}
              >
                ${t("dashboardsPage.marketplaceRemoveAction")}
              </button>`
            : html`<button
                type="button"
                class="btn primary"
                data-marketplace-add
                aria-label=${t("dashboardsPage.marketplaceAdd", { preset: name })}
                @click=${() => marketplace.install(preset.id)}
              >
                ${t("dashboardsPage.marketplaceAddAction")}
              </button>`
        }
      </div>
    </article>
  </li>`;
}

export function renderMarketplace(marketplace: MarketplaceState) {
  const title = t("dashboardsPage.marketplaceTitle");
  return html`<openclaw-modal-dialog
    class="drawer dashboards-marketplace"
    style="--openclaw-modal-width: min(440px, 100vw);"
    label=${title}
    description=${t("dashboardsPage.marketplaceDescription")}
    @modal-cancel=${() => marketplace.closeMarketplace()}
  >
    <section class="dashboards-marketplace__panel" data-marketplace>
      <header class="dashboards-marketplace__header">
        <div>
          <h2>${title}</h2>
          <p>${t("dashboardsPage.marketplaceDescription")}</p>
        </div>
        <button
          type="button"
          class="dashboards-marketplace__close"
          aria-label=${t("dashboardsPage.marketplaceClose")}
          title=${t("dashboardsPage.marketplaceClose")}
          @click=${() => marketplace.closeMarketplace()}
        >
          ${icons.x}
        </button>
      </header>
      <div class="dashboards-marketplace__body">
        <ul class="dashboards-marketplace__list">
          ${MARKETPLACE_PRESETS.map((preset) => renderPresetCard(preset, marketplace))}
        </ul>
      </div>
    </section>
  </openclaw-modal-dialog>`;
}
