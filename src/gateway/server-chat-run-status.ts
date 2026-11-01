import { readModelRetryStatus } from "../../packages/gateway-protocol/src/chat-retry.js";
import type { AgentEventPayload } from "../infra/agent-events.js";

/** Adapts runner retry facts to chat status; the caller validates the complete wire event. */
export function projectAgentRunStatusToChat(data: AgentEventPayload["data"]) {
  const status = readModelRetryStatus(data.retry);
  const legacy =
    data.phase === "retrying" &&
    typeof data.reason === "string" &&
    typeof data.attempt === "number" &&
    Number.isInteger(data.attempt) &&
    data.attempt >= 1 &&
    data.attempt <= 10 &&
    typeof data.maxAttempts === "number" &&
    Number.isInteger(data.maxAttempts) &&
    data.maxAttempts >= 1 &&
    data.maxAttempts <= 10
      ? { attempt: data.attempt, maxAttempts: data.maxAttempts, reason: data.reason }
      : undefined;
  return {
    phase: data.phase === "retrying" ? "starting_model" : data.phase,
    ...(status || legacy ? { retry: { ...legacy, ...(status ? { status } : {}) } } : {}),
  };
}
