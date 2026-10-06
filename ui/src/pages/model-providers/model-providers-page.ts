import { consume } from "@lit/context";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { ConfigRouteData } from "../config/route-data.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import { createCatalogDiscoveryController } from "./catalog-discovery.ts";
import {
  buildDefaultsPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  modelProviderApiKeySuccess,
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelDefaultsActions,
  readModelBehaviorConfig,
  runModelProviderApiKeyMutation,
  runModelProviderConfigMutation,
  type ModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import { ModelProviderCoreLoader, type ModelProviderRefreshReason } from "./core-load.ts";
import {
  buildModelProviderCards,
  resolveDefaultModelPresentation,
  readModelProviderConfig,
  type DefaultsDraft,
  type ModelProviderPendingLogout,
} from "./data.ts";
import "./provider-manager.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  MODEL_PROVIDERS_COST_DAYS,
  type ModelProvidersData,
} from "./load.ts";
import { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
import { showProfileActionError, showProfileLogoutSuccess } from "./profiles-view.ts";
import type { ProviderManagerIntent } from "./provider-manager.ts";
import { configuredProvider, providerEndpoint } from "./provider-model-config.ts";
import { providerRouteIntent } from "./provider-route-intent.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";
import {
  renderModelProviderScope,
  renderModelProviders,
  renderModelProvidersPageShell,
} from "./view.ts";

export class ModelProvidersPage extends OpenClawLightDomElement {
  private readonly mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(this.context) ??
    (this.selectedAgentId ? null : t("agents.noAgents"));
  private readonly canMutate = (): boolean =>
    this.mutationBlockedReason() === null && !modelProviderConfigBusy(this.context);

  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;
  @property({ attribute: false }) loaderPending = false;

  @state() private data: ModelProvidersData | null = null;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, ModelProviderRowMessage> = {};
  @state() private probeResults: Record<string, ModelsProbeResult> = {};
  private logoutConfirmation: AbortController | null = null;
  @state() private profileOrders: Record<string, string[]> = {};
  @state() private providerQuery = "";
  private pendingConnection = false;
  @state() private managerIntent: ProviderManagerIntent | null = null;
  @state() private defaultsDraft: DefaultsDraft | null = null;
  @state() private selectedAgentId = "";
  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private routeDataObserved = false;
  private managerRouteLocation: string | null = null;
  private pendingManagerRoute: ConfigRouteData | null = null;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private coreCatalogGeneration = 0;
  private readonly core = new ModelProviderCoreLoader(this, {
    onStart: (reason) => {
      if (reason !== "publication") {
        this.catalogDiscovery.reset();
      }
      this.coreCatalogGeneration = this.catalogDiscovery.generation;
      this.supplemental.beginCoreRefresh(reason === "forced");
    },
    onComplete: ({ client, data }) => {
      const preserveCatalogDiagnostics =
        this.data !== null && this.catalogDiscovery.generation !== this.coreCatalogGeneration;
      if (!preserveCatalogDiagnostics) {
        this.catalogDiscovery.reset();
      }
      this.supplemental.adoptCoreData(client, data, { preserveCatalogDiagnostics });
    },
    isCatalogLoading: () => this.catalogDiscovery.discovering,
    refreshPublication: () => void this.refresh("publication"),
  });
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () =>
      this.loaderPending ||
      !this.routeDataObserved ||
      this.core.loading ||
      this.supplemental.usageLoading,
    // Usage convergence must not restart the independent local-cost request.
    reload: () => this.supplemental.loadUsage(),
    onIncompleteUsageExhausted: () => this.requestUpdate(),
  });
  private readonly supplemental = new ModelProviderSupplementalLoader(this, {
    isCoreLoading: () => this.loaderPending,
    getGateway: () => this.gateway,
    getData: () => this.data,
    getDataClient: () => this.dataClient,
    setData: (data) => (this.data = data),
    setDataClient: (client) => (this.dataClient = client),
    refreshPolicy: this.refreshPolicy,
  });
  private readonly catalogDiscovery = createCatalogDiscoveryController({
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
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly profileActions = new ModelProviderProfileActionsController({
    getAgentEpoch: () => this.agentEpoch,
    getAgentId: () => this.selectedAgentId,
    getClient: () => this.context.gateway.snapshot.client,
    getClientEpoch: () => this.gateway.epoch,
    getData: () => this.data,
    getOrders: () => this.profileOrders,
    setData: (data) => (this.data = data),
    setError: showProfileActionError,
    setOrders: (orders) => (this.profileOrders = orders),
    clearMessage: (cardId) => this.setMessage(cardId, null),
    canMutate: () => this.canMutate(),
    cancelRefresh: () => this.cancelCoreRefresh(),
    refresh: () => this.refresh("forced"),
    isCurrentClient: (client, epoch) => this.gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(this.busy[key]),
    setBusy: (key, value) => this.setBusy(key, value),
    setProbeResult: (cardId, result) =>
      (this.probeResults = updateRecordEntry(this.probeResults, cardId, result)),
    setProbeError: (cardId, error) => this.setMessage(cardId, { kind: "error", text: error }),
    setLogoutSuccess: showProfileLogoutSuccess,
    getConfig: () => this.context.runtimeConfig,
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        modelCatalog.subscribeModelCatalogChanges(gateway, () => void this.refresh("publication")),
    )
    .watch(() => this.context?.gateway.snapshot.client, modelCatalog.subscribeModelCatalogCache)
    .watchStore(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
        this.profileActions.flushPendingOrders();
      },
    )
    .watchStore(
      () => this.context?.overlays,
      () => this.profileActions.flushPendingOrders(),
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
    // Pending orders belong to this page; a delayed save must not dispatch
    // them after navigation over a replacement page's newer order.
    this.profileActions.resetOrders();
    this.subscriptions.clear();
    this.refreshPolicy.dispose();
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
        this.supplemental.adoptCoreData(data.client, data.data);
      } else {
        this.data = null;
        this.dataClient = null;
        this.refreshPolicy.resetPayload();
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
      this.managerIntent = { provider: "", view: "create" };
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
    this.logoutConfirmation?.abort();
    this.cancelCoreRefresh();
    this.supplemental.invalidate();
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      this.data = null;
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.resetAgentScopeState();
    this.profileActions.resetProbes();
    this.defaultsDraft = null;
  }

  private resetAgentScopeState() {
    this.managerIntent = null;
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.logoutConfirmation?.abort();
    this.profileActions.resetOrders();
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
    this.refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  private refresh(reason: ModelProviderRefreshReason): Promise<void> {
    if (!this.selectedAgentId) {
      return Promise.resolve();
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    return this.core.refresh(client, this.selectedAgentId, reason);
  }

  private setBusy = (key: string, value: boolean) =>
    (this.busy = updateRecordEntry(this.busy, key, value ? true : null));

  private setMessage = (key: string, message: ModelProviderRowMessage | null) =>
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

  private async mutateApiKey(provider: string, configKey: string, apiKey: string | null) {
    const client = this.gateway.client;
    const key = `key:${provider}`;
    if (!client || !this.canMutate() || this.busy[key] || apiKey === "") {
      return undefined;
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    const isCurrent = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) && this.agentEpoch === agentEpoch;
    this.profileActions.clearProbe(provider);
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
        },
      },
      {
        client,
        agentId: this.selectedAgentId,
        provider: configKey,
        apiKey,
        success: modelProviderApiKeySuccess("edit", apiKey, provider),
      },
    );
    if (!result.ok || !isCurrent()) {
      return result.ok ? { ok: false as const } : result;
    }
    return result;
  }

  private async requestLogout(pending: ModelProviderPendingLogout) {
    if (this.logoutConfirmation || !this.canMutate() || this.busy[`logout:${pending.cardId}`]) {
      return;
    }
    // Agent changes, reconnects and navigation abort this decision before it can
    // authorize a logout under a different scope.
    const controller = new AbortController();
    this.logoutConfirmation = controller;
    const confirmed = await showConfirmDialog({
      title: t("modelProviders.logout.actionFor", { account: pending.label }),
      message: t("modelProviders.logout.confirm", { provider: pending.label }),
      confirmLabel: t("modelProviders.logout.action"),
      danger: true,
      signal: controller.signal,
    }).finally(() => {
      this.logoutConfirmation = null;
    });
    if (confirmed && !controller.signal.aborted && this.canMutate()) {
      await this.profileActions.logout(pending.cardId, pending.target);
    }
  }

  private async saveDefaults(defaults = this.defaultsDraft) {
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
    const gatewaySnapshot = this.context.gateway.snapshot;
    const operatorAuth = gatewaySnapshot.hello?.auth;
    const agentsState = this.context.agents.state;
    const agents = agentsState.agentsList?.agents ?? [];
    const noSelectableAgents =
      agentsState.agentsList !== null && listSelectableAgents(agents).length === 0;
    const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
    const selected = agents.find((agent) => normalizeAgentId(agent.id) === this.selectedAgentId);
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const configObject = currentConfigObject(this.context.runtimeConfig.state);
    const config = readModelProviderConfig(configObject);
    const catalog = modelCatalog.readAgentModelCatalog(
      gatewaySnapshot.client,
      this.selectedAgentId,
    );
    const configuredDefaults = {
      ...config.defaults,
      ...readModelBehaviorConfig(asConfigRecord(asConfigRecord(configObject?.agents)?.defaults)),
    };
    const { defaults, configuredModels } = resolveDefaultModelPresentation(
      catalog,
      configuredDefaults,
      this.defaultsDraft,
    );
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      this.defaultsDraft = { ...(this.defaultsDraft ?? configuredDefaults), ...patch };
      this.setMessage("defaults", null);
      void this.saveDefaults(this.defaultsDraft);
    };
    const cards = buildModelProviderCards({
      ...data,
      models: catalog?.models ?? null,
      providerOutcomes: catalog.hasSnapshot
        ? (catalog.providerOutcomes ?? [])
        : data.providerOutcomes,
      pendingProviders: catalog?.pendingProviders,
      providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
      configProviderIds: config.providerIds,
      configApiKeyProviderIds: config.apiKeyProviderIds,
      configProviderAuthModes: config.providerAuthModes,
    })
      .filter((card) => config.providerIds.includes(card.configKey ?? card.id))
      .map((card) => {
        const provider = configuredProvider(configObject, card.configKey ?? card.id);
        return Object.assign(card, {
          displayName: typeof provider?.name === "string" ? provider.name : card.displayName,
        });
      });
    const openProvider = (provider = "") => {
      this.managerIntent = { provider, view: provider ? "settings" : "create" };
    };
    const body = renderModelProviders({
      canMutate: this.canMutate(),
      providerScope: renderModelProviderScope({
        agentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
        onConnect: () => openProvider(),
        connectDisabled: !this.canMutate(),
      }),
      providerEndpoint: (card) => {
        const endpoint = providerEndpoint(configObject, card.configKey ?? card.id);
        return endpoint ? redactSensitiveUrlLikeString(endpoint) : undefined;
      },
      onProviderSettings: (card) => openProvider(card.configKey ?? card.id),
      providerQuery: this.providerQuery,
      onProviderQueryChange: (value) => (this.providerQuery = value),
      onConnectProvider: () => openProvider(),
      connected: gatewaySnapshot.phase === "connected",
      loading:
        gatewaySnapshot.phase === "connected" &&
        this.data === null &&
        !rosterError &&
        !noSelectableAgents,
      refreshing: this.core.loading,
      error: rosterError ?? (noSelectableAgents ? t("agents.noAgents") : data.error),
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: this.loaderPending || this.supplemental.loading,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      credentialAgentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
      cards: noSelectableAgents ? [] : cards,
      configuredModels,
      decisionModels: catalog?.decisionModels ?? [],
      defaultModels: defaults,
      authStatus: data.authStatus,
      automaticUtilityModel: catalog?.defaultModels?.automaticUtilityModel,
      utilityRuntime: catalog?.defaultModels?.utilityRuntime,
      thinkingLevel: defaults.thinkingLevel,
      thinkingOverridden: defaults.thinkingOverridden,
      fastMode: defaults.fastMode,
      fastModeOverridden: defaults.fastModeOverridden,
      catalogDiscovering:
        this.catalogDiscovery.discovering || Boolean(catalog?.pendingProviders?.length),
      catalogDiscoveryError: this.catalogDiscovery.discovering
        ? null
        : (this.catalogDiscovery.error ?? data.catalogError),
      configBusy: modelProviderConfigBusy(this.context),
      canViewProfiles:
        gatewaySnapshot.phase === "connected" &&
        operatorAuth?.scopes !== undefined &&
        hasOperatorAdminAccess(operatorAuth),
      mutationBlockedReason: this.mutationBlockedReason(),
      defaultsMutationBlockedReason: modelProviderConfigMutationBlockedReason(this.context),
      providerUsageStalled: this.refreshPolicy.incompleteUsageExhausted,
      probeAvailable: isGatewayMethodAdvertised(gatewaySnapshot, "models.probe") !== false,
      busy: this.busy,
      messages: this.messages,
      probeResults: this.probeResults,
      profileOrders: this.profileOrders,
      onRefresh: () =>
        void (rosterError
          ? this.context.agents.refreshList()
          : Promise.all([
              this.context.runtimeConfig.refresh({ background: true }),
              this.refresh("forced"),
            ])),
      onProbe: (cardId, providers) => void this.profileActions.probe(cardId, providers),
      onRequestLogout: (pending) => void this.requestLogout(pending),
      onProfileOrderChange: (cardId, provider, profileIds) =>
        this.profileActions.setOrder(cardId, provider, profileIds),
      ...modelDefaultsActions(() => this.defaultsDraft ?? configuredDefaults, stageDefaults),
      onCatalogRetry: () => this.catalogDiscovery.retry(),
    });
    return renderModelProvidersPageShell({
      body,
      loginMessage: this.messages.connection,
      login: html`<openclaw-provider-manager
        .context=${this.context}
        .agentId=${this.selectedAgentId}
        .intent=${this.managerIntent}
        .card=${cards.find((card) => (card.configKey ?? card.id) === this.managerIntent?.provider) ?? null}
        .onClose=${() => {
          this.managerIntent = null;
        }}
        .onRefresh=${() => {
          void this.refresh("replacement");
        }}
        .onCredential=${(provider: string, key: string | null) => this.mutateApiKey(provider, provider, key)}
      ></openclaw-provider-manager>`,
    });
  }
}

if (!customElements.get("openclaw-model-providers-page")) {
  customElements.define("openclaw-model-providers-page", ModelProvidersPage);
}
