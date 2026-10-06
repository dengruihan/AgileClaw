import type { WizardNextResult, WizardStep } from "../../api/types.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";

export const MODEL_SETUP_AUTH_START_TIMEOUT_MS = 30_000;
export const MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS = null;

export type ModelSetupWizardResult =
  | WizardNextResult
  | { done: true; status: "not-admitted"; error: string };

type ModelSetupWizardPhase =
  | { phase: "idle" }
  | { phase: "starting"; authChoice: string; notice?: string }
  | {
      phase: "step";
      authChoice: string;
      step: WizardStep;
      externalAuthInput?: boolean;
      busy: boolean;
      validationError: string | null;
    }
  | { phase: "done" }
  | { phase: "cancelled"; message: string }
  | { phase: "error"; message: string };

export type ModelSetupWizardState = ModelSetupWizardPhase & { authLabel?: string };
export type ModelSetupWizardDraft = { stepId: string | null; value: unknown };

export function updateModelSetupWizardDraft(
  draft: ModelSetupWizardDraft,
  state: ModelSetupWizardState,
): ModelSetupWizardDraft {
  if (state.phase === "idle") {
    return { stepId: null, value: undefined };
  }
  if (state.phase === "step" && state.step.id !== draft.stepId) {
    return { stepId: state.step.id, value: initialWizardValue(state.step) };
  }
  return draft;
}

export function wizardStateFromResult(
  authChoice: string,
  result: ModelSetupWizardResult,
  fallbackError: string,
): ModelSetupWizardState {
  if (!result.done && result.step) {
    return {
      phase: "step",
      authChoice,
      step: result.step,
      busy: false,
      validationError: result.error?.trim() ? formatUiExternalText(result.error) : null,
    };
  }
  if (result.done && result.status === "done") {
    return { phase: "done" };
  }
  if (result.status === "cancelled") {
    return { phase: "cancelled", message: formatUiExternalText(result.error, fallbackError) };
  }
  return { phase: "error", message: formatUiExternalText(result.error, fallbackError) };
}

export function initialWizardValue(step: WizardStep): unknown {
  if (step.type === "multiselect") {
    return Array.isArray(step.initialValue) ? [...step.initialValue] : [];
  }
  return step.initialValue;
}
