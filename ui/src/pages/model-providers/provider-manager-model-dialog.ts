import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

/** Model editing uses a separate form so connection drafts never submit with it. */
export function providerModelDialog(props: {
  providerLabel: string;
  body: TemplateResult;
  busy: boolean;
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  return html`<openclaw-modal-dialog
    class="provider-manager-dialog"
    label=${t("modelProviders.manager.editModel")}
    @modal-cancel=${(event: Event) => {
      event.preventDefault();
      props.onCancel();
    }}
  >
    <form
      class="provider-manager provider-manager--model"
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <header class="provider-manager__header">
        <div>
          <h2>${t("modelProviders.manager.editModel")}</h2>
          <span class="muted">${props.providerLabel}</span>
        </div>
        <button
          type="button"
          class="btn btn--icon"
          aria-label=${t("common.close")}
          ?disabled=${props.busy}
          @click=${props.onCancel}
        >
          ×
        </button>
      </header>
      <div class="provider-manager__body">${props.body}</div>
      <footer class="provider-manager__footer">
        <button
          type="button"
          class="btn btn--ghost"
          ?disabled=${props.disabled}
          @click=${props.onReset}
        >
          ${t("modelProviders.manager.resetForm")}
        </button>
        <div class="provider-manager__actions">
          <button type="button" class="btn" ?disabled=${props.busy} @click=${props.onCancel}>
            ${t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" ?disabled=${props.disabled}>
            ${t("common.save")}
          </button>
        </div>
      </footer>
    </form>
  </openclaw-modal-dialog>`;
}
