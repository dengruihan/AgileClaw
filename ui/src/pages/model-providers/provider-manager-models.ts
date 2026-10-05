import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";

/** Interactive members the provider-manager models list reads and calls. */
export type ProviderModelsActions = {
  onAdd: () => void;
  onDelete: (id: string) => void;
  onEdit: (row: Record<string, unknown>) => void;
  onRefresh: () => void;
  onRestore: (id: string) => void;
};

export type ProviderModelsListState = {
  /** Rows with a user-added definition; their badge marks them as added. */
  addedRows: ReadonlySet<string>;
  /** Rows with any authored config entry; the badge marks them as overrides. */
  configuredRows: ReadonlySet<string>;
  disabled: boolean;
  /** Deleted endpoint-listed rows, restorable from the collapsed section. */
  hiddenRows: readonly Record<string, unknown>[];
  loading: boolean;
  rows: readonly Record<string, unknown>[];
};

/** Model list body for one provider-manager dialog. */
export function providerModelsList(params: {
  actions: ProviderModelsActions;
  state: ProviderModelsListState;
}): TemplateResult {
  const { actions, state } = params;
  const modelRow = (row: Record<string, unknown>, hidden: boolean) => {
    const id = String(row.id);
    const badge = hidden
      ? nothing
      : html`<span class="provider-manager__badge">
          ${t(
            state.addedRows.has(id)
              ? "modelProviders.manager.userAdded"
              : state.configuredRows.has(id)
                ? "modelProviders.manager.override"
                : "modelProviders.manager.builtIn",
          )}
        </span>`;
    return html`<article class="provider-manager__model" data-model-id=${id}>
      <div>
        <strong>${row.name ?? id}</strong>
        <div class="muted provider-manager__model-id">${id}</div>
        <small
          >${Array.isArray(row.input) ? row.input.join(" · ") : t("modelProviders.manager.inherited")}</small
        >
      </div>
      ${badge}
      <div class="provider-manager__actions">
        ${
          hidden
            ? html`<button
                type="button"
                class="btn btn--sm"
                ?disabled=${state.disabled}
                @click=${() => actions.onRestore(id)}
              >
                ${t("modelProviders.manager.showModel")}
              </button>`
            : html`<button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${state.disabled}
                  @click=${() => actions.onEdit(row)}
                >
                  ${t("modelProviders.manager.editModel")}
                </button>
                <button
                  type="button"
                  class="btn btn--sm danger"
                  ?disabled=${state.disabled}
                  @click=${() => actions.onDelete(id)}
                >
                  ${t("common.delete")}
                </button>`
        }
      </div>
    </article>`;
  };
  return html` <p class="muted">${t("modelProviders.manager.modelScope")}</p>
    <div class="provider-manager__model-list">${state.rows.map((row) => modelRow(row, false))}</div>
    ${
      !state.rows.length && !state.hiddenRows.length && !state.loading
        ? html`<p>${t("modelProviders.manager.noModels")}</p>`
        : nothing
    }
    ${
      state.hiddenRows.length
        ? html`<details class="provider-manager__hidden">
            <summary>
              ${t("modelProviders.manager.hiddenModels", {
                count: String(state.hiddenRows.length),
              })}
            </summary>
            <div class="provider-manager__model-list provider-manager__hidden-list">
              ${state.hiddenRows.map((row) => modelRow(row, true))}
            </div>
          </details>`
        : nothing
    }
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
