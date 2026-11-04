import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../../runtime/index.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import { createFreshLlmBoundaryTokenEstimator } from "../../sessions/context-token-pressure.js";
import type { CustomMessage } from "../../sessions/messages.js";

export const TURN_CONTEXT_CUSTOM_TYPE = "openclaw.background-context";
const RECEIPT_CUSTOM_TYPE = "openclaw.background-context-receipt";
export const MAX_INPUT_CONTRIBUTION_TOKENS = 50_000;

export type BackgroundContextCarrier = {
  message: CustomMessage;
  pluginKey: string;
  contributionId: string;
  inputId: string;
  /** Terminal follow-ups are already installed by the session queue. */
  installed?: boolean;
};

export function buildCarrierMessage(
  sourceKey: string,
  inputId: string,
  contribution: { id: string; text: string },
  continuationHint: boolean,
): CustomMessage {
  return {
    role: "custom",
    customType: TURN_CONTEXT_CUSTOM_TYPE,
    content: continuationHint
      ? `${contribution.text}\n\n[Host] Related material for the current request arrived after the previous answer. Review it and, only if it changes or completes that answer, send a brief follow-up correction or addition. Do not repeat completed actions or restate an already-complete answer.`
      : contribution.text,
    display: false,
    details: {
      source: "openclaw.turn-context",
      pluginKey: sourceKey,
      inputId,
      contributionId: contribution.id,
    },
    timestamp: Date.now(),
  };
}

function carrierKey(message: CustomMessage): string | undefined {
  const details = isRecord(message.details) ? message.details : undefined;
  return details?.source === "openclaw.turn-context" &&
    details.inputId &&
    details.pluginKey &&
    details.contributionId
    ? JSON.stringify([details.inputId, details.pluginKey, details.contributionId])
    : undefined;
}

/** Only a recorded provider submission permits a persisted carrier to replay. */
export function retainSubmittedBackgroundContext(messages: AgentMessage[]): AgentMessage[] {
  const submitted = new Set(
    messages.flatMap((message) => {
      if (message.role !== "custom" || message.customType !== RECEIPT_CUSTOM_TYPE) {
        return [];
      }
      const key = carrierKey(message);
      return key ? [key] : [];
    }),
  );
  return messages.filter((message) => {
    if (message.role !== "custom") {
      return true;
    }
    if (message.customType === RECEIPT_CUSTOM_TYPE) {
      return false;
    }
    if (message.customType !== TURN_CONTEXT_CUSTOM_TYPE) {
      return true;
    }
    const key = carrierKey(message);
    return key !== undefined && submitted.has(key);
  });
}

/** Whole-message admission uses the same request estimator, including its margin. */
export function admitBackgroundContextCarriers(params: {
  carriers: readonly BackgroundContextCarrier[];
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  tokenBudget: number;
  contributionBudget: number;
}): { admitted: BackgroundContextCarrier[]; rejected: BackgroundContextCarrier[]; tokens: number } {
  const estimate = createFreshLlmBoundaryTokenEstimator(params);
  const messages = [...params.messages];
  let pressure = estimate({ messages, prompt: "" });
  let tokens = 0;
  const admitted: BackgroundContextCarrier[] = [];
  const rejected: BackgroundContextCarrier[] = [];
  for (const carrier of params.carriers) {
    const projected = {
      role: "user" as const,
      content: carrier.message.content,
      timestamp: carrier.message.timestamp,
    };
    messages.push(projected);
    const next = estimate({ messages, prompt: "" });
    const cost = next - pressure;
    if (next <= params.tokenBudget && tokens + cost <= params.contributionBudget) {
      admitted.push(carrier);
      tokens += cost;
      pressure = next;
    } else {
      messages.pop();
      rejected.push(carrier);
    }
  }
  return { admitted, rejected, tokens };
}

type ContextSession = {
  [agentSessionQueuePromptContext]: (
    message: CustomMessage,
    options: { delivery: "current-request" },
  ) => Promise<void>;
};

/** Delivers one carrier through the session's follow-up queue for the same turn. */
export function sendBackgroundContextFollowUp(
  activeSession: {
    sendCustomMessage(
      message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): Promise<void>;
  },
  message: CustomMessage,
): Promise<void> {
  return activeSession.sendCustomMessage(
    {
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    },
    { deliverAs: "followUp" },
  );
}

/** Installation records evidence without granting replay; submission owns that fact. */
export async function installBackgroundContextCarriers(params: {
  activeSession: ContextSession;
  carriers: readonly BackgroundContextCarrier[];
  assertCurrent: () => void;
}): Promise<void> {
  for (const carrier of params.carriers) {
    params.assertCurrent();
    if (!carrier.installed) {
      await params.activeSession[agentSessionQueuePromptContext](carrier.message, {
        delivery: "current-request",
      });
    }
    params.assertCurrent();
  }
}

export async function recordBackgroundContextSubmission(params: {
  activeSession: ContextSession;
  carriers: readonly BackgroundContextCarrier[];
}): Promise<CustomMessage[]> {
  const receipts: CustomMessage[] = [];
  for (const carrier of params.carriers) {
    const receipt: CustomMessage = {
      role: "custom",
      customType: RECEIPT_CUSTOM_TYPE,
      content: "",
      display: false,
      details: carrier.message.details,
      timestamp: Date.now(),
    };
    receipts.push(receipt);
    await params.activeSession[agentSessionQueuePromptContext](receipt, {
      delivery: "current-request",
    });
  }
  return receipts;
}
