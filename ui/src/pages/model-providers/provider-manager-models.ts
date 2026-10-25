import { html, nothing, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatContextTokenCapacity } from "../../lib/format.ts";

/** Interactive members the provider-manager models list reads and calls. */
export type ProviderModelsActions = {
  onAdd: () => void;
  onDelete: (id: string) => void;
  onEdit: (row: Record<string, unknown>) => void;
  onProbe: (id: string) => void;
};

export type ProviderModelsListState = {
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
    const inputs = Array.isArray(row.input) ? row.input.map((value) => String(value)) : [];
    // Text is the baseline capability, so only extras earn a chip; image and
    // video collapse into one visual label.
    const capabilities: string[] = [];
    if (inputs.includes("image") || inputs.includes("video")) {
      capabilities.push("vision");
    }
    if (inputs.includes("audio")) {
      capabilities.push("audio");
    }
    if (inputs.includes("document")) {
      capabilities.push("document");
    }
    const contextWindow =
      typeof row.contextWindow === "number" && Number.isFinite(row.contextWindow)
        ? row.contextWindow
        : undefined;
    return html`<li class="provider-manager__model" data-model-id=${id}>
      <div class="provider-manager__model-copy">
        <span class="provider-manager__model-name">${modelName}</span>
        ${
          id !== modelName
            ? html`<span class="muted provider-manager__model-id">${id}</span>`
            : nothing
        }
        ${
          capabilities.length
            ? capabilities.map(
                (capability) =>
                  html`<span class="provider-manager__model-chip"
                    >${t(`modelProviders.manager.capabilities.${capability}`)}</span
                  >`,
              )
            : inputs.length
              ? nothing
              : html`<span class="muted provider-manager__model-meta-fallback">
                  ${t("modelProviders.manager.inherited")}
                </span>`
        }
        ${
          contextWindow !== undefined
            ? html`<span class="provider-manager__model-chip"
                >${formatContextTokenCapacity(contextWindow)}</span
              >`
            : nothing
        }
      </div>
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
          class="btn btn--sm btn--icon"
          aria-label=${t("modelProviders.manager.editModel")}
          title=${t("modelProviders.manager.editModel")}
          ?disabled=${state.disabled}
          @click=${() => actions.onEdit(row)}
        >
          ${icons.edit}</button
        ><button
          type="button"
          class="btn btn--sm btn--icon danger"
          aria-label=${t("common.delete")}
          title=${t("common.delete")}
          ?disabled=${state.disabled}
          @click=${() => actions.onDelete(id)}
        >
          ${icons.trash}
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
    </li>`;
  };
  return html`<div class="provider-manager__list-toolbar">
      <h3>${t("modelProviders.manager.models")}</h3>
      <button type="button" class="btn btn--sm" ?disabled=${state.disabled} @click=${actions.onAdd}>
        ${icons.plus}${t("modelProviders.manager.addModel")}
      </button>
    </div>
    <ul class="provider-manager__model-list">
      ${state.rows.map((row) => modelRow(row))}
    </ul>
    ${
      !state.rows.length && !state.loading
        ? html`<p class="provider-manager__empty">${t("modelProviders.manager.noModels")}</p>`
        : nothing
    }`;
}
