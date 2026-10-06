import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { modelProviderModelKey } from "../../../../src/config/model-provider-config.js";
import type {
  ModelProviderTemplate,
  ModelDiscoverResult,
  ModelProviderTemplatesResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  objectPropertyKeys,
  objectPropertySchema,
} from "../../components/config-form.constraints.ts";
import { renderNode, type JsonSchema } from "../../components/config-form.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { setPathValue, removePathValue } from "../../lib/config-form-utils.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/config.css";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import {
  renderProviderTemplates,
  renderProviderEditor,
  providerManagerSchema,
} from "./provider-manager-view.ts";
import {
  configuredProvider,
  providerNameConflict,
  modelReferences,
  providerConnectionPatch,
  providerModels,
  refreshProviderModels,
} from "./provider-model-config.ts";

registerSettingsEnglish();

export type ProviderManagerIntent = { provider: string; view: "settings" | "models" | "create" };
type CredentialResult = { ok: false; error?: string } | { ok: true; warning: string | null };
const providerBasics = ["baseUrl", "api"];
const modelBasics = [
  "id",
  "name",
  "input",
  "reasoning",
  "contextWindow",
  "contextTokens",
  "maxTokens",
];

export class ProviderManager extends OpenClawLightDomElement {
  @property({ attribute: false }) context!: ApplicationContext;
  @property() agentId = "";
  @property({ attribute: false }) intent: ProviderManagerIntent | null = null;
  @property({ attribute: false }) card: ModelProviderCard | null = null;
  @property({ attribute: false }) onClose: () => void = () => {};
  @property({ attribute: false }) onRefresh: () => void = () => {};
  @property({ attribute: false }) onCredential: (
    provider: string,
    key: string | null,
  ) => Promise<CredentialResult | undefined> = async () => undefined;
  @state() private draft: Record<string, unknown> = {};
  @state() private keyDraft = "";
  @state() private revealKey = false;
  @state() private clearKey = false;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private busy = false;
  @state() private loading = false;
  @state() private discovering = false;
  @state() private choosingTemplate = false;
  @state() private templates: ModelProviderTemplate[] = [];
  @state() private templateQuery = "";
  @state() private selectedTemplate = "custom";
  @state() private modelDraft: Record<string, unknown> | null = null;
  private providerId = "";
  private original: Record<string, unknown> = {};
  private originalModelIndex: number | undefined;
  private generation = 0;
  private revision = 0;
  private touched = new Set<string>();
  private providerCreated = false;
  private discoveryRequest: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private schemaSource: unknown;
  private schemaCache: ReturnType<typeof providerManagerSchema> | null = null;
  @state() private revealedPaths = new Set<string>();

  override willUpdate(changed: PropertyValues<ProviderManager>) {
    if (changed.has("intent") || changed.has("agentId") || changed.has("context")) {
      this.generation += 1;
      this.invalidateDiscovery();
      this.unsubscribe?.();
      this.unsubscribe = this.context.gateway.subscribe(() => {
        if (
          !this.context.gateway.snapshot.client ||
          this.context.gateway.snapshot.phase !== "connected"
        ) {
          this.invalidateDiscovery();
        }
        this.requestUpdate();
      });
      this.busy = this.loading = false;
      this.error = this.notice = null;
      this.modelDraft = null;
      this.keyDraft = "";
      this.revealKey = this.clearKey = false;
      this.touched.clear();
      this.providerCreated = false;
      this.revealedPaths = new Set();
      this.choosingTemplate = this.intent?.view === "create";
      this.templateQuery = "";
      this.selectedTemplate = "custom";
      this.providerId = this.choosingTemplate
        ? `provider-${crypto.randomUUID()}`
        : (this.intent?.provider ?? "");
      this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
      this.draft = structuredClone(this.original);
      if (this.intent) {
        void this.load();
      }
    }
  }

  override disconnectedCallback() {
    this.generation += 1;
    this.invalidateDiscovery();
    this.unsubscribe?.();
    super.disconnectedCallback();
  }

  private get config() {
    return currentConfigObject(this.context.runtimeConfig.state);
  }
  private get blocked() {
    return modelProviderConfigMutationBlockedReason(this.context);
  }
  private get disabled() {
    return (
      this.busy || this.loading || Boolean(this.blocked) || modelProviderConfigBusy(this.context)
    );
  }
  private get dirty() {
    return (
      this.clearKey ||
      this.keyDraft.trim() !== "" ||
      [...this.touched].some(
        (key) => JSON.stringify(this.draft[key]) !== JSON.stringify(this.original[key]),
      )
    );
  }
  private rows() {
    return Array.isArray(this.draft.models)
      ? this.draft.models.filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        )
      : [];
  }
  private invalidateDiscovery() {
    this.revision += 1;
    this.discoveryRequest?.abort();
    this.discoveryRequest = null;
    this.discovering = false;
  }
  private setField(key: string, value: unknown) {
    this.invalidateDiscovery();
    this.draft = { ...this.draft, [key]: value };
    this.touched.add(key);
    this.error = this.notice = null;
  }
  private schema() {
    const source = this.context.runtimeConfig.state.configSchema;
    if (this.schemaCache && source === this.schemaSource) {
      return this.schemaCache;
    }
    this.schemaSource = source;
    this.schemaCache = providerManagerSchema(source);
    return this.schemaCache;
  }
  private async load() {
    const client = this.context.gateway.snapshot.client;
    const generation = this.generation;
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      client === this.context.gateway.snapshot.client;
    if (!client || !this.intent) {
      return;
    }
    this.loading = true;
    try {
      await this.context.runtimeConfig.ensureLoaded();
      if (!current()) {
        return;
      }
      if (!this.choosingTemplate) {
        this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
        this.draft = {
          ...structuredClone(this.original),
          name: this.original.name ?? this.card?.displayName ?? this.providerId,
          models: providerModels(this.config, this.providerId),
        };
      }
      await this.context.runtimeConfig.ensureSchemaLoaded();
      if (!current()) {
        return;
      }
      if (this.choosingTemplate) {
        const result = await client.request<ModelProviderTemplatesResult>(
          "models.providerTemplates",
          {},
        );
        if (current()) {
          this.templates = result.templates;
        }
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.loading = false;
      }
    }
  }
  private chooseTemplate() {
    if (this.disabled) {
      return;
    }
    const template = this.templates.find((entry) => entry.id === this.selectedTemplate);
    this.draft = template
      ? { ...structuredClone(template.defaults), models: [] }
      : { name: "", baseUrl: "", api: "openai-completions", models: [] };
    this.choosingTemplate = false;
    this.touched = new Set(Object.keys(this.draft));
    this.error = this.notice = null;
    if (template && (!template.requiresApiKey || this.draft.apiKey)) {
      void this.discover();
    }
  }
  private field(schema: JsonSchema, key: string, value: Record<string, unknown>, model = false) {
    const fieldSchema = objectPropertySchema(schema, key);
    if (!fieldSchema) {
      return nothing;
    }
    const prefix: Array<string | number> = ["models", "providers", this.providerId];
    if (model) {
      prefix.push("models", this.originalModelIndex ?? this.rows().length);
    }
    const update = (path: Array<string | number>, next: unknown, remove = false) => {
      const candidate = structuredClone(value);
      if (remove || next === undefined) {
        removePathValue(candidate, path.slice(prefix.length));
      } else {
        setPathValue(candidate, path.slice(prefix.length), next);
      }
      if (model) {
        this.modelDraft = candidate;
      } else {
        this.invalidateDiscovery();
        this.draft = candidate;
        this.touched.add(key);
      }
    };
    return renderNode({
      schema: fieldSchema,
      value: value[key],
      path: [...prefix, key],
      hints: this.context.runtimeConfig.state.configUiHints,
      unsupported: this.schema().unsupported,
      disabled: this.disabled,
      isRequired: schema.required?.includes(key),
      compact: true,
      maskSensitive: true,
      isSensitivePathRevealed: (path) => this.revealedPaths.has(JSON.stringify(path)),
      onToggleSensitivePath: (path) => {
        const next = new Set(this.revealedPaths);
        const id = JSON.stringify(path);
        if (!next.delete(id)) {
          next.add(id);
        }
        this.revealedPaths = next;
      },
      onPatch: (path, next) => update(path, next),
      onRemove: (path) => update(path, undefined, true),
    });
  }
  private fields(
    schema: JsonSchema,
    value: Record<string, unknown>,
    basics: string[],
    model = false,
  ) {
    return html`<div class="provider-manager__fields">
        ${basics.map((key) => this.field(schema, key, value, model))}
      </div>
      <details class="provider-manager__advanced">
        <summary>${t("modelProviders.manager.advanced")}</summary>
        <div class="provider-manager__fields">
          ${objectPropertyKeys(schema)
            .filter(
              (key) =>
                !basics.includes(key) &&
                !["models", "apiKey", "metadataSource", "name", "hidden", "auth"].includes(key),
            )
            .map((key) => this.field(schema, key, value, model))}
        </div>
      </details>`;
  }
  private async discover() {
    if (this.disabled || this.discovering || !this.context.gateway.snapshot.client) {
      return;
    }
    if (typeof this.draft.baseUrl !== "string" || !this.draft.baseUrl.trim()) {
      this.error = t("modelProviders.manager.urlRequired");
      return;
    }
    const client = this.context.gateway.snapshot.client;
    const generation = this.generation;
    const revision = this.revision;
    const request = new AbortController();
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      revision === this.revision &&
      this.discoveryRequest === request &&
      client === this.context.gateway.snapshot.client;
    const config = structuredClone(this.draft);
    if (this.clearKey) {
      config.apiKey = "";
    } else if (this.keyDraft.trim()) {
      config.apiKey = this.keyDraft.trim();
    } else if (this.intent?.view !== "create" || this.providerCreated) {
      delete config.apiKey;
    }
    this.discoveryRequest = request;
    this.discovering = true;
    this.error = this.notice = null;
    try {
      const result = await client.request<ModelDiscoverResult>(
        "models.discover",
        {
          agentId: this.agentId,
          ...(this.intent?.view !== "create" || this.providerCreated
            ? { providerId: this.providerId }
            : {}),
          config,
        },
        { signal: request.signal },
      );
      if (!current()) {
        return;
      }
      const next = refreshProviderModels(
        this.rows(),
        result.models.map((row) => ({ ...row })),
        String(config.baseUrl),
      );
      const retained = new Set(
        next.map((row) => modelProviderModelKey(String(config.baseUrl), row)),
      );
      const references = this.rows()
        .filter((row) => !retained.has(modelProviderModelKey(String(config.baseUrl), row)))
        .flatMap((row) => modelReferences(this.config, this.providerId, String(row.id)));
      if (references.length) {
        this.error = t("modelProviders.manager.referenced", { references: references.join(", ") });
        return;
      }
      this.draft = { ...this.draft, models: next };
      this.touched.add("models");
      this.notice = result.models.length
        ? t("modelProviders.manager.refreshed", { count: String(result.models.length) })
        : t("modelProviders.manager.emptyDiscovery");
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error, t("modelProviders.manager.refreshFailed"));
      }
    } finally {
      if (this.discoveryRequest === request) {
        this.discoveryRequest = null;
        this.discovering = false;
      }
    }
  }
  private editModel(row?: Record<string, unknown>) {
    this.invalidateDiscovery();
    this.originalModelIndex = row ? this.rows().indexOf(row) : undefined;
    this.modelDraft = row ? structuredClone(row) : { id: "", name: "", input: ["text"] };
    this.error = this.notice = null;
  }
  private saveModel() {
    if (!this.modelDraft || !this.querySelector<HTMLFormElement>("form")?.reportValidity()) {
      return;
    }
    const model = {
      ...this.modelDraft,
      id: String(this.modelDraft.id ?? "").trim(),
      name: String(this.modelDraft.name ?? "").trim(),
      metadataSource: "models-add",
    };
    if (!model.id || !model.name) {
      this.error = t("modelProviders.manager.modelRequired");
      return;
    }
    const next = [...this.rows()];
    const previous =
      this.originalModelIndex === undefined ? undefined : next[this.originalModelIndex];
    const identity = modelProviderModelKey(String(this.draft.baseUrl ?? ""), model);
    if (
      next.some(
        (row, index) =>
          index !== this.originalModelIndex &&
          modelProviderModelKey(String(this.draft.baseUrl ?? ""), row) === identity,
      )
    ) {
      this.error = t("modelProviders.manager.duplicateModel");
      return;
    }
    if (previous && previous.id !== model.id) {
      const references = modelReferences(this.config, this.providerId, String(previous.id));
      if (references.length) {
        this.error = t("modelProviders.manager.referenced", { references: references.join(", ") });
        return;
      }
    }
    if (this.originalModelIndex === undefined) {
      next.push(model);
    } else {
      next[this.originalModelIndex] = model;
    }
    this.setField("models", next);
    this.modelDraft = null;
  }
  private deleteModel(row: Record<string, unknown>) {
    const references = modelReferences(this.config, this.providerId, String(row.id));
    if (references.length) {
      this.error = t("modelProviders.manager.referenced", { references: references.join(", ") });
      return;
    }
    this.setField(
      "models",
      this.rows().filter((entry) => entry !== row),
    );
  }
  private async save() {
    if (this.disabled || !this.querySelector<HTMLFormElement>("form")?.reportValidity()) {
      return;
    }
    this.invalidateDiscovery();
    const name = String(this.draft.name ?? "").trim();
    if (providerNameConflict(this.config, this.providerId, name)) {
      this.error = t("modelProviders.manager.duplicateProvider");
      return;
    }
    this.draft = { ...this.draft, name };
    this.touched.add("name");
    const creating = this.intent?.view === "create" && !this.providerCreated;
    const generation = this.generation;
    const client = this.context.gateway.snapshot.client;
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      client === this.context.gateway.snapshot.client;
    this.busy = true;
    this.error = this.notice = null;
    try {
      const saved = await this.context.runtimeConfig.patchFromSnapshot((config) => {
        const latest = configuredProvider(config, this.providerId);
        if (
          (creating && latest) ||
          (!creating &&
            [...this.touched].some(
              (key) => JSON.stringify(latest?.[key]) !== JSON.stringify(this.original[key]),
            ))
        ) {
          return { error: t("modelProviders.manager.conflict") };
        }
        const modelIds = new Set(this.rows().map((row) => String(row.id)));
        const references = providerModels(config, this.providerId)
          .filter((row) => !modelIds.has(String(row.id)))
          .flatMap((row) => modelReferences(config, this.providerId, String(row.id)));
        if (references.length) {
          return {
            error: t("modelProviders.manager.referenced", { references: references.join(", ") }),
          };
        }
        const patch = providerConnectionPatch(
          this.original,
          this.draft,
          creating ? new Set(Object.keys(this.draft)) : this.touched,
          this.providerId,
        );
        return {
          options: {
            ...patch,
            note: t("modelProviders.manager.saved"),
            canDispatch: () => current() && !this.blocked,
          },
        };
      });
      if (!current()) {
        return;
      }
      if (!saved) {
        this.error =
          this.context.runtimeConfig.state.lastError ?? t("modelProviders.requestFailed");
        return;
      }
      this.providerCreated ||= creating;
      this.original = structuredClone(
        configuredProvider(this.config, this.providerId) ?? this.draft,
      );
      this.draft = structuredClone(this.original);
      this.touched.clear();
      if (this.keyDraft.trim() || this.clearKey) {
        const result = await this.onCredential(
          this.providerId,
          this.clearKey ? null : this.keyDraft.trim(),
        );
        if (!current()) {
          return;
        }
        if (!result?.ok) {
          this.error = [t("modelProviders.manager.credentialsFailed"), result?.error]
            .filter(Boolean)
            .join(" ");
          return;
        }
        this.keyDraft = "";
        this.clearKey = false;
        this.original = structuredClone(
          configuredProvider(this.config, this.providerId) ?? this.draft,
        );
        this.draft = structuredClone(this.original);
        this.notice = result.warning ?? t("modelProviders.manager.saved");
      } else {
        this.notice = t("modelProviders.manager.saved");
      }
      this.onRefresh();
      if (!this.notice || this.notice === t("modelProviders.manager.saved")) {
        this.onClose();
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (!this.intent) {
      return nothing;
    }
    const title = this.choosingTemplate
      ? t("modelProviders.manager.addProvider")
      : this.modelDraft
        ? t("modelProviders.manager.editModel")
        : t("modelProviders.manager.editProvider");
    const modelSchema = this.schema().model;
    return html`<openclaw-modal-dialog
      class="provider-manager-dialog"
      label=${title}
      @modal-cancel=${(event: Event) => {
        event.preventDefault();
        if (!this.busy) {
          this.onClose();
        }
      }}
    >
      <form
        class="provider-manager"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (this.choosingTemplate) {
            this.chooseTemplate();
          } else if (this.modelDraft) {
            this.saveModel();
          } else {
            void this.save();
          }
        }}
      >
        <header class="provider-manager__header">
          <h2>${title}</h2>
          <button
            type="button"
            class="btn btn--icon"
            aria-label=${t("common.close")}
            ?disabled=${this.busy}
            @click=${this.onClose}
          >
            ×
          </button>
        </header>
        <div class="provider-manager__body">
          ${this.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}${this.blocked ? html`<p class="callout warning">${this.blocked}</p>` : nothing}
          ${
            this.choosingTemplate
              ? renderProviderTemplates({
                  templates: this.templates,
                  templateQuery: this.templateQuery,
                  selectedTemplate: this.selectedTemplate,
                  disabled: this.disabled,
                  onQuery: (query) => {
                    this.templateQuery = query;
                  },
                  onSelect: (id) => {
                    this.selectedTemplate = id;
                  },
                })
              : this.modelDraft
                ? modelSchema
                  ? html`<div data-model-editor>
                      ${this.fields(modelSchema, this.modelDraft, modelBasics, true)}
                    </div>`
                  : html`<p>${t("modelProviders.configUnavailable")}</p>`
                : renderProviderEditor({
                    providerSchema: this.schema().provider,
                    fields: this.schema().provider
                      ? this.fields(this.schema().provider!, this.draft, providerBasics)
                      : nothing,
                    draft: this.draft,
                    hasKey: Boolean(
                      this.original.apiKey ||
                      this.card?.hasConfigApiKey ||
                      this.card?.profiles.some((profile) => profile.type === "api_key"),
                    ),
                    keyDraft: this.keyDraft,
                    revealKey: this.revealKey,
                    clearKey: this.clearKey,
                    onName: (value) => this.setField("name", value),
                    onKey: (value) => {
                      this.invalidateDiscovery();
                      this.keyDraft = value;
                    },
                    onReveal: () => {
                      this.revealKey = !this.revealKey;
                    },
                    onClear: (value) => {
                      this.invalidateDiscovery();
                      this.clearKey = value;
                      if (value) {
                        this.keyDraft = "";
                      }
                    },
                    rows: this.rows(),
                    disabled: this.disabled,
                    discovering: this.discovering,
                    discover: () => void this.discover(),
                    editModel: (row) => this.editModel(row),
                    deleteModel: (row) => this.deleteModel(row),
                  })
          }
          ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
        </div>
        <footer class="provider-manager__footer">
          <button
            type="button"
            class="btn"
            ?disabled=${this.busy}
            @click=${() => {
              if (this.modelDraft) {
                this.modelDraft = null;
                this.error = this.notice = null;
              } else {
                this.onClose();
              }
            }}
          >
            ${t(this.modelDraft ? "common.back" : "common.cancel")}</button
          ><button
            type="submit"
            class="btn primary"
            ?disabled=${this.disabled || (!this.choosingTemplate && !this.modelDraft && this.intent.view !== "create" && !this.dirty)}
          >
            ${t(this.choosingTemplate ? "common.confirm" : this.modelDraft ? "modelProviders.manager.applyModel" : "common.save")}
          </button>
        </footer>
      </form></openclaw-modal-dialog
    >`;
  }
}
if (!customElements.get("openclaw-provider-manager")) {
  customElements.define("openclaw-provider-manager", ProviderManager);
}
