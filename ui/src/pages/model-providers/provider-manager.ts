import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { ModelCatalogEntry, ModelCatalogResult, ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  objectAdditionalPropertiesSchema,
  objectPropertySchema,
  objectPropertyKeys,
} from "../../components/config-form.constraints.ts";
import { analyzeConfigSchema, renderNode, type JsonSchema } from "../../components/config-form.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import "../../styles/config.css";
import { setPathValue, removePathValue } from "../../lib/config-form-utils.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import { providerConnectionFields } from "./provider-manager-connection.ts";
import {
  configuredProvider,
  providerConnectionPatch,
  modelReferences,
  modelRemovePatch,
  modelWritePatch,
  providerModels,
  type ProviderModelsPatch,
} from "./provider-model-config.ts";

registerSettingsEnglish();

export type ProviderManagerIntent = { provider: string; view: "settings" | "models" | "create" };
type CredentialResult = { ok: false; error?: string } | { ok: true; warning: string | null };
const providerBasics = ["baseUrl", "api", "auth"];
const modelBasics = [
  "name",
  "id",
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
  @property({ type: Boolean }) customProvider = false;
  @property({ attribute: false }) probe: ModelsProbeResult | undefined;
  @property({ attribute: false }) onClose: () => void = () => {};
  @property({ attribute: false }) onRefresh: () => void = () => {};
  @property({ attribute: false }) onProbe: () => void = () => {};
  @property({ attribute: false }) onConnect: () => void = () => {};
  @property({ attribute: false }) onCredential: (
    provider: string,
    key: string | null,
  ) => Promise<CredentialResult | undefined> = async () => undefined;
  @state() private draft: Record<string, unknown> = {};
  @state() private providerId = "";
  @state() private keyDraft = "";
  @state() private revealKey = false;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private busy = false;
  @state() private loading = false;
  @state() private catalog: ModelCatalogEntry[] = [];
  @state() private modelDraft: Record<string, unknown> | null = null;
  private original: Record<string, unknown> = {};
  private originalModelId: string | undefined;
  private originalModel: Record<string, unknown> | undefined;
  private schemaSource: unknown;
  private schemaCache: {
    provider: JsonSchema | null;
    model: JsonSchema | null;
    unsupported: Set<string>;
  } | null = null;
  private generation = 0;
  private touched = new Set<string>();
  private listScrollTop = 0;
  private providerCreated = false;
  @state() private revealedPaths = new Set<string>();

  override willUpdate(changed: PropertyValues<ProviderManager>) {
    if (changed.has("intent") || changed.has("agentId") || changed.has("context")) {
      this.generation += 1;
      this.busy = false;
      this.loading = false;
      this.error = this.notice = null;
      this.modelDraft = null;
      this.keyDraft = "";
      this.revealKey = false;
      this.touched.clear();
      this.providerCreated = false;
      this.revealedPaths = new Set();
      this.providerId = this.intent?.provider ?? "";
      this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
      this.draft = structuredClone(this.original);
      this.catalog = [];
      if (this.intent) {
        void this.load();
      }
    }
  }

  override disconnectedCallback() {
    this.generation += 1;
    super.disconnectedCallback();
  }

  private get config() {
    return currentConfigObject(this.context.runtimeConfig.state);
  }

  private get blocked() {
    return modelProviderConfigMutationBlockedReason(this.context);
  }

  private get disabled() {
    const blocked = Boolean(this.blocked) || modelProviderConfigBusy(this.context);
    return this.busy || this.loading || blocked;
  }

  private get dirty() {
    return (
      this.keyDraft.trim() !== "" ||
      [...this.touched].some(
        (key) => JSON.stringify(this.draft[key]) !== JSON.stringify(this.original[key]),
      )
    );
  }

  private schema() {
    const source = this.context.runtimeConfig.state.configSchema;
    if (this.schemaCache && source === this.schemaSource) {
      return this.schemaCache;
    }
    this.schemaSource = source;
    const analysis = analyzeConfigSchema(source);
    const models = analysis.schema && objectPropertySchema(analysis.schema, "models");
    const providers = models && objectPropertySchema(models, "providers");
    const provider = providers && objectAdditionalPropertiesSchema(providers);
    const array = provider && objectPropertySchema(provider, "models");
    const model = array && (Array.isArray(array.items) ? array.items[0] : array.items);
    this.schemaCache = {
      provider: provider || null,
      model: model || null,
      unsupported: new Set(analysis.unsupportedPaths),
    };
    return this.schemaCache;
  }

  private async load(refresh = false) {
    const client = this.context.gateway.snapshot.client;
    const generation = this.generation;
    const current = () =>
      this.isConnected &&
      this.generation === generation &&
      this.context.gateway.snapshot.client === client;
    if (!client || !this.intent) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      await this.context.runtimeConfig.ensureLoaded();
      if (!current()) {
        return;
      }
      if (!this.touched.size && !this.providerCreated) {
        this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
        this.draft = structuredClone(this.original);
      }
      await this.context.runtimeConfig.ensureSchemaLoaded();
      if (!current()) {
        return;
      }
      if (this.intent.view !== "create") {
        const result = await client.request<ModelCatalogResult>("models.list", {
          agentId: this.agentId,
          provider: this.providerId,
          view: "provider-config",
          includeDetails: true,
          ...(refresh ? { refresh: true } : { preparedOnly: true }),
        });
        if (!current()) {
          return;
        }
        this.catalog = result.models;
        if (
          result.refreshFailed ||
          result.providerOutcomes?.some((outcome) => outcome.status !== "ready")
        ) {
          this.error = t("modelProviders.manager.refreshFailed");
        } else if (refresh) {
          this.notice = t("modelProviders.manager.refreshed");
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

  private field(
    schema: JsonSchema,
    fieldKey: string,
    value: Record<string, unknown>,
    model = false,
  ) {
    const fieldSchema = objectPropertySchema(schema, fieldKey);
    if (!fieldSchema) {
      return nothing;
    }
    const prefix: Array<string | number> = ["models", "providers", this.providerId || "custom"];
    if (model) {
      prefix.push("models", 0);
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
        this.draft = candidate;
        this.touched.add(fieldKey);
      }
    };
    return renderNode({
      schema: fieldSchema,
      value: value[fieldKey],
      path: [...prefix, fieldKey],
      hints: this.context.runtimeConfig.state.configUiHints,
      unsupported: this.schema().unsupported,
      disabled: this.disabled || (model && fieldKey === "id" && this.originalModelId !== undefined),
      isRequired: schema.required?.includes(fieldKey),
      compact: true,
      maskSensitive: true,
      isSensitivePathRevealed: (path) => this.revealedPaths.has(JSON.stringify(path)),
      onToggleSensitivePath: (path) => {
        const next = new Set(this.revealedPaths);
        const key = JSON.stringify(path);
        if (!next.delete(key)) {
          next.add(key);
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
    return html` <div class="provider-manager__fields">
        ${basics.map((key) => this.field(schema, key, value, model))}
      </div>
      <details class="provider-manager__advanced">
        <summary>${t("modelProviders.manager.advanced")}</summary>
        <div class="provider-manager__fields">
          ${objectPropertyKeys(schema)
            .filter(
              (key) =>
                !basics.includes(key) && !["models", "apiKey", "metadataSource"].includes(key),
            )
            .map((key) => this.field(schema, key, value, model))}
        </div>
      </details>`;
  }

  private async write(
    build: (config: Record<string, unknown>) => ProviderModelsPatch | { error: string },
  ) {
    if (this.disabled) {
      return false;
    }
    const client = this.context.gateway.snapshot.client;
    const generation = this.generation;
    const agentId = this.agentId;
    const current = () =>
      this.isConnected &&
      this.generation === generation &&
      this.context.gateway.snapshot.client === client &&
      this.agentId === agentId;
    this.busy = true;
    this.error = this.notice = null;
    try {
      const saved = await this.context.runtimeConfig.patchFromSnapshot((config) => {
        const result = build(config);
        return "error" in result
          ? result
          : {
              options: {
                ...result,
                note: t("modelProviders.manager.saved"),
                canDispatch: () => current() && !this.blocked,
              },
            };
      });
      if (!current()) {
        return false;
      }
      if (!saved) {
        this.error =
          this.context.runtimeConfig.state.lastError ?? t("modelProviders.requestFailed");
        return false;
      }
      this.notice = t("modelProviders.manager.saved");
      this.onRefresh();
      return true;
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
      return false;
    } finally {
      if (current()) {
        this.busy = false;
      }
    }
  }

  private async saveConnection() {
    if (this.disabled || !this.querySelector<HTMLFormElement>("form")?.reportValidity()) {
      return;
    }
    // A retry after a failed credential save must start clean: the stale error
    // would otherwise keep the dialog open and visible after a successful retry.
    this.error = this.notice = null;
    const creating = this.intent?.view === "create";
    const id = this.providerId.trim();
    if (
      !id ||
      ["__proto__", "constructor", "prototype"].includes(id) ||
      (creating && !this.providerCreated && configuredProvider(this.config, id))
    ) {
      this.error = t("modelProviders.manager.duplicateProvider");
      return;
    }
    if (creating && !this.draft.baseUrl) {
      this.error = t("modelProviders.manager.urlRequired");
      return;
    }
    const { raw, replacePaths } = providerConnectionPatch(
      this.original,
      this.draft,
      this.touched,
      id,
    );
    if (creating && !this.providerCreated) {
      raw.models = {
        providers: {
          [id]: { ...this.draft, api: this.draft.api ?? "openai-completions", models: [] },
        },
      };
    }
    const generation = this.generation;
    if ((creating && !this.providerCreated) || this.touched.size) {
      if (
        !(await this.write((config) => {
          const latest = configuredProvider(config, id);
          if (
            (creating && !this.providerCreated && latest) ||
            [...this.touched].some(
              (key) => JSON.stringify(latest?.[key]) !== JSON.stringify(this.original[key]),
            )
          ) {
            return { error: t("modelProviders.manager.conflict") };
          }
          return { raw, replacePaths };
        }))
      ) {
        return;
      }
      if (generation !== this.generation) {
        return;
      }
      this.providerCreated ||= creating;
      this.original = structuredClone(configuredProvider(this.config, id) ?? this.draft);
      this.draft = structuredClone(this.original);
      this.touched.clear();
    }
    if (this.keyDraft.trim()) {
      this.busy = true;
      try {
        const result = await this.onCredential(id, this.keyDraft.trim());
        if (generation !== this.generation) {
          return;
        }
        if (!result?.ok) {
          this.error = [t("modelProviders.manager.credentialsFailed"), result?.error]
            .filter(Boolean)
            .join(" ");
          return;
        }
        this.keyDraft = "";
        this.notice = result.warning ?? t("modelProviders.manager.saved");
      } catch (error) {
        if (generation === this.generation) {
          this.error = formatUiError(error);
        }
      } finally {
        if (generation === this.generation) {
          this.busy = false;
        }
      }
    }
    if (creating && generation === this.generation && !this.error) {
      this.onClose();
    }
  }

  private editModel(model?: ModelCatalogEntry | Record<string, unknown>) {
    this.listScrollTop = this.querySelector(".provider-manager__body")?.scrollTop ?? 0;
    const configured =
      model && providerModels(this.config, this.providerId).find((row) => row.id === model.id);
    this.originalModel = configured ? structuredClone(configured) : undefined;
    this.modelDraft = configured
      ? structuredClone(configured)
      : model
        ? { id: model.id, name: model.name }
        : { id: "", name: "", input: ["text"] };
    this.originalModelId = model && typeof model.id === "string" ? model.id : undefined;
    this.error = this.notice = null;
  }

  private async backToModels() {
    this.modelDraft = null;
    await this.updateComplete;
    const body = this.querySelector(".provider-manager__body");
    if (body) {
      body.scrollTop = this.listScrollTop;
    }
  }

  private async saveModel() {
    if (!this.modelDraft || !this.querySelector<HTMLFormElement>("form")?.reportValidity()) {
      return;
    }
    const draftId = this.modelDraft.id;
    const draftName = this.modelDraft.name;
    const text = (value: unknown) => (typeof value === "string" ? value : "").trim();
    const model = { ...this.modelDraft, id: text(draftId), name: text(draftName) };
    if (
      !model.id ||
      !model.name ||
      (!this.originalModelId && this.rows().some((row) => row.id === model.id))
    ) {
      this.error = t("modelProviders.manager.duplicateModel");
      return;
    }
    if (
      await this.write((config) => {
        const current = providerModels(config, this.providerId).find(
          (entry) => entry.id === (this.originalModelId ?? model.id),
        );
        if (JSON.stringify(current) !== JSON.stringify(this.originalModel)) {
          return { error: t("modelProviders.manager.conflict") };
        }
        return modelWritePatch(config, this.providerId, model, this.originalModelId);
      })
    ) {
      await this.backToModels();
    }
  }

  private rows() {
    const rows = new Map<string, ModelCatalogEntry | Record<string, unknown>>();
    this.catalog.forEach((row) => rows.set(row.id, row));
    providerModels(this.config, this.providerId).forEach((row) => {
      if (typeof row.id === "string") {
        rows.set(row.id, { ...rows.get(row.id), ...row });
      }
    });
    return [...rows.values()];
  }

  private async removeModel(id: string, added: boolean) {
    const original = providerModels(this.config, this.providerId).find((entry) => entry.id === id);
    if (
      await this.write((config) => {
        const current = providerModels(config, this.providerId).find((entry) => entry.id === id);
        if (JSON.stringify(current) !== JSON.stringify(original)) {
          return { error: t("modelProviders.manager.conflict") };
        }
        const references = added ? modelReferences(config, this.providerId, id) : [];
        if (references.length) {
          return {
            error: t("modelProviders.manager.referenced", { references: references.join(", ") }),
          };
        }
        return modelRemovePatch(config, this.providerId, id);
      })
    ) {
      await this.load();
    }
  }

  private async removeCredential() {
    const generation = this.generation;
    this.busy = true;
    try {
      const result = await this.onCredential(this.providerId, null);
      if (generation === this.generation) {
        this.error = result?.ok ? null : t("modelProviders.requestFailed");
        this.notice = result?.ok ? t("modelProviders.apiKey.removed") : null;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private renderModels() {
    if (this.modelDraft) {
      const schema = this.schema().model;
      return schema
        ? this.fields(schema, this.modelDraft, modelBasics, true)
        : html`<p>${t("modelProviders.configUnavailable")}</p>`;
    }
    return html` <p class="muted">${t("modelProviders.manager.modelScope")}</p>
      <div class="provider-manager__model-list">
        ${this.rows().map((row) => {
          const id = String(row.id);
          const configured = providerModels(this.config, this.providerId).find(
            (entry) => entry.id === id,
          );
          const added = this.customProvider || configured?.metadataSource === "models-add";
          return html`<article class="provider-manager__model" data-model-id=${id}>
            <div>
              <strong>${row.name ?? id}</strong>
              <div class="muted provider-manager__model-id">${id}</div>
              <small
                >${Array.isArray(row.input) ? row.input.join(" · ") : t("modelProviders.manager.inherited")}</small
              >
            </div>
            <span class="provider-manager__badge"
              >${t(added ? "modelProviders.manager.userAdded" : configured ? "modelProviders.manager.override" : "modelProviders.manager.builtIn")}</span
            >
            <div class="provider-manager__actions">
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${this.disabled}
                @click=${() => this.editModel(row)}
              >
                ${t("modelProviders.manager.editModel")}
              </button>
              ${configured ? html`<button type="button" class="btn btn--sm ${added ? "danger" : ""}" ?disabled=${this.disabled} @click=${() => this.removeModel(id, added)}>${t(added ? "common.delete" : "modelProviders.manager.reset")}</button>` : nothing}
            </div>
          </article>`;
        })}
      </div>
      ${!this.rows().length && !this.loading ? html`<p>${t("modelProviders.manager.noModels")}</p>` : nothing}
      <p class="muted">${t("modelProviders.manager.discoveryHelp")}</p>
      <div class="provider-manager__actions">
        <button
          type="button"
          class="btn"
          ?disabled=${this.disabled}
          @click=${() => this.load(true)}
        >
          ${t("modelProviders.manager.refreshModels")}</button
        ><button
          type="button"
          class="btn primary"
          ?disabled=${this.disabled}
          @click=${() => this.editModel()}
        >
          ${t("modelProviders.manager.addModel")}
        </button>
      </div>`;
  }

  override render() {
    if (!this.intent) {
      return nothing;
    }
    const creating = this.intent.view === "create";
    const models = this.intent.view === "models";
    const providerSchema = this.schema().provider;
    const title = creating
      ? t("modelProviders.manager.customProvider")
      : `${this.card?.displayName ?? this.providerId} — ${t(models ? (this.modelDraft ? "modelProviders.manager.editModel" : "modelProviders.manager.models") : "modelProviders.manager.settings")}`;
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
          void (models ? this.saveModel() : this.saveConnection());
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
          ${this.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
          ${this.blocked ? html`<p class="callout warning">${this.blocked}</p>` : nothing}
          ${
            models
              ? this.renderModels()
              : providerConnectionFields({
                  actions: {
                    onConnect: this.onConnect,
                    onProbe: this.onProbe,
                    onRemoveCredential: () => this.removeCredential(),
                    onProviderIdInput: (value) => {
                      this.providerId = value;
                    },
                    onKeyInput: (value) => {
                      this.keyDraft = value;
                    },
                    onToggleRevealKey: () => {
                      this.revealKey = !this.revealKey;
                    },
                  },
                  renderFields: (schema, draft) => this.fields(schema, draft, providerBasics),
                  state: {
                    agentId: this.agentId,
                    busy: this.busy,
                    card: this.card,
                    creating,
                    dirty: this.dirty,
                    disabled: this.disabled,
                    draft: this.draft,
                    keyDraft: this.keyDraft,
                    probe: this.probe,
                    providerCreated: this.providerCreated,
                    providerId: this.providerId,
                    revealKey: this.revealKey,
                    schema: providerSchema,
                  },
                })
          }
          ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
          ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
        </div>
        <footer class="provider-manager__footer">
          <button
            type="button"
            class="btn"
            ?disabled=${this.busy}
            @click=${() => (this.modelDraft ? this.backToModels() : this.onClose())}
          >
            ${t(this.modelDraft ? "common.back" : "common.cancel")}</button
          >${!models || this.modelDraft ? html`<button type="submit" class="btn primary" ?disabled=${this.disabled || (!creating && !models && !this.dirty)}>${t("common.save")}</button>` : nothing}
        </footer>
      </form>
    </openclaw-modal-dialog>`;
  }
}

if (!customElements.get("openclaw-provider-manager")) {
  customElements.define("openclaw-provider-manager", ProviderManager);
}
