import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentSession } from "../../sessions/index.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

/** Same-prompt plan-completion follow-up, extracted from the terminal gate. */
export type PlanCompletionCheck = NonNullable<EmbeddedRunAttemptInternalParams["completionCheck"]>;

export type PlanCompletionGuards = {
  lastAssistant: AssistantMessage | undefined;
  lastAssistantRefusal: boolean;
  hasPendingContinuation: boolean;
  hasDeliveredSourceReply: () => boolean;
  runAborted: boolean;
  aborted: boolean;
  timedOut: boolean;
  promptError: boolean;
  yieldDetected: boolean;
  admissionClosed: boolean;
  hasQueuedInput: boolean;
  isCurrentRun: boolean;
};

export function isPlanCompletionEligible(
  completionCheck: PlanCompletionCheck | undefined,
  guards: PlanCompletionGuards,
): boolean {
  return Boolean(
    completionCheck?.unfinishedPlan &&
    !completionCheck.checked &&
    guards.lastAssistant?.stopReason === "stop" &&
    !guards.lastAssistantRefusal &&
    !guards.hasPendingContinuation &&
    !guards.hasDeliveredSourceReply() &&
    !guards.runAborted &&
    !guards.aborted &&
    !guards.timedOut &&
    !guards.promptError &&
    !guards.yieldDetected &&
    !guards.admissionClosed &&
    !guards.hasQueuedInput &&
    guards.isCurrentRun,
  );
}

export const PLAN_COMPLETION_CHECK_MESSAGE =
  "This run’s latest successfully saved plan still has unfinished steps. Before ending, check whether those steps remain required and authorized under the latest user instructions. Continue feasible work from the current transcript; do not repeat completed actions, and reconcile uncertain effects before retrying. If work is complete, reconcile the plan. If user input, approval, an external dependency, or an explicit pause prevents further work, report that concrete limitation. Do not invent completion or new authority.";

/** Sends the hidden same-prompt follow-up; the check is consumed by the caller. */
export async function sendPlanCompletionFollowUp(activeSession: AgentSession): Promise<void> {
  await activeSession.sendCustomMessage(
    {
      customType: "openclaw.plan-completion-check",
      display: false,
      content: PLAN_COMPLETION_CHECK_MESSAGE,
    },
    { deliverAs: "followUp" },
  );
}
