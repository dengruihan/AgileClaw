import { html, nothing, type TemplateResult } from "lit";
import type { ModelProviderTemplate } from "../../api/types.ts";
import {
  objectAdditionalPropertiesSchema,
  objectPropertySchema,
} from "../../components/config-form.constraints.ts";
import { analyzeConfigSchema, type JsonSchema } from "../../components/config-form.ts";
import { t } from "../../i18n/index.ts";

type TemplateProps = {
  templates: ModelProviderTemplate[];
  templateQuery: string;
  selectedTemplate: string;
  disabled: boolean;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
};
type ModelsProps = {
  rows: Record<string, unknown>[];
  disabled: boolean;
  discovering: boolean;
  discover: () => void;
  editModel: (row?: Record<string, unknown>) => void;
  deleteModel: (row: Record<string, unknown>) => void;
};
type EditorProps = ModelsProps & {
  providerSchema: JsonSchema | null;
  fields: TemplateResult | typeof nothing;
  draft: Record<string, unknown>;
  hasKey: boolean;
  keyDraft: string;
  revealKey: boolean;
  clearKey: boolean;
  onName: (value: string) => void;
  onKey: (value: string) => void;
  onReveal: () => void;
  onClear: (value: boolean) => void;
};

export function renderProviderTemplates(props: TemplateProps) {
  const query = props.templateQuery.trim().toLowerCase();
  const matching = props.templates.filter((entry) =>
    `${entry.name} ${entry.id}`.toLowerCase().includes(query),
  );
  const option = (id: string, name: string, baseUrl?: unknown) => html`<label
    class="provider-manager__template ${props.selectedTemplate === id ? "provider-manager__template--selected" : ""}"
  >
    <input
      type="radio"
      name="providerTemplate"
      .value=${id}
      .checked=${props.selectedTemplate === id}
      ?disabled=${props.disabled}
      @change=${() => {
        props.onSelect(id);
      }}
    />
    <span><strong>${name}</strong>${baseUrl ? html`<small>${baseUrl}</small>` : nothing}</span>
  </label>`;
  return html`<p class="muted">${t("modelProviders.manager.templateHelp")}</p>
    <label class="field"
      ><span>${t("modelProviders.manager.searchTemplates")}</span
      ><input
        type="search"
        name="templateSearch"
        .value=${props.templateQuery}
        @input=${(event: Event) => {
          props.onQuery((event.target as HTMLInputElement).value);
        }}
    /></label>
    <div class="provider-manager__templates">
      ${option("custom", t("modelProviders.manager.customProvider"))}${matching.map((entry) => option(entry.id, entry.name, entry.defaults.baseUrl))}
    </div>
    ${!matching.length && query ? html`<p>${t("modelProviders.noMatches")}</p>` : nothing}`;
}
export function renderProviderModels(props: ModelsProps) {
  return html`<section class="provider-manager__models">
    <div class="provider-manager__section-header">
      <h3>${t("modelProviders.manager.models")}</h3>
      <span class="muted">${props.rows.length}</span>
    </div>
    <p class="muted">${t("modelProviders.manager.discoveryHelp")}</p>
    <div class="provider-manager__actions">
      <button
        type="button"
        class="btn"
        ?disabled=${props.disabled || props.discovering}
        @click=${() => void props.discover()}
      >
        ${t(props.discovering ? "modelProviders.manager.pullingModels" : "modelProviders.manager.refreshModels")}
      </button>
      <button
        type="button"
        class="btn"
        ?disabled=${props.disabled}
        @click=${() => props.editModel()}
      >
        ${t("modelProviders.manager.addModel")}
      </button>
    </div>
    <div class="provider-manager__model-list">
      ${props.rows.map(
        (row) => html`<article class="provider-manager__model" data-model-id=${row.id}>
          <div>
            <strong>${row.name ?? row.id}</strong>
            <div class="muted provider-manager__model-id">${row.id}</div>
            <small>${Array.isArray(row.input) ? row.input.join(" · ") : ""}</small>
          </div>
          <span class="provider-manager__badge"
            >${t(row.metadataSource === "provider-discovery" ? "modelProviders.manager.discovered" : "modelProviders.manager.userAdded")}</span
          >
          <div class="provider-manager__actions">
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${props.disabled}
              @click=${() => props.editModel(row)}
            >
              ${t("modelProviders.manager.editModel")}</button
            ><button
              type="button"
              class="btn btn--sm danger"
              ?disabled=${props.disabled}
              @click=${() => props.deleteModel(row)}
            >
              ${t("common.delete")}
            </button>
          </div>
        </article>`,
      )}
    </div>
    ${!props.rows.length ? html`<p>${t("modelProviders.manager.noModels")}</p>` : nothing}
  </section>`;
}
export function renderProviderEditor(props: EditorProps) {
  const schema = props.providerSchema;
  return html`<p class="muted">${t("modelProviders.manager.draftHelp")}</p>
    <label class="field"
      ><span>${t("modelProviders.manager.providerName")}</span
      ><input
        name="providerName"
        required
        .value=${String(props.draft.name ?? "")}
        ?disabled=${props.disabled}
        @input=${(event: Event) => props.onName((event.target as HTMLInputElement).value)}
    /></label>
    ${schema ? props.fields : html`<p>${t("modelProviders.configUnavailable")}</p>`}
    <label class="field"
      ><span>${t("modelProviders.apiKey.label")}</span>
      <div class="provider-manager__key">
        <input
          name="apiKey"
          type=${props.revealKey ? "text" : "password"}
          autocomplete="new-password"
          placeholder=${t(props.hasKey ? "modelProviders.manager.keepKey" : "modelProviders.apiKey.placeholder")}
          .value=${props.keyDraft}
          ?disabled=${props.disabled || props.clearKey}
          @input=${(event: Event) => {
            props.onKey((event.target as HTMLInputElement).value);
          }}
        /><button
          type="button"
          class="btn btn--sm"
          aria-pressed=${props.revealKey}
          @click=${() => {
            props.onReveal();
          }}
        >
          ${t(props.revealKey ? "modelProviders.manager.hideKey" : "modelProviders.manager.showKey")}
        </button>
      </div></label
    >
    ${
      props.hasKey
        ? html`<label class="provider-manager__clear-key"
            ><input
              type="checkbox"
              .checked=${props.clearKey}
              ?disabled=${props.disabled}
              @change=${(event: Event) => {
                props.onClear((event.target as HTMLInputElement).checked);
              }}
            />${t("modelProviders.manager.clearKey")}</label
          >`
        : nothing
    }
    ${renderProviderModels(props)}`;
}

export function providerManagerSchema(source: unknown) {
  const analysis = analyzeConfigSchema(source);
  const models = analysis.schema && objectPropertySchema(analysis.schema, "models");
  const providers = models && objectPropertySchema(models, "providers");
  const provider = providers && objectAdditionalPropertiesSchema(providers);
  const array = provider && objectPropertySchema(provider, "models");
  const model = array && (Array.isArray(array.items) ? array.items[0] : array.items);
  return {
    provider: provider || null,
    model: model || null,
    unsupported: new Set(analysis.unsupportedPaths),
  };
}
