import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { ConfigRouteData } from "../config/route-data.ts";
import { createCatalogDiscoveryController } from "./catalog-discovery.ts";
import {
  buildDefaultsPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  modelProviderApiKeySuccess,
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelProviderErrorMessage,
  runModelProviderApiKeyMutation,
  runModelProviderConfigMutation,
  runModelProviderDeleteMutation,
  type ModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import { ModelProviderCoreLoader, type ModelProviderRefreshReason } from "./core-load.ts";
import { readModelProviderConfig, type DefaultsDraft, type ModelProviderCard } from "./data.ts";
import { ModelProviderDiscoveryController } from "./discovery-controller.ts";
import "./model-catalog-settings.ts";
import "./provider-manager.ts";
import { InstalledAgentsController } from "./installed-agents.ts";
import type { ModelProvidersData } from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import { ModelProbeController } from "./model-probe-controller.ts";
import { renderModelProvidersPageContent } from "./model-providers-page-view.ts";
import type { ProviderManager, ProviderManagerIntent } from "./provider-manager.ts";
import { providerDeletePatch, providerReferenceSites } from "./provider-model-config.ts";
import { providerRouteIntent } from "./provider-route-intent.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";

export class ModelProvidersPage extends OpenClawLightDomElement {
  readonly mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(this.context) ??
    (this.selectedAgentId ? null : t("agents.noAgents"));
  private readonly canMutate = (): boolean =>
    this.mutationBlockedReason() === null && !modelProviderConfigBusy(this.context);

  @consume({ context: applicationContext, subscribe: true })
  context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;
  @property({ attribute: false }) loaderPending = false;

  @state() data: ModelProvidersData | null = null;
  @state() busy: Record<string, boolean> = {};
  @state() messages: Record<string, ModelProviderRowMessage> = {};
  @state() probeResults: Record<string, ModelsProbeResult> = {};
  private providerDeleteConfirmation: AbortController | null = null;
  @state() providerQuery = "";
  private pendingConnection = false;
  @state() addProviderOpen = false;
  @state() managerIntent: ProviderManagerIntent | null = null;
  private initialManagerIntent: ProviderManagerIntent | null = null;
  private providerSelectionRevision = 0;

  providerIntent(cards: ModelProviderCard[]): ProviderManagerIntent | null {
    if (this.managerIntent) {
      return this.managerIntent;
    }
    if (
      this.initialManagerIntent &&
      cards.some((card) => (card.configKey ?? card.id) === this.initialManagerIntent?.provider)
    ) {
      return this.initialManagerIntent;
    }
    const card = cards.find((entry) => entry.id === this.providerQuery) ?? cards[0];
    const provider = card?.configKey ?? card?.id;
    if (!provider) {
      return null;
    }
    if (this.initialManagerIntent?.provider !== provider) {
      this.initialManagerIntent = { provider, view: "settings" };
    }
    return this.initialManagerIntent;
  }

  async selectProvider(intent: ProviderManagerIntent) {
    const manager = this.querySelector<ProviderManager>("openclaw-provider-manager");
    if (manager?.intent?.provider === intent.provider && manager.intent.view === intent.view) {
      return;
    }
    const revision = ++this.providerSelectionRevision;
    if (manager && !(await manager.confirmLeave())) {
      return;
    }
    if (revision === this.providerSelectionRevision && this.isConnected) {
      this.managerIntent = intent;
    }
  }
  @state() addProviderId = "";
  @state() addProviderKey = "";
  @state() defaultsDraft: DefaultsDraft | null = null;
  @state() selectedAgentId = "";
  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private routeDataObserved = false;
  private managerRouteLocation: string | null = null;
  private pendingManagerRoute: ConfigRouteData | null = null;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private coreCatalogGeneration = 0;
  readonly core = new ModelProviderCoreLoader(this, {
    onStart: (reason) => {
      if (reason !== "publication") {
        this.catalogDiscovery.reset();
      }
      this.coreCatalogGeneration = this.catalogDiscovery.generation;
    },
    onComplete: ({ client, data }) => {
      const preserveCatalogDiagnostics =
        this.data !== null && this.catalogDiscovery.generation !== this.coreCatalogGeneration;
      if (!preserveCatalogDiagnostics) {
        this.catalogDiscovery.reset();
      }
      this.data =
        preserveCatalogDiagnostics && this.data
          ? {
              ...data,
              providerOutcomes: this.data.providerOutcomes,
              catalogError: this.data.catalogError,
            }
          : data;
      this.dataClient = client;
    },
    isCatalogLoading: () => this.catalogDiscovery.discovering,
    refreshPublication: () => void this.refresh("publication"),
  });
  readonly catalogDiscovery = createCatalogDiscoveryController({
    getGateway: () => this.gateway,
    getAgentId: () => this.selectedAgentId,
    getAgentEpoch: () => this.agentEpoch,
    getData: () => this.data,
    setData: (data) => (this.data = data),
    requestUpdate: () => this.requestUpdate(),
    onSettled: () => this.core.flushPublication(),
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetConnectionState(),
    invalidateRequests: () => this.invalidateRequests(),
    ensureInitialData: () => this.ensureInitialData(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        // Keep the last snapshot visible while the canonical reconnect load replaces it.
        this.resetConnectionState({ preserveVisibleData: true });
      }
      if (
        change.becameConnected &&
        !change.initial &&
        this.routeDataObserved &&
        !this.loaderPending
      ) {
        void this.refresh("replacement");
      }
    },
  });
  readonly installedAgents = new InstalledAgentsController(this, {
    gateway: this.gateway,
    getContext: () => this.context,
  });
  readonly probes = new ModelProbeController({
    getAgentEpoch: () => this.agentEpoch,
    getAgentId: () => this.selectedAgentId,
    getClient: () => this.context.gateway.snapshot.client,
    getClientEpoch: () => this.gateway.epoch,
    clearMessage: (cardId) => this.setMessage(cardId, null),
    canMutate: () => this.canMutate(),
    isCurrentClient: (client, epoch) => this.gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(this.busy[key]),
    setBusy: (key, value) => this.setBusy(key, value),
    setProbeResult: (cardId, result) =>
      (this.probeResults = updateRecordEntry(this.probeResults, cardId, result)),
    setProbeError: (cardId, error) => this.setMessage(cardId, { kind: "error", text: error }),
  });
  readonly discovery = new ModelProviderDiscoveryController(this, {
    canOpen: () => this.canMutate(),
    getOwner: () => ({
      client: this.gateway.client,
      epoch: this.gateway.epoch,
      agentEpoch: this.agentEpoch,
      agentId: this.context.settingsAgentSelection.state.selectedId,
      selectionIntentRevision: this.context.settingsAgentSelection.intentRevision,
      selectionPending:
        this.context.settingsAgentSelection.state.selectedId === null &&
        this.context.agents.state.agentsList === null,
    }),
    isCurrent: (owner) =>
      Boolean(
        this.isConnected &&
        owner.client &&
        this.gateway.isCurrent({ client: owner.client, epoch: owner.epoch }) &&
        this.agentEpoch === owner.agentEpoch,
      ),
    onClose: () => void this.refresh("replacement"),
    onError: (error) =>
      this.setMessage("connection", { kind: "error", text: modelProviderErrorMessage(error) }),
  });
  readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({
      context: this.context,
      agentId: this.selectedAgentId,
      authStatus: this.data?.authStatus ?? null,
    }),
    canStart: () => this.canMutate(),
    onDiscover: () => {
      this.setMessage("connection", null);
      void this.discovery.open();
    },
    onApiKey: (provider) => {
      this.addProviderId = provider;
      this.addProviderKey = "";
      this.addProviderOpen = true;
      this.setMessage("add", null);
    },
    onCustom: () => {
      this.managerIntent = { provider: "", view: "create" };
    },
    canContinue: () => this.mutationBlockedReason() === null,
    refresh: () => this.refresh("replacement"),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        modelCatalog.subscribeModelCatalogChanges(gateway, () => void this.refresh("publication")),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => this.installedAgents.subscribe(gateway),
    )
    .watch(() => this.context?.gateway.snapshot.client, modelCatalog.subscribeModelCatalogCache)
    .watchStore(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
      },
    )
    .watchStore(
      () => this.context?.agents,
      () => this.syncSelectedAgent(),
    )
    .effect(
      () => this.context?.settingsAgentSelection,
      (selection) => selection.subscribe(() => this.syncSelectedAgent()),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<ModelProvidersPage>) {
    const data = this.routeData;
    const previous = changed.get("routeData");
    if ((changed.has("routeData") || changed.has("loaderPending")) && data) {
      if (data.connect && !previous?.connect) {
        this.pendingConnection = true;
      }
      // Revalidation must not replace a search the operator edited after navigation.
      if (changed.has("routeData") && data.provider !== previous?.provider) {
        this.providerQuery = canonicalModelAuthProviderId(data.provider ?? "");
      }
      this.cancelCoreRefresh();
      this.routeDataObserved = true;
      this.setSelectedAgent(this.resolveSelectedAgentId());
      if (
        (data.agentId ?? "") === this.selectedAgentId &&
        data.selectionIntentRevision === this.context.settingsAgentSelection.intentRevision &&
        this.gateway.isRouteDataCurrent(data)
      ) {
        this.data = data.data;
        this.dataClient = data.client;
      } else {
        this.data = null;
        this.dataClient = null;
      }
      if (changed.has("routeData")) {
        const route = data.catalogConfig;
        const location = route ? `${route.search}\u0000${route.hash}` : null;
        if (location !== this.managerRouteLocation) {
          this.managerRouteLocation = location;
          this.pendingManagerRoute = route ?? null;
        }
      }
      this.ensureInitialData();
    }
  }

  override updated() {
    if (!this.isConnected) {
      return;
    }
    const route = this.pendingManagerRoute;
    const config = currentConfigObject(this.context.runtimeConfig.state);
    if (route && config && !this.loaderPending) {
      this.pendingManagerRoute = null;
      const intent = providerRouteIntent(route, readModelProviderConfig(config).providerIds);
      if (
        intent?.provider &&
        this.routeData?.agentId === this.selectedAgentId &&
        this.routeData.selectionIntentRevision ===
          this.context.settingsAgentSelection.intentRevision
      ) {
        this.managerIntent = { provider: intent.provider, view: intent.view };
        this.providerQuery = intent.provider;
      }
    }
    if (this.pendingConnection && this.data && this.canMutate() && !this.core.loading) {
      this.pendingConnection = false;
      void this.login.open();
    }
  }

  private ensureInitialData() {
    if (
      !this.context.agents.state.agentsList &&
      !this.context.agents.state.agentsLoading &&
      !this.context.agents.state.agentsError
    ) {
      void this.context.agents.ensureList();
    }
    // The route owns initial loading, even when its page module is already cached.
    const client = this.gateway.client;
    if (
      !this.routeDataObserved ||
      this.loaderPending ||
      !this.gateway.connected ||
      !client ||
      !this.selectedAgentId ||
      this.core.loading ||
      (this.data !== null && this.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh("replacement");
  }

  private cancelCoreRefresh() {
    this.catalogDiscovery.reset();
    this.core.invalidate();
  }

  private invalidateRequests() {
    this.providerDeleteConfirmation?.abort();
    this.cancelCoreRefresh();
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      this.data = null;
      this.dataClient = null;
    }
    this.discovery.cancelLoading();
    this.installedAgents.reset(options);
    this.resetAgentScopeState();
    this.probes.resetProbes();
    this.defaultsDraft = null;
  }

  private resetAgentScopeState() {
    this.providerSelectionRevision += 1;
    this.initialManagerIntent = null;
    this.managerIntent = null;
    this.login.reset();
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.providerDeleteConfirmation?.abort();
    this.addProviderOpen = false;
    this.addProviderId = "";
    this.addProviderKey = "";
  }

  private resolveSelectedAgentId(): string {
    const selected = this.context.settingsAgentSelection.state.selectedId;
    return selected ? normalizeAgentId(selected) : "";
  }

  private setSelectedAgent(agentId: string): boolean {
    if (agentId === this.selectedAgentId) {
      return false;
    }
    this.selectedAgentId = agentId;
    this.agentEpoch += 1;
    this.resetAgentScopeState();
    return true;
  }

  private syncSelectedAgent() {
    if (!this.setSelectedAgent(this.resolveSelectedAgentId())) {
      return;
    }
    this.invalidateRequests();
    this.data = null;
    this.dataClient = null;
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  refresh(reason: ModelProviderRefreshReason): Promise<void> {
    if (!this.selectedAgentId) {
      return Promise.resolve();
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      return Promise.resolve();
    }
    return this.core.refresh(client, this.selectedAgentId, reason);
  }

  private setBusy = (key: string, value: boolean) =>
    (this.busy = updateRecordEntry(this.busy, key, value ? true : null));

  setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    (this.messages = updateRecordEntry(this.messages, key, message));

  private async patchConfig(params: ModelProviderConfigMutation): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    // Global defaults remain editable when the configured roster is empty.
    if (
      !client ||
      modelProviderConfigMutationBlockedReason(this.context) ||
      modelProviderConfigBusy(this.context) ||
      this.busy[params.key]
    ) {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    return runModelProviderConfigMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        isCurrentClient: () => this.gateway.isCurrent({ client, epoch: clientEpoch }),
        isCurrentAgent: () => this.agentEpoch === agentEpoch,
        setBusy: (busy) => this.setBusy(params.key, busy),
        setMessage: (message) => this.setMessage(params.key, message),
      },
      params,
    );
  }

  async mutateApiKey(
    provider: string,
    configKey: string,
    apiKey: string | null,
    action: "edit" | "add" = "edit",
  ) {
    const client = this.gateway.client;
    const key = action === "add" ? "add" : `key:${provider}`;
    if (!client || !this.canMutate() || this.busy[key] || apiKey === "") {
      return undefined;
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    const isCurrent = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) && this.agentEpoch === agentEpoch;
    this.probes.clearProviderProbes(provider);
    const result = await runModelProviderApiKeyMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: isCurrent,
        canMutate: () => this.canMutate(),
        refreshProviders: async () => {
          const previous = this.data;
          await this.refresh("replacement");
          if (isCurrent() && this.data?.error) {
            const warning = this.data.error;
            this.data = previous;
            return warning;
          }
          return this.data?.error ?? this.data?.catalogError ?? null;
        },
        setBusy: (busy) => this.setBusy(key, busy),
        setMessage: (message) => {
          this.setMessage(provider, message);
          if (action === "add") {
            this.setMessage("add", message);
          }
        },
      },
      {
        client,
        agentId: this.selectedAgentId,
        provider: configKey,
        apiKey,
        success: modelProviderApiKeySuccess(action, apiKey, provider),
      },
    );
    if (!result.ok || !isCurrent()) {
      return undefined;
    }
    if (action === "add") {
      if (this.addProviderId === provider && this.addProviderKey.trim() === apiKey) {
        this.addProviderOpen = Boolean(result.warning);
        if (!result.warning) {
          this.addProviderId = "";
        }
        this.addProviderKey = "";
      }
    }
    return result;
  }

  async addProvider() {
    const provider = this.addProviderId;
    if (provider) {
      await this.mutateApiKey(provider, provider, this.addProviderKey.trim(), "add");
    }
  }

  async deleteProvider(card: ModelProviderCard) {
    const client = this.gateway.client;
    const busyKey = `delete:${card.id}`;
    const configKey = card.configKey ?? card.id;
    if (!client || this.providerDeleteConfirmation || !this.canMutate() || this.busy[busyKey]) {
      return;
    }
    const references = providerReferenceSites(
      currentConfigObject(this.context.runtimeConfig.state),
      configKey,
    ).map((site) => site.path);
    // Agent changes, reconnects and navigation abort this decision
    // before it can authorize a deletion under a different scope.
    const controller = new AbortController();
    this.providerDeleteConfirmation = controller;
    let confirmed = false;
    try {
      confirmed = await showConfirmDialog({
        title: t("modelProviders.delete.action"),
        message: [
          t("modelProviders.delete.confirm", { provider: card.displayName }),
          ...(references.length
            ? [
                t("modelProviders.delete.confirmRefs", {
                  provider: card.displayName,
                  references: references.join(", "),
                }),
              ]
            : []),
        ].join(" "),
        confirmLabel: t("modelProviders.delete.action"),
        danger: true,
        signal: controller.signal,
      });
    } finally {
      this.providerDeleteConfirmation = null;
    }
    if (!confirmed || controller.signal.aborted || !this.canMutate() || this.busy[busyKey]) {
      return;
    }
    // Rebuild from the post-confirmation snapshot: the patch must reflect the
    // config as it stands, not as it was when the dialog opened.
    const configObject = currentConfigObject(this.context.runtimeConfig.state);
    const sites = providerReferenceSites(configObject, configKey);
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    const isCurrent = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) && this.agentEpoch === agentEpoch;
    await runModelProviderDeleteMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: isCurrent,
        canMutate: () => this.canMutate(),
        refreshProviders: async () => {
          const previous = this.data;
          await this.refresh("replacement");
          if (isCurrent() && this.data?.error) {
            const warning = this.data.error;
            this.data = previous;
            return warning;
          }
          return this.data?.error ?? this.data?.catalogError ?? null;
        },
        setBusy: (busy) => this.setBusy(busyKey, busy),
        // The deleted card's row is gone; the page-level slot still reports the outcome.
        setMessage: (message) => this.setMessage("connection", message),
      },
      {
        client,
        agentId: this.selectedAgentId,
        provider: configKey,
        hasCredentials: card.profiles.length > 0 || card.hasConfigApiKey || Boolean(card.apiKey),
        patch: providerDeletePatch(configObject, configKey, sites),
        success: t("modelProviders.delete.success", { provider: card.displayName }),
      },
    );
    if (
      isCurrent() &&
      !readModelProviderConfig(
        currentConfigObject(this.context.runtimeConfig.state),
      ).providerIds.includes(configKey)
    ) {
      if (this.managerIntent?.provider === configKey) {
        this.managerIntent = null;
      }
    }
  }

  async saveDefaults(defaults = this.defaultsDraft) {
    if (!defaults) {
      return;
    }
    await this.patchConfig({
      key: "defaults",
      raw: buildDefaultsPatch(defaults),
      note: t("modelProviders.notes.defaultModel"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    });
    // Global defaults outlive agent selection. Connection resets clear the draft;
    // object identity protects newer edits.
    if (this.defaultsDraft === defaults) {
      this.defaultsDraft = null;
    }
  }

  override render() {
    return renderModelProvidersPageContent(this);
  }
}

if (!customElements.get("openclaw-model-providers-page")) {
  customElements.define("openclaw-model-providers-page", ModelProvidersPage);
}
