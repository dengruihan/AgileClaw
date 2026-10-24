import { html, nothing, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

/** Interactive members the provider-manager models list reads and calls. */
export type ProviderModelsActions = {
  onAdd: () => void;
  onDelete: (id: string) => void;
  onEdit: (row: Record<string, unknown>) => void;
  onProbe: (id: string) => void;
};

export type ProviderModelsListState = {
  /** Rows with a user-added definition; their badge marks them as added. */
  addedRows: ReadonlySet<string>;
  /** Rows with any authored config entry; the badge marks them as overrides. */
  configuredRows: ReadonlySet<string>;
  disabled: boolean;
  loading: boolean;
  providerId: string;
  probeBlocked: boolean;
  probeResults: Record<string, ModelsProbeResult>;
  probeBusy: Record<string, boolean>;
  probeErrors: Record<string, { text: string }>;

  rows: readonly Record<string, unknown>[];
};

/** Model list body for one provider-manager dialog. */
export function providerModelsList(params: {
  actions: ProviderModelsActions;
  state: ProviderModelsListState;
}): TemplateResult {
  const { actions, state } = params;
  const modelRow = (row: Record<string, unknown>) => {
    const id = String(row.id);
    const modelName = typeof row.name === "string" && row.name.trim() ? row.name : id;
    const ref = `${state.providerId}/${id}`;
    const probing = state.probeBusy[`probe:${ref}`];
    const result = state.probeResults[ref];
    const error = state.probeErrors[ref]?.text;
    const badge = html`<span class="provider-manager__badge">
      ${t(
        state.addedRows.has(id)
          ? "modelProviders.manager.userAdded"
          : "modelProviders.manager.override",
      )}
    </span>`;
    return html`<article class="provider-manager__model" data-model-id=${id}>
      <div>
        <strong>${modelName}</strong>
        <div class="muted provider-manager__model-id">${id}</div>
        <small
          >${Array.isArray(row.input) ? row.input.join(" · ") : t("modelProviders.manager.inherited")}</small
        >
      </div>
      ${badge}
      <div class="provider-manager__actions">
        <button
          type="button"
          class="btn btn--sm btn--icon"
          aria-label=${t("modelProviders.probe.model", { model: modelName })}
          title=${t(state.probeBlocked ? "modelProviders.manager.saveBeforeTest" : "modelProviders.probe.test")}
          ?disabled=${state.disabled || state.probeBlocked || probing}
          @click=${() => actions.onProbe(id)}
        >
          ${probing ? icons.loader : icons.plug}</button
        ><button
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
        </button>
      </div>
      ${
        probing || result || error
          ? html`<p
              class="provider-manager__probe-result ${error || (result && result.status !== "ok") ? "provider-manager__probe-result--error" : "muted"}"
              role=${error || (result && result.status !== "ok") ? "alert" : "status"}
            >
              ${
                probing
                  ? t("modelProviders.probe.testing")
                  : (error ??
                    (result
                      ? html`
                          ${result.error ?? t(`modelProviders.probe.status.${result.status}`)}
                          ${result.latencyMs !== undefined ? html` · ${t("modelProviders.probe.latency", { ms: String(result.latencyMs) })}` : nothing}
                        `
                      : nothing))
              }
            </p>`
          : nothing
      }
    </article>`;
  };
  return html`<div class="provider-manager__list-toolbar">
      <h3>${t("modelProviders.manager.models")}</h3>
      <button type="button" class="btn btn--sm" ?disabled=${state.disabled} @click=${actions.onAdd}>
        ${icons.plus}${t("modelProviders.manager.addModel")}
      </button>
    </div>
    <p class="muted">${t("modelProviders.manager.modelScope")}</p>
    <div class="provider-manager__model-list">${state.rows.map((row) => modelRow(row))}</div>
    ${
      !state.rows.length && !state.loading
        ? html`<p class="provider-manager__empty">${t("modelProviders.manager.noModels")}</p>`
        : nothing
    }
    <p class="muted">${t("modelProviders.manager.modelsHelp")}</p> `;
}
