import { html, nothing, type TemplateResult } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { activationTargetId, type ModelSetupActivationState } from "./state.ts";

registerModelSetupEnglish();

type Candidate = SystemAgentSetupDetectResult["candidates"][number];

export function renderConfiguredUtilityModel(props: {
  result: SystemAgentSetupDetectResult;
  activation: ModelSetupActivationState;
  canRepair: boolean;
  actionsDisabled: boolean;
  onOpenAssistant: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
}) {
  const modelRef = props.result.utilityModel ?? props.result.setupModel;
  if (!modelRef) {
    return nothing;
  }
  const repairCandidate = props.canRepair
    ? props.result.candidates.find(
        (candidate) =>
          candidate.modelTarget === "utility" &&
          candidate.modelRef === modelRef &&
          candidate.kind.startsWith("provider-auto:"),
      )
    : undefined;
  const repairing =
    repairCandidate &&
    props.activation.phase === "testing" &&
    props.activation.targetId ===
      activationTargetId(repairCandidate.kind, repairCandidate.modelRef);
  return html`<section class="settings-section model-setup__utility">
    <div class="settings-section__header"><h2>${t("modelSetup.utility.configured")}</h2></div>
    <div class="model-setup__row">
      <div class="model-setup__row-main">
        <strong>${modelRef}</strong>
        <div class="muted">
          ${t(
            props.result.configuredModel
              ? "modelSetup.utility.primaryReady"
              : "modelSetup.utility.choosePrimary",
          )}
        </div>
      </div>
      <div class="model-setup__row-actions">
        ${
          repairCandidate
            ? html`<button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled}
                @click=${() => props.onActivateCandidate(repairCandidate)}
              >
                ${t(repairing ? "modelSetup.candidates.testingButton" : "modelSetup.utility.repair")}
              </button>`
            : nothing
        }
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled}
          @click=${props.onOpenAssistant}
        >
          ${t("modelSetup.utility.openAssistant")}
        </button>
      </div>
    </div>
  </section>`;
}

const FAILURE_KEYS: Record<string, string> = {
  auth: "auth",
  rate_limit: "rateLimit",
  billing: "billing",
  timeout: "timeout",
  format: "format",
  unavailable: "unavailable",
  unknown: "unknown",
};

function renderModelSetupFailure(status: string, error: string): TemplateResult {
  const key = FAILURE_KEYS[status] ?? "unknown";
  return html`
    <div class="model-setup__failure" role="alert">
      <span class="model-setup__failure-icon" aria-hidden="true">${icons.alertTriangle}</span>
      <span
        ><strong>${t(`modelSetup.failure.${key}`)}.</strong> ${error}
        ${key === "unavailable" ? nothing : t(`modelSetup.failureGuidance.${key}`)}</span
      >
    </div>
  `;
}

export function renderActivationFeedback(activation: ModelSetupActivationState) {
  // Feedback follows the activation attempt, including prepared models absent from discovery.
  if (activation.phase === "testing") {
    return html`<div class="model-setup__testing" role="status">${t("modelSetup.testing")}</div>`;
  }
  return activation.phase === "failure"
    ? renderModelSetupFailure(activation.status, activation.error)
    : nothing;
}
