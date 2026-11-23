/**
 * Reopen-side handoff cancellation.
 *
 * Reopen must withdraw a still-pending next-message reminder before it can be
 * delivered. The open state is already durable when this runs, so a failure
 * stays retryable through another reopen instead of surfacing as a state error.
 */
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cancelPendingSideConversationHandoffs } from "../../sessions/side-conversation-handoff.js";

export async function cancelReopenHandoff(params: {
  agentId: string;
  intentId: string;
  parentSessionKey: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ error?: ErrorShape }> {
  try {
    await cancelPendingSideConversationHandoffs({
      agentId: params.agentId,
      intentId: params.intentId,
      parentSessionKey: params.parentSessionKey,
      storePath: params.storePath,
    });
    return {};
  } catch (error) {
    return {
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        `Side conversation ${params.sessionKey} reopened, but its pending handoff reminder could not be cancelled: ${formatErrorMessage(error)} Retry the reopen.`,
        { retryable: true },
      ),
    };
  }
}
