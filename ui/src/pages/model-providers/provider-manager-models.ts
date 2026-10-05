import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

/** Interactive members the provider-manager models list reads and calls. */
export type ProviderModelsActions = {
  onAdd: () => void;
  onEdit: (row: Record<string, unknown>) => void;
  onRefresh: () => void;
  onRemove: (id: string, added: boolean) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
};

export type ProviderModelsListState = {
  /** Rows with a user-added definition; their button removes the definition. */
  addedRows: ReadonlySet<string>;
  /** Rows with any authored config entry; their button restores the default. */
  configuredRows: ReadonlySet<string>;
  disabled: boolean;
  /** Rows hidden from the invocable list by a config entry. */
  hiddenRows: ReadonlySet<string>;
  loading: boolean;
  rows: readonly Record<string, unknown>[];
};

/** Model list body for one provider-manager dialog. */
export function providerModelsList(params: {
  actions: ProviderModelsActions;
  state: ProviderModelsListState;
}): TemplateResult {
  const { actions, state } = params;
  return html` <p class="muted">${t("modelProviders.manager.modelScope")}</p>
    <div class="provider-manager__model-list">
      ${state.rows.map((row) => {
        const id = String(row.id);
        const added = state.addedRows.has(id);
        const hidden = state.hiddenRows.has(id);
        const badge = hidden
          ? "modelProviders.manager.hidden"
          : added
            ? "modelProviders.manager.userAdded"
            : state.configuredRows.has(id)
              ? "modelProviders.manager.override"
              : "modelProviders.manager.builtIn";
        return html`<article class="provider-manager__model" data-model-id=${id}>
          <div>
            <strong>${row.name ?? id}</strong>
            <div class="muted provider-manager__model-id">${id}</div>
            <small
              >${Array.isArray(row.input) ? row.input.join(" · ") : t("modelProviders.manager.inherited")}</small
            >
          </div>
          <span class="provider-manager__badge">${t(badge)}</span>
          <div class="provider-manager__actions">
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${state.disabled}
              @click=${() => actions.onEdit(row)}
            >
              ${t("modelProviders.manager.editModel")}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${state.disabled}
              @click=${() => actions.onToggleHidden(id, !hidden)}
            >
              ${t(hidden ? "modelProviders.manager.showModel" : "modelProviders.manager.hideModel")}
            </button>
            ${
              hidden
                ? added
                  ? html`<button
                      type="button"
                      class="btn btn--sm danger"
                      ?disabled=${state.disabled}
                      @click=${() => actions.onRemove(id, true)}
                    >
                      ${t("common.delete")}
                    </button>`
                  : nothing
                : state.configuredRows.has(id)
                  ? html`<button
                      type="button"
                      class="btn btn--sm ${added ? "danger" : ""}"
                      ?disabled=${state.disabled}
                      @click=${() => actions.onRemove(id, added)}
                    >
                      ${t(added ? "common.delete" : "modelProviders.manager.reset")}
                    </button>`
                  : nothing
            }
          </div>
        </article>`;
      })}
    </div>
    ${!state.rows.length && !state.loading ? html`<p>${t("modelProviders.manager.noModels")}</p>` : nothing}
    <p class="muted">${t("modelProviders.manager.discoveryHelp")}</p>
    <div class="provider-manager__actions">
      <button type="button" class="btn" ?disabled=${state.disabled} @click=${actions.onRefresh}>
        ${t("modelProviders.manager.refreshModels")}</button
      ><button
        type="button"
        class="btn primary"
        ?disabled=${state.disabled}
        @click=${actions.onAdd}
      >
        ${t("modelProviders.manager.addModel")}
      </button>
    </div>`;
}
