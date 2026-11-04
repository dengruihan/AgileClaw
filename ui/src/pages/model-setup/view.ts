import { html, nothing, type TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import "../../styles/model-setup.css";
import { renderCandidateRows } from "./candidate-models.ts";
import { renderActivationFeedback, renderConfiguredUtilityModel } from "./configured-model.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";
import type { NativeModelSetup } from "./native-model-setup.ts";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderName, renderManualProviderPicker } from "./provider-picker.ts";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupWizardState,
} from "./state.ts";
import { renderModelSetupSuccessDialog } from "./success-dialog.ts";
import { renderModelSetupWizard } from "./wizard-view.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
type ModelSetupViewProps = {
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
  onDiscoveryShown?: () => void;
  detecting?: boolean;
  detectionError?: string | null;
  page: ModelSetupPageState;
  activation: ModelSetupActivationState;
  wizard: ModelSetupWizardState;
  wizardMode: "auth" | "prepare" | "activate";
  wizardValue: unknown;
  canAdmin: boolean;
  canPrepare: boolean;
  gatewayTooOld: boolean;
  refreshWarning: string | null;
  cancellationNotice?: string | null;
  actionsDisabled: boolean;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  nativeSessionCatalogsEnabled?: boolean;
  onNativeSessionCatalogsChange?: (enabled: boolean) => void;
  nativeModels?: NativeModelSetup;
  iconUrls: Readonly<Record<string, string>>;
  onDetect: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
  onStartAuth: (option: AuthOption) => void;
  onStartPrepare: (option: ModelSetupPrepareOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onIconError: (iconUrl: string) => void;
  onOpenChat: () => void;
  onOpenSetupAssistant?: () => void;
  onSuccessClose: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown, includeValue?: boolean) => void;
  onWizardCancel: () => void;
  onWizardClose: () => void;
};

function renderEmptyState(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const installs = result.recommendedInstalls ?? [];
  if (
    props.nativeModels?.count ||
    result.candidates.length > 0 ||
    (result.authOptions?.length ?? 0) > 0 ||
    installs.length === 0
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__empty">
      <div class="settings-section__header">
        <h2>${t("modelSetup.empty.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.empty.intro")}</p>
      <div class="model-setup__recommendations">
        ${installs.map(
          (install) => html`
            <div class="model-setup__recommendation" data-recommended-install=${install.id}>
              ${renderProviderIcon(props, install, "model-setup__icon--recommendation")}
              <div class="model-setup__row-main">
                <strong>${install.label}</strong>
                <div class="muted">${install.hint}</div>
                <a href=${install.website} target="_blank" rel="noopener">${install.website}</a>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderSetupActionRow(
  props: ModelSetupViewProps,
  option: AuthOption | ModelSetupPrepareOption,
) {
  const auth = "kind" in option;
  const groupLabel = auth ? option.groupLabel : undefined;
  return html`
    <div
      class="model-setup__row"
      data-auth-choice=${auth ? option.id : nothing}
      data-prepare-choice=${auth ? nothing : option.id}
    >
      <div class="model-setup__provider-copy">
        ${renderProviderIcon(props, option)}
        <div>
          <strong>${option.label}</strong>
          ${groupLabel ? html`<div class="muted">${groupLabel}</div>` : nothing}
          ${option.hint ? html`<div class="muted">${option.hint}</div>` : nothing}
        </div>
      </div>
      <button
        type="button"
        class="btn"
        ?disabled=${props.actionsDisabled || props.detecting}
        @click=${() => (auth ? props.onStartAuth(option) : props.onStartPrepare(option))}
      >
        ${
          auth
            ? t(
                option.kind === "install"
                  ? "modelSetup.signIn.install"
                  : option.kind === "custom"
                    ? "modelSetup.signIn.custom"
                    : "modelSetup.signIn.verify",
              )
            : (option.actionLabel ?? t("modelSetup.prepare.ollamaButton"))
        }
      </button>
    </div>
  `;
}

function renderSignIn(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const options = (result.authOptions ?? [])
    .filter((option) => !props.credentialChoices?.includes(option.id))
    .toSorted((a, b) => a.label.localeCompare(b.label));
  if (options.length === 0) {
    return nothing;
  }
  const featured = options.filter(
    (option) => option.featured || option.kind === "install" || option.kind === "custom",
  );
  const more = options.filter((option) => !featured.includes(option));
  const renderOption = (option: AuthOption) => renderSetupActionRow(props, option);
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.signIn.title")}</h2>
        <p>${t("modelSetup.signIn.description")}</p>
      </div>
      <div class="model-setup__rows">${featured.map(renderOption)}</div>
      ${
        more.length
          ? html`<details
              class="model-setup__more"
              .open=${props.moreSignInOpen}
              @toggle=${(event: Event) =>
                props.onMoreSignInToggle((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>${t("modelSetup.signIn.more")}</summary>
              <div class="model-setup__rows">${more.map(renderOption)}</div>
            </details>`
          : nothing
      }
    </section>
  `;
}

function renderPrepare(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (!props.canPrepare) {
    return nothing;
  }
  const options = listModelSetupPrepareOptions(result);
  if (options.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.prepare.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.prepare.intro")}</p>
      <div class="model-setup__rows">
        ${options.map((option) => renderSetupActionRow(props, option))}
      </div>
    </section>
  `;
}

function renderManual(props: ModelSetupViewProps, detected: SystemAgentSetupDetectResult) {
  const result = {
    ...detected,
    manualProviders: detected.manualProviders.filter(
      (provider) => !props.credentialChoices?.includes(provider.id),
    ),
  };
  if (result.manualProviders.length === 0) {
    return nothing;
  }
  const provider = result.manualProviders.find((entry) => entry.id === props.manualProviderId);
  const targetId = `manual:${props.manualProviderId}`;
  const manualId = "model-discovery-manual";
  const testing = props.activation.phase === "testing" && props.activation.targetId === targetId;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.manual.title")}</h2>
      </div>
      <div class="model-setup__manual">
        <div class="field">
          <span>${t("modelSetup.manual.provider")}</span>
          ${renderManualProviderPicker(props, result, provider)}
        </div>
        <label class="field">
          <span>
            ${
              provider
                ? t("modelSetup.manual.accessValueFor", { provider: manualProviderName(provider) })
                : t("modelSetup.manual.accessValue")
            }
          </span>
          <input
            class="input"
            type="password"
            autocomplete="off"
            required
            aria-invalid=${props.manualError ? "true" : nothing}
            aria-describedby=${`${manualId}-help${props.manualError ? ` ${manualId}-error` : ""}`}
            .value=${props.manualApiKey}
            ?disabled=${props.actionsDisabled}
            placeholder=${t("modelSetup.manual.accessValuePlaceholder")}
            @input=${(event: Event) =>
              props.onManualApiKeyChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div id=${`${manualId}-help`} class="model-setup__manual-help">
          ${icons.shieldCheck}
          <span>${t("modelSetup.manual.verifyHint")}</span>
        </div>
        ${
          props.manualError
            ? html`<div id=${`${manualId}-error`} class="callout danger" role="alert">
                ${props.manualError}
              </div>`
            : nothing
        }
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled || props.detecting || !props.manualProviderId}
          @click=${props.onManualConnect}
        >
          ${
            testing
              ? t("modelSetup.candidates.testingButton")
              : t("modelSetup.discovery.connectForAgent")
          }
        </button>
      </div>
    </section>
  `;
}

export function revealModelSetupFeedback(root: ParentNode): void {
  // Reveal only this attempt synchronously; never move focus or leave work past route exit.
  root
    .querySelector(".model-setup > .model-setup__testing, .model-setup > .model-setup__failure")
    ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
}

function renderNativeSessionDiscovery(
  props: ModelSetupViewProps,
  result: SystemAgentSetupDetectResult,
) {
  if (
    result.nativeSessionCatalogPreferenceRequired !== true ||
    !result.nativeSessionCatalogs?.length
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__native-discovery">
      <div class="settings-section__header"><h2>${t("modelSetup.nativeDiscovery.title")}</h2></div>
      <p class="muted">${t("modelSetup.nativeDiscovery.body")}</p>
      <p>${result.nativeSessionCatalogs.map((option) => option.label).join(", ")}</p>
      <label>
        <input
          type="checkbox"
          .checked=${props.nativeSessionCatalogsEnabled === true}
          ?disabled=${props.actionsDisabled}
          @change=${(event: Event) => {
            // SAFETY: This listener is attached directly to the checkbox input above.
            const input = event.currentTarget as HTMLInputElement;
            props.onNativeSessionCatalogsChange?.(input.checked);
          }}
        />
        ${t("modelSetup.nativeDiscovery.enable")}
      </label>
      <p class="muted">${t("modelSetup.nativeDiscovery.decline")}</p>
    </section>
  `;
}

function renderReady(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const current = renderConfiguredUtilityModel({
    result,
    activation: props.activation,
    canRepair: props.canAdmin && !props.gatewayTooOld,
    actionsDisabled: props.actionsDisabled || props.detecting === true,
    onOpenAssistant: props.onOpenSetupAssistant ?? props.onOpenChat,
    onActivateCandidate: props.onActivateCandidate,
  });
  if (!props.canAdmin) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.adminRequired")}</div>`;
  }
  if (props.gatewayTooOld) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.gatewayTooOld")}</div>`;
  }
  return html`
    ${current} ${renderNativeSessionDiscovery(props, result)} ${renderEmptyState(props, result)}
    ${props.nativeModels?.render()} ${renderCandidateRows(props, result)}
    ${renderPrepare(props, result)} ${renderSignIn(props, result)} ${renderManual(props, result)}
  `;
}

export function renderModelSetup(props: ModelSetupViewProps): TemplateResult {
  let body: unknown;
  if (props.page.phase === "ready") {
    body = renderReady(props, props.page.result);
  } else if (!props.canAdmin) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.adminRequired")}
    </div>`;
  } else if (props.gatewayTooOld) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.gatewayTooOld")}
    </div>`;
  } else if (props.page.phase === "loading") {
    body = html`<div class="model-setup__loading" role="status">${t("modelSetup.loading")}</div>`;
  } else if (props.page.phase === "detect-error") {
    body = html`
      <div class="callout danger" role="alert">${props.page.message}</div>
      <button type="button" class="btn" ?disabled=${props.detecting} @click=${props.onDetect}>
        ${t("modelSetup.retry")}
      </button>
    `;
  }
  const content = html`
    <div
      class="model-setup"
      aria-busy=${props.detecting || props.page.phase === "loading" ? "true" : "false"}
    >
      <div class="model-setup__intro">
        <div>
          <h2>${t("modelSetup.discovery.title")}</h2>
          <p>${t("modelSetup.discovery.description", { agent: props.agentLabel ?? "" })}</p>
        </div>
        ${
          props.page.phase === "ready" &&
          props.activation.phase !== "success" &&
          props.canAdmin &&
          !props.gatewayTooOld
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled || props.detecting}
                @click=${props.onDetect}
              >
                ${props.detecting ? t("modelSetup.verify.checkingButton") : t("modelSetup.checkAgain")}
              </button>`
            : nothing
        }
      </div>
      ${
        props.canAdmin && !props.gatewayTooOld
          ? renderActivationFeedback(props.activation)
          : nothing
      }
      ${
        props.refreshWarning
          ? html`<div class="callout warning" role="alert">${props.refreshWarning}</div>`
          : nothing
      }
      ${props.detectionError ? html`<div class="callout warning" role="alert">${props.detectionError}</div>` : nothing}
      ${props.detecting && props.page.phase === "ready" ? html`<div class="muted" role="status">${t("modelSetup.loading")}</div>` : nothing}
      ${body}
    </div>
  `;
  const dialogs = html`
    <div @modal-cancel=${(event: Event) => event.preventDefault()}>
      ${renderModelSetupWizard({
        mode: props.wizardMode,
        state: props.wizard,
        refreshWarning: props.refreshWarning,
        cancellationNotice: props.cancellationNotice,
        value: props.wizardValue,
        onValueChange: props.onWizardValueChange,
        onAnswer: props.onWizardAnswer,
        onCancel: props.onWizardCancel,
        onClose: props.onWizardClose,
      })}
    </div>
    ${
      props.activation.phase === "success"
        ? renderModelSetupSuccessDialog(
            props.activation,
            props.activation.modelTarget === "utility"
              ? (props.onOpenSetupAssistant ?? props.onOpenChat)
              : props.onOpenChat,
            props.onSuccessClose,
          )
        : nothing
    }
  `;
  const wizardOpen = props.wizard.phase !== "idle" || props.activation.phase === "success";
  return html`
    ${cache(
      wizardOpen
        ? nothing
        : html`<openclaw-modal-dialog
            label=${t("modelSetup.discovery.title")}
            @modal-cancel=${() => props.onClose?.()}
            @wa-after-show=${(event: Event) =>
              event.target === event.currentTarget ? props.onDiscoveryShown?.() : undefined}
          >
            <div class="model-setup-wizard model-setup-discovery">
              <div class="model-setup-wizard__body">${content}</div>
              <div class="model-setup-wizard__footer">
                <button class="btn" @click=${() => props.onClose?.()}>${t("common.close")}</button>
              </div>
            </div>
          </openclaw-modal-dialog>`,
    )}
    ${dialogs}
  `;
}
