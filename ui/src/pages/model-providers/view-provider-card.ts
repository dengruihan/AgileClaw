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
import type { DefaultModelSelection, ModelPickerEntry, ModelProviderCard } from "./data.ts";
import type { DefaultModelsViewProps } from "./default-models-view.ts";
import {
  apiKeySource,
  renderProviderProfiles,
  type ProviderProfilesViewProps,
} from "./profiles-view.ts";
import { hasVerifiedProvider, renderProviderStatus, renderMutationMessage } from "./view-status.ts";

export type ModelProvidersViewProps = Omit<
  DefaultModelsViewProps,
  "models" | "selection" | "message"
> &
  Omit<ProviderProfilesViewProps, "onAddAccount" | "addAccountDisabled"> & {
    connected: boolean;
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
    canViewProfiles: boolean;
    defaultsMutationBlockedReason: string | null;
    /** Usage never converged before the retry budget ran out; cards lack usage. */
    providerUsageStalled: boolean;
    probeAvailable: boolean;
    messages: Record<string, ModelProviderRowMessage>;
    probeResults: Record<string, ModelsProbeResult>;
    onRefresh: () => void;
    onProbe: (cardId: string, providers: string[]) => void;
    providerScope?: TemplateResult;
    providerEndpoint?: (card: ModelProviderCard) => string | undefined;
    onProviderSettings?: (card: ModelProviderCard) => void;
    providerQuery?: string;
    onProviderQueryChange?: (value: string) => void;
    onConnectProvider: () => void;
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
  const apiProfileCount = card.profiles.filter((profile) => profile.type === "api_key").length;
  const parts = [];
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

function renderProviderActions(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const probeBusy = Boolean(props.busy[`probe:${card.id}`]);
  return html`<div class="model-providers__card-actions">
    <button
      class="btn btn--sm"
      ?disabled=${probeBusy || !props.canMutate || !props.probeAvailable}
      title=${
        !props.probeAvailable
          ? t("modelProviders.probe.unavailable")
          : (props.mutationBlockedReason ?? "")
      }
      @click=${() => props.onProbe(card.id, [card.configKey ?? card.id])}
    >
      ${probeBusy ? t("modelProviders.probe.testing") : t("modelProviders.probe.test")}
    </button>
  </div>`;
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
      <div class="model-providers__manager-actions">
        <button
          type="button"
          class="btn btn--sm"
          data-provider-settings=${card.id}
          ?disabled=${configMutationDisabled(props)}
          title=${props.mutationBlockedReason ?? ""}
          @click=${() => props.onProviderSettings?.(card)}
        >
          ${t("modelProviders.manager.editProvider")}
        </button>
      </div>
      <details class="model-providers__card-details">
        <summary>${t("modelProviders.manager.details")}</summary>
        <div class="model-providers__card-details-body">
          ${
            card.profiles.length > 0 && props.canViewProfiles
              ? renderProviderProfiles(card, {
                  ...props,
                  canMutate: props.canMutate && !props.configBusy,
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
          ${renderProviderActions(card, props)}
        </div>
      </details>
      ${renderProbeResult(props.probeResults[card.id])} ${renderMutationMessage(message)}
    </div>
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
              ?disabled=${configMutationDisabled(props)}
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
