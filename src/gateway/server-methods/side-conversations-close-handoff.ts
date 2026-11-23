import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
/**
 * Close-side handoff recording.
 *
 * The close state and its next-message reminder are two durable writes. When the
 * state commit succeeded but the reminder could not be recorded, close reports an
 * explicit retryable partial result instead of claiming success with no
 * reminder, and a repeated close repairs the missing reminder.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureClosedSideConversationHandoff } from "../../sessions/side-conversation-handoff.js";

/** Closed state is durable; only the reminder is missing and retryable. */
export function closeHandoffPendingError(sessionKey: string, detail?: string): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Side conversation ${sessionKey} is closed, but its handoff reminder was not recorded${detail ? ` (${detail})` : ""}. Retry close to record it.`,
    {
      retryable: true,
      details: { sessionKey, state: "closed", handoffRecorded: false },
    },
  );
}

export async function repairCloseHandoff(params: {
  cfg: OpenClawConfig;
  agentId: string;
  child: InternalSessionEntry;
  childSessionKey: string;
  now: number;
  parentEntry: InternalSessionEntry;
  parentSessionKey: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ error?: ErrorShape }> {
  try {
    const ensured = await ensureClosedSideConversationHandoff({
      cfg: params.cfg,
      agentId: params.agentId,
      child: params.child,
      childSessionKey: params.childSessionKey,
      now: params.now,
      parentEntry: params.parentEntry,
      parentSessionKey: params.parentSessionKey,
      storePath: params.storePath,
    });
    if (ensured.status === "missing-parent") {
      return { error: closeHandoffPendingError(params.sessionKey) };
    }
    return {};
  } catch (error) {
    return {
      error: closeHandoffPendingError(params.sessionKey, formatErrorMessage(error)),
    };
  }
}
