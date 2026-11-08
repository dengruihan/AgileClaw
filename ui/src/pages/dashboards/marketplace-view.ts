import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import type { MarketplaceDrawerDrag } from "./marketplace-drawer-drag.ts";
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
  /** True while the page is in a drag-preview gesture mounting the preview drawer. */
  dragActive: boolean;
  /** Page-owned drag owner for the pull tab; static renders stay click-only without it. */
  drawerDrag?: MarketplaceDrawerDrag;
  openMarketplace: () => void;
  closeMarketplace: () => void;
  install: (id: MarketplacePresetId) => void;
  uninstall: (id: MarketplacePresetId) => void;
};

/**
 * Page-level pull tab anchored to the viewport's right edge — the closed
 * drawer's front face. Click and keyboard activate it; a leftward pointer
 * drag pulls the drawer out through the page's drag-preview.
 */
export function renderMarketplaceTrigger(marketplace?: MarketplaceState) {
  const drag = marketplace?.drawerDrag;
  return html`<button
    type="button"
    class="dashboards-marketplace-trigger"
    data-marketplace-trigger
    aria-haspopup="dialog"
    aria-expanded=${String(marketplace?.open ?? false)}
    title=${t("dashboardsPage.marketplaceHint")}
    @pointerdown=${(event: PointerEvent) => drag?.triggerPointerDown(event)}
    @click=${() => {
      if (drag?.consumeDragActivation()) {
        return;
      }
      marketplace?.openMarketplace();
    }}
  >
    ${icons.layoutGrid}
    <span class="dashboards-marketplace-trigger__label">${t("dashboardsPage.marketplace")}</span>
    <span class="dashboards-marketplace-trigger__grip" aria-hidden="true"></span>
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

/**
 * The drawer front itself, shared by the modal drawer and the drag-preview.
 * The ribbed edge handle is the close affordance: pull it right, click it, or
 * activate it with the keyboard.
 */
function renderMarketplacePanel(
  marketplace: MarketplaceState,
  options: { autofocusHandle?: boolean } = {},
) {
  const drag = marketplace.drawerDrag;
  const title = t("dashboardsPage.marketplaceTitle");
  return html`<section class="dashboards-marketplace__panel" data-marketplace>
    <button
      type="button"
      class="dashboards-marketplace__handle"
      data-marketplace-handle
      aria-label=${t("dashboardsPage.marketplacePullClose")}
      ?autofocus=${options.autofocusHandle === true}
      @pointerdown=${(event: PointerEvent) => drag?.drawerHandlePointerDown(event)}
      @click=${() => {
        if (drag?.consumeDragActivation()) {
          return;
        }
        marketplace.closeMarketplace();
      }}
    >
      <span class="dashboards-marketplace__handle-ridges" aria-hidden="true"></span>
    </button>
    <header class="dashboards-marketplace__header">
      <div>
        <h2>${title}</h2>
        <p>${t("dashboardsPage.marketplaceDescription")}</p>
      </div>
    </header>
    <div class="dashboards-marketplace__body">
      <ul class="dashboards-marketplace__list">
        ${MARKETPLACE_PRESETS.map((preset) => renderPresetCard(preset, marketplace))}
      </ul>
    </div>
  </section>`;
}

/** Drag-preview: the drawer following the pointer before the modal owns it. */
export function renderMarketplacePreview(marketplace: MarketplaceState) {
  return html`<div
    class="dashboards-marketplace-drawer-preview"
    data-marketplace-preview
    aria-hidden="true"
    inert
  >
    ${renderMarketplacePanel(marketplace)}
  </div>`;
}

export function renderMarketplace(marketplace: MarketplaceState) {
  const title = t("dashboardsPage.marketplaceTitle");
  return html`<openclaw-modal-dialog
    class="drawer dashboards-marketplace ${
      marketplace.dragActive ? "dashboards-marketplace--landing" : ""
    }"
    style="--openclaw-modal-width: min(440px, 100vw);"
    label=${title}
    description=${t("dashboardsPage.marketplaceDescription")}
    @modal-cancel=${() => marketplace.closeMarketplace()}
  >
    ${renderMarketplacePanel(marketplace, { autofocusHandle: true })}
  </openclaw-modal-dialog>`;
}
