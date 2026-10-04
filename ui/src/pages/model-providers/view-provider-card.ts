import { html, nothing, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount, formatCost } from "../../lib/format.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type {
  DefaultModelSelection,
  ModelPickerEntry,
  ModelProviderCard,
  ProviderOption,
} from "./data.ts";
import type { DefaultModelsViewProps } from "./default-models-view.ts";
import {
  apiKeySource,
  renderProviderProfiles,
  type ProviderProfilesViewProps,
} from "./profiles-view.ts";
import {
  hasVerifiedProvider,
  hasProviderCredentials,
  renderProviderStatus,
  renderMutationMessage,
} from "./view-status.ts";

export type ModelProvidersViewProps = Omit<
  DefaultModelsViewProps,
  "models" | "selection" | "message"
> &
  Omit<ProviderProfilesViewProps, "onAddAccount" | "addAccountDisabled"> & {
    connected: boolean;
    catalogSettings?: TemplateResult;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    providerUsageFailed: boolean;
    supplementalLoading: boolean;
    updatedAt: number | null;
    costDays: number;
    credentialAgentLabel: string;
    cards: ModelProviderCard[];
    configuredModels: ModelPickerEntry[];
    defaultModels: DefaultModelSelection;
    /** True while picker-triggered catalog discovery is in flight. */
    catalogDiscovering: boolean;
    /** Retryable error from picker-triggered catalog discovery. */
    catalogDiscoveryError: string | null;
    configBusy: boolean;
    unconfiguredProviders: ProviderOption[];
    canViewProfiles: boolean;
    defaultsMutationBlockedReason: string | null;
    /** Usage never converged before the retry budget ran out; cards lack usage. */
    providerUsageStalled: boolean;
    probeAvailable: boolean;
    messages: Record<string, ModelProviderRowMessage>;
    probeResults: Record<string, ModelsProbeResult>;
    keyEditorProvider: string | null;
    keyDraft: string;
    addProviderOpen: boolean;
    addProviderId: string;
    addProviderKey: string;
    installedAgents: TemplateResult | typeof nothing;
    onRefresh: () => void;
    onOpenKeyEditor: (provider: string) => void;
    onCloseKeyEditor: () => void;
    onKeyDraftChange: (value: string) => void;
    onSaveKey: (provider: string, configKey: string) => void;
    onRemoveKey: (provider: string, configKey: string) => void;
    onProbe: (cardId: string, providers: string[]) => void;
    onAddProviderToggle: () => void;
    onAddProviderKeyChange: (value: string) => void;
    onAddProvider: () => void;
    providerScope?: TemplateResult;
    accountRecovery?: TemplateResult | typeof nothing;
    providerCategory?: "cloud" | "custom";
    onProviderCategoryChange?: (category: "cloud" | "custom") => void;
    isLocalOrCustom?: (card: ModelProviderCard) => boolean;
    isLocalOrCustomProvider?: (id: string) => boolean;
    providerEndpoint?: (card: ModelProviderCard) => string | undefined;
    onProviderSettings?: (card: ModelProviderCard) => void;
    onProviderModels?: (card: ModelProviderCard) => void;
    onCustomProvider?: () => void;
    onAvailableProvider?: (id: string) => void;
    providerQuery?: string;
    onProviderQueryChange?: (value: string) => void;
    onConnectProvider: () => void;
    onConnect: (card: ModelProviderCard) => void;
    canConnect: (card: ModelProviderCard) => boolean;
    loginBusy: boolean;
  };

export function configMutationDisabled(props: ModelProvidersViewProps): boolean {
  return !props.canMutate || props.configBusy;
}

function modelsText(card: ModelProviderCard): string | null {
  if (card.modelCount === 0) {
    return null;
  }
  return card.availableModelCount < card.modelCount
    ? t("modelProviders.modelsAvailable", {
        available: String(card.availableModelCount),
        count: String(card.modelCount),
      })
    : card.modelCount === 1
      ? t("modelProviders.modelOne")
      : t("modelProviders.models", { count: String(card.modelCount) });
}

function renderLocalCost(card: ModelProviderCard, costDays: number) {
  const cost = card.localCost;
  if (!cost || (cost.totalTokens === 0 && cost.totalCost === 0)) {
    return nothing;
  }
  return html`
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>${t("modelProviders.localCost", { days: String(costDays) })}</span>
        <strong>${formatCost(cost.totalCost)}</strong>
      </div>
      <div class="model-providers__local-cost-detail">
        ${t("modelProviders.localCostDetail", {
          tokens: formatCompactTokenCount(cost.totalTokens),
          messages: String(cost.messageCount),
        })}
      </div>
    </div>
  `;
}

function renderCredentialSummary(card: ModelProviderCard, agentLabel: string) {
  const oauthCount = card.profiles.filter((profile) => profile.type === "oauth").length;
  const tokenCount = card.profiles.filter((profile) => profile.type === "token").length;
  const apiProfileCount = card.profiles.filter((profile) => profile.type === "api_key").length;
  const parts = [];
  if (oauthCount > 0) {
    parts.push(t("modelProviders.credentials.oauth", { count: String(oauthCount) }));
  }
  if (tokenCount > 0) {
    parts.push(t("modelProviders.credentials.tokenProfiles", { count: String(tokenCount) }));
  }
  const source = apiKeySource(card);
  if (source !== undefined) {
    parts.push(source);
  } else if (apiProfileCount > 0) {
    parts.push(t("modelProviders.credentials.profileKey", { count: String(apiProfileCount) }));
  }
  return html`
    <div class="model-providers__credentials">
      <span>${t("modelProviders.credentials.label", { agent: agentLabel })}</span>
      <strong
        >${parts.length > 0 ? parts.join(" · ") : t("modelProviders.credentials.none")}</strong
      >
    </div>
  `;
}

function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return nothing;
  }
  const hasWarnings =
    result.status === "ok" && result.results.some((target) => target.status !== "ok");
  const presentation = hasWarnings ? "warning" : result.status === "ok" ? "success" : "error";
  return html`
    <div class="model-providers__probe model-providers__probe--${presentation}" role="status">
      <div class="model-providers__probe-summary">
        <strong
          >${
            hasWarnings
              ? t("modelProviders.probe.status.partial")
              : t(`modelProviders.probe.status.${result.status}`)
          }</strong
        >
        ${
          result.latencyMs !== undefined
            ? html`<span
                >${t("modelProviders.probe.latency", { ms: String(result.latencyMs) })}</span
              >`
            : nothing
        }
      </div>
      ${result.error ? html`<div>${formatUiExternalText(result.error)}</div>` : nothing}
      ${result.results.map(
        (target) => html`
          <div class="model-providers__probe-target">
            <span>${target.label}</span>
            <span>
              ${t(`modelProviders.probe.status.${target.status}`)}${
                target.latencyMs !== undefined
                  ? ` · ${t("modelProviders.probe.latency", { ms: String(target.latencyMs) })}`
                  : ""
              }
            </span>
            ${target.error ? html`<small>${formatUiExternalText(target.error)}</small>` : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderKeyEditor(card: ModelProviderCard, props: ModelProvidersViewProps) {
  if (props.keyEditorProvider !== card.id) {
    return nothing;
  }
  const busy = Boolean(props.busy[`key:${card.id}`]);
  const authModeBlocked =
    card.apiKeySupported === false ||
    Boolean(card.configAuthMode && card.configAuthMode !== "api-key");
  const mutationDisabled = configMutationDisabled(props);
  return html`
    <div class="model-providers__inline-form">
      <label class="field">
        <span>${t("modelProviders.apiKey.label")}</span>
        <input
          type="password"
          autocomplete="off"
          placeholder=${
            card.apiKey?.source === "config"
              ? t("modelProviders.apiKey.replacePlaceholder")
              : t("modelProviders.apiKey.placeholder")
          }
          .value=${props.keyDraft}
          ?disabled=${busy || mutationDisabled || authModeBlocked}
          @input=${(event: Event) =>
            props.onKeyDraftChange((event.target as HTMLInputElement).value)}
        />
      </label>
      <div class="model-providers__form-actions">
        <button
          class="btn primary btn--sm"
          ?disabled=${busy || mutationDisabled || authModeBlocked || !props.keyDraft.trim()}
          @click=${() => props.onSaveKey(card.id, card.configKey ?? card.id)}
        >
          ${busy ? t("modelProviders.saving") : t("common.save")}
        </button>
        <button class="btn btn--sm" ?disabled=${busy} @click=${() => props.onCloseKeyEditor()}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  `;
}

function renderProviderActions(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const credentialProviders = card.credentialProviderIds.length
    ? card.credentialProviderIds
    : [card.id];
  const probeBusy = Boolean(props.busy[`probe:${card.id}`]);
  const keyBusy = Boolean(props.busy[`key:${card.id}`]);
  const blocked = props.mutationBlockedReason ?? "";
  const authModeBlocked = Boolean(card.configAuthMode && card.configAuthMode !== "api-key");
  const apiKeyUnsupported = card.apiKeySupported === false;
  const mutationDisabled = configMutationDisabled(props);
  const keyBlocked = authModeBlocked
    ? t("modelProviders.apiKey.authModeBlocked", { mode: card.configAuthMode ?? "" })
    : blocked;
  return html`
    <div class="model-providers__card-actions">
      ${
        props.canConnect(card) && card.profiles.length === 0
          ? html`<button
              class="btn btn--sm"
              data-models-connect-provider=${card.id}
              ?disabled=${mutationDisabled || props.loginBusy}
              @click=${() => props.onConnect(card)}
            >
              ${t("modelProviders.login.action")}
            </button>`
          : nothing
      }
      ${
        hasProviderCredentials(card)
          ? html`
              <button
                class="btn btn--sm"
                ?disabled=${probeBusy || !props.canMutate || !props.probeAvailable}
                title=${!props.probeAvailable ? t("modelProviders.probe.unavailable") : blocked}
                @click=${() => props.onProbe(card.id, credentialProviders)}
              >
                ${probeBusy ? t("modelProviders.probe.testing") : t("modelProviders.probe.test")}
              </button>
            `
          : nothing
      }
      ${
        apiKeyUnsupported
          ? nothing
          : html`
              <button
                class="btn btn--sm"
                ?disabled=${keyBusy || mutationDisabled || authModeBlocked}
                title=${keyBlocked}
                @click=${() => props.onOpenKeyEditor(card.id)}
              >
                ${t("modelProviders.apiKey.set")}
              </button>
            `
      }
      ${
        card.hasConfigApiKey ||
        card.profiles.some((profile) => profile.type === "api_key" && profile.logoutSupported)
          ? html`
              <button
                class="btn btn--sm danger"
                ?disabled=${keyBusy || mutationDisabled || authModeBlocked}
                title=${keyBlocked}
                @click=${() => props.onRemoveKey(card.id, card.configKey ?? card.id)}
              >
                ${t("modelProviders.apiKey.remove")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

export function renderProviderRow(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const models = modelsText(card);
  const endpoint = props.providerEndpoint?.(card);
  const message = props.messages[`key:${card.id}`] ?? props.messages[card.id];
  return html`
    <div
      class="settings-row settings-row--stacked model-providers__row"
      data-provider-id=${card.id}
    >
      <div class="model-providers__head">
        <div class="model-providers__identity">
          ${renderProviderBrandIcon(card.id, { className: "model-providers__icon" })}
          <div class="settings-row__text">
            <span class="settings-row__title">${card.displayName}</span>
            <span class="settings-row__desc">${card.id}</span>
          </div>
        </div>
        <div class="settings-row__control">${renderProviderStatus(card)}</div>
      </div>
      <div class="model-providers__connection-summary">
        <div>
          <span>${t("modelProviders.manager.endpoint")}</span>
          <code title=${endpoint ?? ""}
            >${endpoint ?? t("modelProviders.manager.defaultEndpoint")}</code
          >
        </div>
        <div>
          <span>${t("modelProviders.manager.models")}</span>
          <strong>${models ?? t("modelProviders.models", { count: "0" })}</strong>
        </div>
      </div>
      ${
        props.onProviderModels || props.onProviderSettings
          ? html`<div class="model-providers__manager-actions">
              ${
                props.onProviderModels
                  ? html`<button
                      type="button"
                      class="btn btn--sm"
                      data-provider-models=${card.id}
                      @click=${() => props.onProviderModels?.(card)}
                    >
                      ${t("modelProviders.manager.models")}
                    </button>`
                  : nothing
              }
              ${
                props.onProviderSettings
                  ? html`<button
                      type="button"
                      class="btn btn--sm"
                      data-provider-settings=${card.id}
                      @click=${() => props.onProviderSettings?.(card)}
                    >
                      ${t("modelProviders.manager.settings")}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
      <details class="model-providers__card-details" ?open=${props.keyEditorProvider === card.id}>
        <summary>${t("modelProviders.manager.details")}</summary>
        <div class="model-providers__card-details-body">
          ${
            card.profiles.length > 0 && props.canViewProfiles
              ? renderProviderProfiles(card, {
                  ...props,
                  canMutate: props.canMutate && !props.configBusy,
                  onAddAccount: props.canConnect(card) ? () => props.onConnect(card) : undefined,
                  addAccountDisabled: props.loginBusy || configMutationDisabled(props),
                })
              : renderCredentialSummary(card, props.credentialAgentLabel)
          }
          <div
            class="model-providers__global-metrics"
            aria-busy=${props.supplementalLoading ? "true" : "false"}
          >
            <div class="model-providers__global-metrics-title">
              ${t("modelProviders.globalUsage")}
            </div>
            ${card.usage?.plan ? renderSettingsValue(card.usage.plan) : nothing}
            ${
              card.usage
                ? renderProviderUsageDetails(card.usage)
                : html`<div class="model-providers__no-stats">
                    ${t(props.supplementalLoading ? "common.loading" : "modelProviders.noStats")}
                  </div>`
            }
            ${renderLocalCost(card, props.costDays)}
          </div>
          ${renderProviderActions(card, props)} ${renderKeyEditor(card, props)}
        </div>
      </details>
      ${renderProbeResult(props.probeResults[card.id])} ${renderMutationMessage(message)}
    </div>
  `;
}

export function renderAddProvider(props: ModelProvidersViewProps) {
  if (!props.addProviderOpen) {
    return nothing;
  }
  const busy = Boolean(props.busy.add);
  const disabled = configMutationDisabled(props) || busy;
  const provider = props.unconfiguredProviders.find((entry) => entry.id === props.addProviderId);
  return html`
    <openclaw-modal-dialog
      label=${t("modelProviders.add.title")}
      @modal-cancel=${(event: Event) => {
        event.preventDefault();
        if (!busy) {
          props.onAddProviderToggle();
        }
      }}
    >
      <div class="model-setup-wizard" data-models-key-dialog>
        <div class="model-setup-wizard__header">
          <h2>${provider?.displayName ?? props.addProviderId}</h2>
        </div>
        <div class="model-setup-wizard__body">
          <p>${t("modelProviders.credentials.label", { agent: props.credentialAgentLabel })}</p>
          <label class="field">
            <span>${t("modelProviders.apiKey.label")}</span>
            <input
              type="password"
              autocomplete="off"
              placeholder=${t("modelProviders.apiKey.placeholder")}
              .value=${props.addProviderKey}
              ?disabled=${disabled}
              @input=${(event: Event) => props.onAddProviderKeyChange((event.target as HTMLInputElement).value)}
            />
          </label>
          ${renderMutationMessage(props.messages.add)}
        </div>
        <div class="model-setup-wizard__footer">
          <button class="btn" ?disabled=${busy} @click=${props.onAddProviderToggle}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary"
            ?disabled=${disabled || !props.addProviderId || !props.addProviderKey.trim()}
            @click=${props.onAddProvider}
          >
            ${busy ? t("modelProviders.saving") : t("modelProviders.add.save")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

export function renderModelReadiness(props: ModelProvidersViewProps) {
  const signedIn = props.cards.some(hasVerifiedProvider);
  return html`
    <div class="model-providers__setup" data-model-readiness="model-required">
      ${renderSettingsSection(
        { title: t("modelProviders.readiness.title") },
        renderSettingsRow({
          title: t("modelProviders.readiness.heading"),
          description: signedIn
            ? t("modelProviders.readiness.signedInNoModels")
            : t("modelProviders.readiness.notConfigured"),
          control: html`
            ${renderSettingsStatus({
              kind: "warn",
              label: signedIn
                ? t("modelProviders.readiness.noModels")
                : t("modelProviders.readiness.modelRequired"),
            })}
            <button
              class="btn primary"
              ?disabled=${configMutationDisabled(props) || props.loginBusy}
              title=${props.mutationBlockedReason ?? ""}
              @click=${props.onConnectProvider}
            >
              ${t("modelProviders.login.action")}
            </button>
          `,
        }),
      )}
    </div>
  `;
}

export function renderProviderNoticeRow(text: string) {
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__desc provider-usage-error">${text}</span>
      </div>
    </div>
  `;
}
