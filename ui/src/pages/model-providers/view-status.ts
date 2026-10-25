import { html, nothing } from "lit";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";

registerModelControlsEnglish();

function hasProviderCredentials(card: ModelProviderCard): boolean {
  return card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
}

function hasVerifiedProvider(card: ModelProviderCard): boolean {
  return (
    card.catalogStatus === "ready" &&
    card.auth?.kind !== "expired" &&
    card.auth?.kind !== "missing" &&
    card.auth?.kind !== "expiring"
  );
}

/**
 * Display-only mapping, mirroring ZCode's three provider states: ready
 * (green, catalog-confirmed with usable models), not ready (yellow,
 * credentials exist but the catalog has not confirmed usable models), and
 * not enabled (gray, the card carries no credentials at all).
 */
export function renderProviderStatus(card: ModelProviderCard) {
  if (card.checkingModels) {
    return renderSettingsStatus({
      kind: "muted",
      label: t("chat.modelControls.checkingProviderModels", { providers: card.displayName }),
    });
  }
  const ready = hasVerifiedProvider(card) && card.availableModelCount > 0;
  const hasCredentials = hasProviderCredentials(card);
  return renderSettingsStatus({
    kind: ready ? "ok" : hasCredentials ? "warn" : "muted",
    label: t(
      ready
        ? "modelProviders.status.ready"
        : hasCredentials
          ? "modelProviders.status.notReady"
          : "modelProviders.status.notEnabled",
    ),
  });
}

export function renderMutationMessage(message: ModelProviderRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`
    <div class="callout ${message.kind}" role=${message.kind === "error" ? "alert" : "status"}>
      ${message.text}
    </div>
    ${message.warning ? html`<div class="callout warning" role="status">${message.warning}</div>` : nothing}
  `;
}

export function renderModelProviderConnectAction(
  props: {
    onConnect: () => void;
    connectDisabled: boolean;
  },
  primary = false,
) {
  return html`<button
    class=${primary ? "btn primary" : "btn"}
    data-models-connect
    ?disabled=${props.connectDisabled}
    @click=${props.onConnect}
  >
    ${t("modelProviders.login.action")}
  </button>`;
}
