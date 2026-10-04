import { initialState, Task } from "@lit/task";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { renderSettingsLoadingSkeleton } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import type { ConfigRouteData } from "../config/route-data.ts";
import { providerRouteIntent } from "./provider-route-intent.ts";

class ModelCatalogSettings extends OpenClawLightDomElement {
  @property({ attribute: false }) routeData: ConfigRouteData | null = null;
  @property({ attribute: false }) runtimeConfig: RuntimeConfigCapability | null = null;
  @state() private expanded = false;

  private readonly editor = new Task(this, {
    args: () => [this.expanded, this.runtimeConfig] as const,
    task: async ([expanded, runtimeConfig]) => {
      if (!expanded || !runtimeConfig) {
        return initialState;
      }
      await Promise.all([
        import("../config/config-page.ts"),
        runtimeConfig.ensureLoaded().then(() => runtimeConfig.ensureSchemaLoaded()),
      ]);
      return true;
    },
  });

  override willUpdate(changed: PropertyValues<ModelCatalogSettings>) {
    const previous = changed.get("routeData");
    if (
      changed.has("routeData") &&
      (this.routeData?.search !== previous?.search || this.routeData?.hash !== previous?.hash) &&
      !providerRouteIntent(this.routeData) &&
      (this.routeData?.section === "models" ||
        this.routeData?.targetBlockId === "config-section-models")
    ) {
      this.expanded = true;
    }
  }

  override render() {
    return html`
      <details
        class="settings-section model-providers__catalog-settings"
        ?open=${this.expanded}
        @toggle=${(event: Event) => {
          this.expanded = (event.currentTarget as HTMLDetailsElement).open;
        }}
      >
        <summary class="model-providers__catalog-summary">
          <span class="settings-section__heading"
            >${t("modelProviders.catalogSettings.title")}</span
          >
          <span class="model-providers__catalog-description">
            ${t("modelProviders.catalogSettings.description")}
          </span>
        </summary>
        ${
          this.expanded
            ? html`
                <div class="model-providers__catalog-help">
                  <p>${t("modelProviders.catalogSettings.scope")}</p>
                  <p>${t("modelProviders.catalogSettings.catalog")}</p>
                </div>
                ${this.editor.render({
                  pending: () => renderSettingsLoadingSkeleton(),
                  complete: () => html`<openclaw-config-page
                    .pageId=${"model-providers"}
                    .routeData=${this.routeData}
                  ></openclaw-config-page>`,
                  error: (error) => html`<div class="callout danger" role="alert">
                    ${formatUiError(error)}
                    <button type="button" class="btn btn--sm" @click=${() => this.editor.run()}>
                      ${t("common.retry")}
                    </button>
                  </div>`,
                })}
              `
            : nothing
        }
      </details>
    `;
  }
}

if (!customElements.get("openclaw-model-catalog-settings")) {
  customElements.define("openclaw-model-catalog-settings", ModelCatalogSettings);
}
