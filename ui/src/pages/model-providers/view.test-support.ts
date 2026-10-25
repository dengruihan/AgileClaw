import { nothing, render } from "lit";
import { onTestFinished } from "vitest";
import type { ModelProviderCard } from "./data.ts";
import { renderModelProviders } from "./view.ts";

type ModelProvidersViewProps = Parameters<typeof renderModelProviders>[0];

export function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    credentialProviderIds: ["openai"],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

export function props(overrides: Partial<ModelProvidersViewProps> = {}): ModelProvidersViewProps {
  const cards = overrides.cards ?? [card()];
  return {
    connected: true,
    loading: false,
    refreshing: false,
    error: null,
    updatedAt: 1,
    credentialAgentLabel: "Writer",
    cards,
    selectedProvider: cards[0]?.configKey ?? cards[0]?.id,
    configuredModels: [{ id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true }],
    decisionModels: [],
    defaultModels: { primary: "openai/gpt-5", fallbacks: [], utilityModel: null },
    thinkingLevel: "off",
    thinkingOverridden: true,
    fastMode: false,
    fastModeOverridden: true,
    catalogDiscovering: false,
    catalogDiscoveryError: null,
    configBusy: false,
    unconfiguredProviders: [{ id: "anthropic", displayName: "Anthropic" }],
    canMutate: true,
    mutationBlockedReason: null,
    defaultsMutationBlockedReason: null,
    busy: {},
    messages: {},
    addProviderOpen: false,
    addProviderId: "",
    addProviderKey: "",
    installedAgents: nothing,
    onRefresh: () => undefined,
    onAddProviderToggle: () => undefined,
    onAddProviderKeyChange: () => undefined,
    onAddProvider: () => undefined,
    onPrimaryChange: () => undefined,
    onFallbackChange: () => undefined,
    onUtilityChange: () => undefined,
    onDecisionChange: () => undefined,
    onThinkingChange: () => undefined,
    onThinkingReset: () => undefined,
    onFastModeChange: () => undefined,
    onFastModeReset: () => undefined,
    onCatalogRetry: () => undefined,
    onConnect: () => undefined,
    canConnect: () => false,
    loginBusy: false,
    ...overrides,
  };
}

export function mount(
  viewProps: ModelProvidersViewProps,
  container = document.body.appendChild(document.createElement("div")),
): HTMLDivElement {
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  render(renderModelProviders(viewProps), container);
  return container;
}

export function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}
