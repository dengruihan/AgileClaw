import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import {
  modelDefaultsActions,
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  readModelBehaviorConfig,
} from "./config-mutation.ts";
import {
  buildModelProviderCards,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  resolveDefaultModelPresentation,
  type DefaultsDraft,
} from "./data.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import { loginOptionChoiceId } from "./login-providers.ts";
import type { ModelProvidersPage } from "./model-providers-page.ts";
import { configuredProvider, localOrCustomProvider } from "./provider-model-config.ts";
import {
  renderModelProviderScope,
  renderModelProviders,
  renderModelProvidersPageShell,
} from "./view.ts";

/**
 * Page-body assembly for the models/providers settings page: derives the
 * card, defaults, and capability projections from page state and wires every
 * view callback back into the page. Hosted beside the page class so the page
 * file stays within the line budget without splitting its controller seams.
 */
export function renderModelProvidersPageContent(page: ModelProvidersPage): TemplateResult {
  const gatewaySnapshot = page.context.gateway.snapshot;
  const agentsState = page.context.agents.state;
  const agents = agentsState.agentsList?.agents ?? [];
  const noSelectableAgents =
    agentsState.agentsList !== null && listSelectableAgents(agents).length === 0;
  const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
  const selected = agents.find((agent) => normalizeAgentId(agent.id) === page.selectedAgentId);
  const data = page.data ?? EMPTY_MODEL_PROVIDERS_DATA;
  const configObject = currentConfigObject(page.context.runtimeConfig.state);
  const config = readModelProviderConfig(configObject);
  const catalog = modelCatalog.readAgentModelCatalog(gatewaySnapshot.client, page.selectedAgentId);
  const configuredDefaults = {
    ...config.defaults,
    ...readModelBehaviorConfig(asConfigRecord(asConfigRecord(configObject?.agents)?.defaults)),
  };
  const { defaults, configuredModels } = resolveDefaultModelPresentation(
    catalog,
    configuredDefaults,
    page.defaultsDraft,
  );
  const stageDefaults = (patch: Partial<DefaultsDraft>) => {
    page.defaultsDraft = { ...(page.defaultsDraft ?? configuredDefaults), ...patch };
    page.setMessage("defaults", null);
    void page.saveDefaults(page.defaultsDraft);
  };
  const cards = buildModelProviderCards({
    ...data,
    models: catalog?.models ?? null,
    providerOutcomes: catalog.hasSnapshot
      ? (catalog.providerOutcomes ?? [])
      : data.providerOutcomes,
    pendingProviders: catalog?.pendingProviders,
    configProviderIds: config.providerIds,
    configApiKeyProviderIds: config.apiKeyProviderIds,
    configProviderAuthModes: config.providerAuthModes,
  });
  const configuredProviderIds = new Set([
    ...config.providerIds,
    ...(data.authStatus?.providers
      .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
      .map((provider) => provider.provider) ?? []),
  ]);
  const knownProviderIds = new Set(
    data.authStatus?.providerCapabilities?.map((entry) => entry.provider) ?? [],
  );
  const isLocalOrCustom = (id: string) =>
    localOrCustomProvider(configObject, id, knownProviderIds, catalog?.models ?? []);
  const login = page.login.pageActions;
  const visibleCards = noSelectableAgents ? [] : page.installedAgents.filterProviders(cards);
  const managerIntent = page.providerIntent(visibleCards);
  const providerEditor = html`<openclaw-provider-manager
    .context=${page.context}
    .agentId=${page.selectedAgentId}
    .intent=${managerIntent}
    .customProvider=${isLocalOrCustom(managerIntent?.provider ?? "")}
    .card=${cards.find((card) => (card.configKey ?? card.id) === managerIntent?.provider) ?? null}
    .probeResults=${page.probeResults}
    .probeBusy=${page.busy}
    .probeErrors=${page.messages}
    .onCreated=${(provider: string) => {
      page.managerIntent = { provider, view: "settings" };
    }}
    .onRefresh=${() => {
      if (managerIntent) {
        page.probes.clearProviderProbes(managerIntent.provider);
      }
      void page.refresh("replacement");
    }}
    .onProbe=${(modelId: string) => {
      if (managerIntent) {
        void page.probes.probe(
          `${managerIntent.provider}/${modelId}`,
          [managerIntent.provider],
          modelId,
        );
      }
    }}
    .onConnect=${() => {
      const card = cards.find((entry) => (entry.configKey ?? entry.id) === managerIntent?.provider);
      if (card) {
        void page.login.providerActions.onConnect(card);
      } else {
        void page.login.open();
      }
    }}
    .onCredential=${(provider: string, key: string | null) => page.mutateApiKey(provider, provider, key)}
  ></openclaw-provider-manager>`;
  const body = renderModelProviders({
    providerEditor,
    selectedProvider: managerIntent?.provider,
    creatingProvider: managerIntent?.view === "create",
    accountRecovery: page.login.renderRecovery(),
    catalogSettings: html`<openclaw-model-catalog-settings
      .routeData=${page.routeData?.catalogConfig ?? null}
      .runtimeConfig=${page.context.runtimeConfig}
    ></openclaw-model-catalog-settings>`,
    providerScope: renderModelProviderScope({
      agentLabel: selected ? normalizeAgentLabel(selected) : page.selectedAgentId,
      ...login,
      connectDisabled: login.connectDisabled || page.discovery.busy || page.addProviderOpen,
    }),
    isLocalOrCustom: (card) => isLocalOrCustom(card.configKey ?? card.id),
    onProviderSettings: (card) => {
      void page.selectProvider({ provider: card.configKey ?? card.id, view: "settings" });
    },
    onCustomProvider: () => {
      void page.selectProvider({ provider: "", view: "create" });
    },
    onAvailableProvider: (provider) => {
      void page.selectProvider({ provider, view: "settings" });
    },
    providerQuery: page.providerQuery,
    onProviderQueryChange: (value) => (page.providerQuery = value),
    onConnectProvider: () => void page.login.open(),
    connected: gatewaySnapshot.phase === "connected",
    loading:
      gatewaySnapshot.phase === "connected" &&
      page.data === null &&
      !rosterError &&
      !noSelectableAgents,
    refreshing: page.core.loading,
    error: rosterError ?? (noSelectableAgents ? t("agents.noAgents") : data.error),
    updatedAt: data.updatedAt,
    credentialAgentLabel: selected ? normalizeAgentLabel(selected) : page.selectedAgentId,
    cards: visibleCards,
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
      page.catalogDiscovery.discovering || Boolean(catalog?.pendingProviders?.length),
    catalogDiscoveryError: page.catalogDiscovery.discovering
      ? null
      : (page.catalogDiscovery.error ?? data.catalogError),
    configBusy: modelProviderConfigBusy(page.context),
    unconfiguredProviders: buildUnconfiguredProviderOptions(
      data.authStatus?.providerCapabilities,
      configuredProviderIds,
    ),
    mutationBlockedReason: page.mutationBlockedReason(),
    defaultsMutationBlockedReason: modelProviderConfigMutationBlockedReason(page.context),
    busy: page.busy,
    messages: page.messages,
    addProviderOpen: page.addProviderOpen,
    addProviderId: page.addProviderId,
    addProviderKey: page.addProviderKey,
    installedAgents: page.installedAgents.render(cards, () => page.catalogDiscovery.retry()),
    onRefresh: () =>
      void (rosterError
        ? page.context.agents.refreshList()
        : Promise.all([
            page.context.runtimeConfig.refresh({ background: true }),
            page.refresh("forced"),
          ])),
    onDeleteProvider: (card) => void page.deleteProvider(card),
    // Any authored provider entry can go, cloud or custom; catalog-known
    // providers without an entry only carry credentials (logout covers those).
    canDeleteProvider: (card) =>
      configuredProvider(configObject, card.configKey ?? card.id) !== null,
    onAddProviderToggle: () => {
      page.addProviderOpen = !page.addProviderOpen;
      page.addProviderKey = "";
      page.setMessage("add", null);
    },
    onAddProviderKeyChange: (value) => (page.addProviderKey = value),
    onAddProvider: () => void page.addProvider(),
    ...modelDefaultsActions(() => page.defaultsDraft ?? configuredDefaults, stageDefaults),
    onCatalogRetry: () => page.catalogDiscovery.retry(),
    ...page.login.providerActions,
  });
  return renderModelProvidersPageShell({
    body,
    loginMessage: page.messages.connection ?? login.loginMessage,
    login: html`${login.login}${page.discovery.render({
      agentLabel: selected ? normalizeAgentLabel(selected) : page.selectedAgentId,
      credentialChoices:
        data.authStatus?.providerCapabilities?.flatMap(
          (provider) => provider.loginOptions?.map(loginOptionChoiceId) ?? [],
        ) ?? [],
    })}`,
  });
}
