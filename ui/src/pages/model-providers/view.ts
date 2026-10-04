import { html, nothing, type TemplateResult } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderDefaultModels } from "./default-models-view.ts";
import {
  configMutationDisabled,
  renderAddProvider,
  renderModelReadiness,
  renderProviderNoticeRow,
  renderProviderRow,
  type ModelProvidersViewProps,
} from "./view-provider-card.ts";
import { renderModelProviderConnectAction, renderMutationMessage } from "./view-status.ts";

registerSettingsEnglish();

export function renderModelProviders(props: ModelProvidersViewProps) {
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsGroup(renderSettingsEmpty(t("modelProviders.disconnected"))),
    );
  }
  const query = (props.providerQuery ?? "").trim().toLocaleLowerCase();
  const category = props.providerCategory ?? "cloud";
  const matchesQuery = (values: string[]) =>
    values.some((value) => value.toLocaleLowerCase().includes(query));
  const isLocalOrCustom = (card: ModelProviderCard) => props.isLocalOrCustom?.(card) ?? false;
  const matchesCategory = (custom: boolean) =>
    !props.onProviderCategoryChange || custom === (category === "custom");
  const matchingCards = props.cards.filter(
    (card) =>
      matchesCategory(isLocalOrCustom(card)) &&
      matchesQuery([card.id, card.displayName, ...card.credentialProviderIds]),
  );
  const availableProviders = props.unconfiguredProviders.filter(
    (provider) =>
      matchesCategory(props.isLocalOrCustomProvider?.(provider.id) ?? false) &&
      matchesQuery([provider.id, provider.displayName]),
  );
  const providerRows = html`
    <div class="model-providers__overview-toolbar">
      ${
        props.onProviderCategoryChange
          ? html`<div
              class="model-providers__category-tabs"
              role="group"
              aria-label=${t("modelProviders.accessTitle")}
            >
              ${(["cloud", "custom"] as const).map(
                (entry) => html`<button
                  type="button"
                  class="btn btn--sm ${category === entry ? "primary" : "btn--ghost"}"
                  aria-pressed=${category === entry ? "true" : "false"}
                  data-provider-category=${entry}
                  @click=${() => props.onProviderCategoryChange?.(entry)}
                >
                  ${t(`modelProviders.manager.${entry}`)}
                </button>`,
              )}
            </div>`
          : nothing
      }
      <label class="field model-providers__search">
        <input
          type="search"
          aria-label=${t("modelProviders.search")}
          placeholder=${t("modelProviders.search")}
          .value=${props.providerQuery ?? ""}
          @input=${(event: Event) => props.onProviderQueryChange?.((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
    </div>
    <div class="model-providers__provider-list">
      ${props.error ? renderSettingsGroup(renderProviderNoticeRow(props.error)) : nothing}
      ${
        props.providerUsageFailed
          ? renderSettingsGroup(renderProviderNoticeRow(t("usage.providerUsage.unavailable")))
          : nothing
      }
      <div class="model-providers__provider-section">
        <h3>${t("modelProviders.manager.configured")}</h3>
        <div class="model-providers__provider-grid">
          ${
            props.cards.length === 0
              ? renderSettingsGroup(
                  renderSettingsEmpty(
                    html`<strong>${t("modelProviders.emptyTitle")}</strong
                      ><br />${t("modelProviders.emptySubtitle")}`,
                  ),
                )
              : matchingCards.map((card) => renderSettingsGroup(renderProviderRow(card, props)))
          }
          ${props.cards.length > 0 && matchingCards.length === 0 ? renderSettingsEmpty(t("modelProviders.noMatches")) : nothing}
        </div>
      </div>
      <div class="model-providers__provider-section model-providers__provider-section--available">
        <h3>${t("modelProviders.manager.available")}</h3>
        <div class="model-providers__available-grid">
          ${availableProviders.map(
            (provider) => html`<button
              type="button"
              class="btn model-providers__available-provider"
              data-available-provider=${provider.id}
              ?disabled=${configMutationDisabled(props) || props.loginBusy}
              @click=${() => (props.onAvailableProvider ? props.onAvailableProvider(provider.id) : props.onConnectProvider())}
            >
              ${renderProviderBrandIcon(provider.id, { className: "model-providers__icon" })}
              <span>${provider.displayName}</span>
              ${icons.chevronRight}
            </button>`,
          )}
          ${
            props.onCustomProvider && matchesCategory(true)
              ? html`<button
                  type="button"
                  class="btn model-providers__available-provider model-providers__available-provider--custom"
                  data-custom-provider
                  ?disabled=${configMutationDisabled(props) || props.loginBusy}
                  @click=${props.onCustomProvider}
                >
                  ${icons.plus}<span>${t("modelProviders.manager.customProvider")}</span>
                </button>`
              : nothing
          }
          ${availableProviders.length === 0 && !(props.onCustomProvider && matchesCategory(true)) ? renderSettingsEmpty(t("modelProviders.noMatches")) : nothing}
        </div>
      </div>
    </div>
  `;
  const needsModelSetup =
    !props.loading && !props.configuredModels.some((model) => model.available !== false);
  return html`${renderSettingsPage(html`
    ${needsModelSetup ? renderModelReadiness(props) : nothing}
    <div id=${MODEL_SETTINGS_TARGET_IDS.behavior}>
      ${renderDefaultModels({
        ...props,
        models: props.configuredModels,
        selection: props.defaultModels,
        canMutate: props.defaultsMutationBlockedReason === null && !props.configBusy,
        mutationBlockedReason: props.defaultsMutationBlockedReason,
        message: props.messages.defaults,
      })}
    </div>
    ${props.installedAgents}
    <div id="settings-model-providers">
      ${renderSettingsSection(
        {
          title: t("modelProviders.accessTitle"),
          description: t("modelProviders.accessDescription"),
          count: props.cards.length,
          actions: html`
            ${props.providerScope}
            ${
              props.updatedAt
                ? html`<span class="model-providers__updated"
                    >${t("modelProviders.updated", {
                      time: formatTimeMs(props.updatedAt, {
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}</span
                  >`
                : nothing
            }
            <openclaw-tooltip
              .content=${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
            >
              <button
                type="button"
                class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
                aria-label=${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
                ?disabled=${props.refreshing}
                @click=${() => props.onRefresh()}
              >
                ${icons.refresh}
              </button>
            </openclaw-tooltip>
          `,
        },
        html`${props.accountRecovery}${
          props.loading
            ? renderSettingsGroup(renderSettingsLoadingSkeleton())
            : // The custom entry stays reachable through Connect provider even when
              // the area is hidden, so a truly empty scope renders no stray section.
              props.cards.length === 0 &&
                props.unconfiguredProviders.length === 0 &&
                props.installedAgents !== nothing &&
                !props.error &&
                !props.providerUsageFailed
              ? nothing
              : providerRows
        }`,
      )}
    </div>
    ${
      props.providerUsageStalled
        ? html`<div class="callout warning" role="status">${t("usage.providerUsage.stalled")}</div>`
        : nothing
    }
    ${props.catalogSettings ?? nothing}
  `)}${renderAddProvider(props)}`;
}

/** The Settings selection scopes provider access, never the global defaults above it. */
export function renderModelProviderScope(props: {
  agentLabel: string;
  onConnect: () => void;
  connectDisabled: boolean;
}): TemplateResult {
  return html`
    <span class="muted" data-models-provider-agent
      >${t("agentScope.label")}: ${props.agentLabel}</span
    >
    ${renderModelProviderConnectAction(props)}
  `;
}

export function renderModelProvidersPageShell(props: {
  body: TemplateResult;
  login: TemplateResult;
  loginMessage?: ModelProviderRowMessage;
}): TemplateResult {
  return html`
    ${renderSettingsPageHeader({
      title: titleForRoute("model-providers"),
      subtitle: html`${t("modelProviders.subtitle")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/concepts/model-providers")}`,
    })}
    ${renderSettingsWorkspace(html`${renderMutationMessage(props.loginMessage)}${props.body}`)}
    ${props.login}
  `;
}
