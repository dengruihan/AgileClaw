import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { ModelCatalogEntry, ModelCatalogResult, ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
} from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import { providerConnectionFields } from "./provider-manager-connection.ts";
import { providerModelDialog } from "./provider-manager-model-dialog.ts";
import {
  MODEL_THINKING_LEVEL_IDS,
  modelConfigEntry,
  providerModelForm,
} from "./provider-manager-model-form.ts";
import { providerModelsList } from "./provider-manager-models.ts";
import {
  configuredProvider,
  providerConnectionPatch,
  mergeProviderModelRows,
  modelDeletePatch,
  modelEntryHidden,
  modelReferences,
  modelRestorePatch,
  modelWritePatch,
  providerModels,
  type ProviderModelsPatch,
} from "./provider-model-config.ts";
import { renderProviderStatus } from "./view-status.ts";

registerSettingsEnglish();

export type ProviderManagerIntent = { provider: string; view: "settings" | "models" | "create" };
type CredentialResult = { ok: false; error?: string } | { ok: true; warning: string | null };

export class ProviderManager extends OpenClawLightDomElement {
  @property({ attribute: false }) context!: ApplicationContext;
  @property() agentId = "";
  @property({ attribute: false }) intent: ProviderManagerIntent | null = null;
  @property({ attribute: false }) card: ModelProviderCard | null = null;
  @property({ type: Boolean }) customProvider = false;
  @property({ attribute: false }) probe: ModelsProbeResult | undefined;
  @property({ attribute: false }) onCreated: (provider: string) => void = () => {};
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
  private initialModelDraft: Record<string, unknown> | null = null;
  private discardConfirmation: AbortController | null = null;
  private originalModel: Record<string, unknown> | undefined;
  /** Catalog thinking map the current model draft prefilled from, if any. */
  private modelThinkingPrefill: Record<string, unknown> | undefined;
  private generation = 0;
  private touched = new Set<string>();
  private listScrollTop = 0;
  private providerCreated = false;
  private focusModelsSection = false;

  override willUpdate(changed: PropertyValues<ProviderManager>) {
    if (changed.has("intent") || changed.has("agentId") || changed.has("context")) {
      this.discardConfirmation?.abort();
      this.generation += 1;
      this.busy = false;
      this.loading = false;
      this.error = this.notice = null;
      this.modelDraft = null;
      this.keyDraft = "";
      this.revealKey = false;
      this.touched.clear();
      this.providerCreated = false;
      this.providerId = this.intent?.provider ?? "";
      this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
      this.draft = structuredClone(this.original);
      this.catalog = [];
      this.focusModelsSection = this.intent?.view === "models";
      if (this.intent) {
        void this.load();
      }
    } else if (!this.dirty && !this.modelDraft && !this.busy) {
      this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
      this.draft = structuredClone(this.original);
    }
  }

  override disconnectedCallback() {
    this.discardConfirmation?.abort();
    this.generation += 1;
    super.disconnectedCallback();
  }

  override updated() {
    if (this.focusModelsSection) {
      this.focusModelsSection = false;
      this.querySelector(".provider-manager__models-section")?.scrollIntoView?.({
        block: "start",
      });
    }
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
    // A not-yet-created custom provider has nothing to list; after the first
    // save the merged view shows its model list like any configured provider.
    const listModels = this.intent.view !== "create" || this.providerCreated;
    this.loading = true;
    this.error = null;
    try {
      if (!this.touched.size && !this.providerCreated) {
        this.original = structuredClone(configuredProvider(this.config, this.providerId) ?? {});
        this.draft = structuredClone(this.original);
      }
      if (listModels) {
        const result = await client.request<ModelCatalogResult>("models.list", {
          agentId: this.agentId,
          provider: this.providerId,
          // The dialog manages the same merged list the picker serves:
          // discovery results plus authored config, including hidden rows.
          view: "all",
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

  private setDraftField(key: "baseUrl" | "api", value: string) {
    this.draft = { ...this.draft, [key]: value };
    this.touched.add(key);
  }

  private setModelFields(patch: Record<string, unknown>) {
    if (this.modelDraft) {
      this.modelDraft = { ...this.modelDraft, ...patch };
    }
  }

  private editModel(model?: ModelCatalogEntry | Record<string, unknown>) {
    this.listScrollTop = this.querySelector(".provider-manager__body")?.scrollTop ?? 0;
    const configured =
      model && providerModels(this.config, this.providerId).find((row) => row.id === model.id);
    this.originalModel = configured ? structuredClone(configured) : undefined;
    // Every row prefills the thinking levels it effectively runs with — its own
    // authored map, else the catalog's offered levels. The wire only carries the
    // level set ({id, label}[]), so prefilled values stay blank: the form's
    // blank-value rule passes the level's own name through to the provider.
    const catalogLevels = model
      ? this.catalog.find((row) => row.id === model.id)?.thinkingLevels
      : undefined;
    const catalogPrefill = catalogLevels
      ? Object.fromEntries(
          catalogLevels.flatMap(({ id }) => (MODEL_THINKING_LEVEL_IDS.has(id) ? [[id, ""]] : [])),
        )
      : undefined;
    const draft: Record<string, unknown> = configured
      ? structuredClone(configured)
      : model
        ? { id: model.id, name: model.name }
        : { id: "", name: "", input: ["text"] };
    const authoredMap = isRecord(draft.thinkingLevelMap);
    this.modelThinkingPrefill = authoredMap ? undefined : catalogPrefill;
    if (!authoredMap && catalogPrefill) {
      draft.thinkingLevelMap = catalogPrefill;
    }
    this.modelDraft = draft;
    this.initialModelDraft = structuredClone(draft);
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
    if (
      !this.modelDraft ||
      !this.querySelector<HTMLFormElement>(".provider-manager--model")?.reportValidity()
    ) {
      return;
    }
    const model = modelConfigEntry(this.modelDraft, this.originalModel, this.modelThinkingPrefill);
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

  private async deleteModel(id: string) {
    const original = providerModels(this.config, this.providerId).find((entry) => entry.id === id);
    const catalogRow = this.catalog.find((row) => row.id === id);
    if (
      await this.write((config) => {
        const current = providerModels(config, this.providerId).find((entry) => entry.id === id);
        if (JSON.stringify(current) !== JSON.stringify(original)) {
          return { error: t("modelProviders.manager.conflict") };
        }
        // Deleting keeps endpoint-discovered rows out of the invocable list;
        // a primary, fallback, or alias must not silently lose its target.
        const references = modelReferences(config, this.providerId, id);
        if (references.length) {
          return {
            error: t("modelProviders.manager.referenced", { references: references.join(", ") }),
          };
        }
        return modelDeletePatch(config, this.providerId, id, {
          listed: Boolean(catalogRow),
          name: catalogRow?.name,
        });
      })
    ) {
      await this.load();
    }
  }

  private async restoreModel(id: string) {
    const original = providerModels(this.config, this.providerId).find((entry) => entry.id === id);
    const catalogName = this.catalog.find((row) => row.id === id)?.name;
    if (
      await this.write((config) => {
        const current = providerModels(config, this.providerId).find((entry) => entry.id === id);
        if (JSON.stringify(current) !== JSON.stringify(original)) {
          return { error: t("modelProviders.manager.conflict") };
        }
        return modelRestorePatch(config, this.providerId, id, catalogName);
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

  private renderModelForm() {
    return providerModelForm({
      disabled: this.disabled,
      draft: this.modelDraft ?? {},
      inheritedInput: this.catalog.find((row) => row.id === this.modelDraft?.id)?.input,
      lockId: this.originalModelId !== undefined,
      onCostField: (key, value) => this.setCostField(key, value),
      onField: (patch) => this.setModelFields(patch),
      onThinkingMap: (map) => this.setModelFields({ thinkingLevelMap: map }),
      onThinkingValue: (level, value) => this.setThinkingValue(level, value),
    });
  }

  private setThinkingValue(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    value: string,
  ) {
    if (!this.modelDraft) {
      return;
    }
    const map = {
      ...(isRecord(this.modelDraft.thinkingLevelMap) ? this.modelDraft.thinkingLevelMap : {}),
      [level]: value,
    };
    this.setModelFields({ thinkingLevelMap: map });
  }

  private setCostField(key: "input" | "output" | "cacheRead" | "cacheWrite", value: string) {
    if (!this.modelDraft) {
      return;
    }
    const cost = { ...(isRecord(this.modelDraft.cost) ? this.modelDraft.cost : {}), [key]: value };
    this.setModelFields({ cost });
  }

  private renderModels() {
    const configRows = providerModels(this.config, this.providerId);
    const merged = mergeProviderModelRows(this.catalog, configRows);
    const hiddenIds = new Set(
      configRows.filter((entry) => modelEntryHidden(entry)).map((entry) => String(entry.id)),
    );
    return providerModelsList({
      actions: {
        onAdd: () => this.editModel(),
        onDelete: (id) => void this.deleteModel(id),
        onEdit: (row) => this.editModel(row),
        onRefresh: () => void this.load(true),
        onRestore: (id) => void this.restoreModel(id),
      },
      state: {
        addedRows: new Set(
          this.customProvider
            ? configRows.map((entry) => String(entry.id))
            : configRows
                .filter((entry) => entry.metadataSource === "models-add")
                .map((entry) => String(entry.id)),
        ),
        configuredRows: new Set(configRows.map((entry) => String(entry.id))),
        disabled: this.disabled,
        hiddenRows: merged.filter((row) => hiddenIds.has(String(row.id))),
        loading: this.loading,
        rows: merged.filter((row) => !hiddenIds.has(String(row.id))),
      },
    });
  }

  /** Provider switching keeps edits until the operator explicitly discards them. */
  async confirmLeave(): Promise<boolean> {
    if (this.busy || this.discardConfirmation) {
      return false;
    }
    const modelDirty =
      this.modelDraft !== null &&
      JSON.stringify(this.modelDraft) !== JSON.stringify(this.initialModelDraft);
    if (!this.dirty && !modelDirty && !(this.intent?.view === "create" && this.providerId)) {
      return true;
    }
    const controller = new AbortController();
    this.discardConfirmation = controller;
    try {
      return await showConfirmDialog({
        title: t("modelProviders.manager.unsavedTitle"),
        message: t("modelProviders.manager.unsavedDescription"),
        confirmLabel: t("modelProviders.manager.discard"),
        signal: controller.signal,
      });
    } finally {
      this.discardConfirmation = null;
    }
  }

  private resetConnection() {
    this.draft = structuredClone(this.original);
    this.touched.clear();
    this.keyDraft = "";
    this.revealKey = false;
    this.error = this.notice = null;
  }

  private renderMessages() {
    return html`${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
    ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}`;
  }

  override render() {
    if (!this.intent) {
      return nothing;
    }
    const creating = this.intent.view === "create" && !this.providerCreated;
    const title = creating
      ? t("modelProviders.manager.customProvider")
      : (this.card?.displayName ?? this.providerId);
    return html`${
        this.modelDraft
          ? providerModelDialog({
              providerLabel: this.card?.displayName ?? this.providerId,
              body: html`${this.renderModelForm()}${this.renderMessages()}`,
              busy: this.busy,
              disabled: this.disabled,
              onSave: () => void this.saveModel(),
              onCancel: () => {
                if (!this.busy) {
                  void this.backToModels();
                }
              },
              onReset: () => {
                this.modelDraft = structuredClone(this.initialModelDraft);
                this.error = this.notice = null;
              },
            })
          : nothing
      }
      <form
        class="provider-manager provider-manager--inline"
        ?inert=${Boolean(this.modelDraft)}
        @submit=${(event: Event) => {
          event.preventDefault();
          void this.saveConnection();
        }}
      >
        <header class="provider-manager__header">
          <div class="provider-manager__identity">
            ${renderProviderBrandIcon(this.providerId, { className: "model-providers__icon" })}
            <div>
              <h2>${title}</h2>
              <span class="muted">${this.providerId}</span>
            </div>
          </div>
          ${this.card ? renderProviderStatus(this.card) : nothing}
        </header>
        <div class="provider-manager__body">
          ${this.blocked ? html`<p class="callout warning">${this.blocked}</p>` : nothing}
          <div class="provider-manager__connection">
            ${providerConnectionFields({
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
                onFieldInput: (key, value) => this.setDraftField(key, value),
              },
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
              },
            })}
          </div>
          <footer class="provider-manager__footer">
            <span class="muted" role="status"
              >${this.dirty ? t("modelProviders.manager.unsaved") : nothing}</span
            >
            <div class="provider-manager__actions">
              <button
                type="button"
                class="btn"
                ?disabled=${this.disabled || !this.dirty}
                @click=${() => this.resetConnection()}
              >
                ${t("modelProviders.manager.resetForm")}
              </button>
              <button
                type="submit"
                class="btn primary"
                ?disabled=${this.disabled || (!creating && !this.dirty)}
              >
                ${this.busy ? t("modelProviders.saving") : t("common.save")}
              </button>
            </div>
          </footer>
          ${!this.modelDraft ? this.renderMessages() : nothing}
          ${
            !creating
              ? html`<section class="provider-manager__models-section">
                  ${this.renderModels()}
                </section>`
              : nothing
          }
        </div>
      </form>`;
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
    if (
      this.disabled ||
      !this.querySelector<HTMLFormElement>(".provider-manager--inline")?.reportValidity()
    ) {
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
      // The merged view continues in place; adopt the trimmed key the save used
      // so the in-dialog model list targets the created provider.
      this.providerId = id;
      this.original = structuredClone(
        configuredProvider(this.config, this.providerId) ?? this.draft,
      );
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
      this.onCreated(this.providerId);
      // Creation continues in place: the merged view lists models to add next.
      if (!this.loading) {
        void this.load();
      }
    }
  }
}

if (!customElements.get("openclaw-provider-manager")) {
  customElements.define("openclaw-provider-manager", ProviderManager);
}
