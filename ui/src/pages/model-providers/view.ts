import { html, nothing, type TemplateResult } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
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
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { renderDefaultModels } from "./default-models-view.ts";
import { renderProviderWorkspace } from "./provider-workspace-view.ts";
import {
  renderAddProvider,
  renderModelReadiness,
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
  const providerRows = renderProviderWorkspace(props);
  const needsModelSetup =
    !props.loading && !props.configuredModels.some((model) => model.available !== false);
  return html`${renderSettingsPage(
    html`
      ${needsModelSetup ? renderModelReadiness(props) : nothing}
      <div id="settings-model-providers">
        ${renderSettingsSection(
          {
            title: t("modelProviders.accessTitle"),
            description: t("modelProviders.accessDescription"),
            count: props.cards.length,
            actions: html`
              ${props.providerScope}
              <button
                type="button"
                class="btn primary"
                data-custom-provider
                ?disabled=${props.configBusy || !props.canMutate}
                @click=${props.onCustomProvider}
              >
                ${icons.plus}${t("modelProviders.manager.addProvider")}
              </button>
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
            props.loading ? renderSettingsGroup(renderSettingsLoadingSkeleton()) : providerRows
          }`,
        )}
      </div>
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
      ${props.installedAgents} ${props.catalogSettings ?? nothing}
    `,
    { wide: true },
  )}${renderAddProvider(props)}`;
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
