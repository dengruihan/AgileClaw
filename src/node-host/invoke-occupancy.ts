/** Occupancy lifecycle command handlers; the node host is the lease authority. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  NODE_OCCUPANCY_ACQUIRE_COMMAND,
  NODE_OCCUPANCY_RELEASE_COMMAND,
  NODE_OCCUPANCY_RENEW_COMMAND,
  NODE_OCCUPANCY_REVOKE_COMMAND,
  NODE_OCCUPANCY_STATUS_COMMAND,
} from "../infra/node-commands.js";
import type { NodeInvokeResponder } from "./client.js";
import { decodeNodeInvokeParams } from "./invoke-payload.js";
import type { NodeOccupancyOwner, NodeOccupancyRejection } from "./node-occupancy.js";

function requireString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`INVALID_REQUEST: occupancy ${label} is required`);
  }
  return normalized;
}

/**
 * Resolve the calling session. The invoke envelope is authoritative: a claimed
 * `sessionKey` must match it, so one session can never act as another. Without
 * an envelope the invoke is an operator call and may name a session in params.
 */
function resolveCallerSessionKey(
  envelopeSessionKey: string | undefined,
  claimedSessionKey: unknown,
): string | undefined {
  const envelope = normalizeOptionalString(envelopeSessionKey);
  const claimed = normalizeOptionalString(claimedSessionKey);
  if (envelope && claimed && envelope !== claimed) {
    throw new Error("INVALID_REQUEST: occupancy sessionKey does not match the invoking session");
  }
  return envelope ?? claimed;
}

function requireCallerSessionKey(
  envelopeSessionKey: string | undefined,
  claimedSessionKey: unknown,
  command: string,
): string {
  const sessionKey = resolveCallerSessionKey(envelopeSessionKey, claimedSessionKey);
  if (!sessionKey) {
    throw new Error(`INVALID_REQUEST: ${command} requires the invoking session key`);
  }
  return sessionKey;
}

export async function handleOccupancyInvoke(params: {
  command: string;
  paramsJSON?: string | null;
  /** Session dispatching this invoke; absent on operator/admin invokes. */
  sessionKey?: string;
  occupancy: NodeOccupancyOwner;
  response: NodeInvokeResponder;
}): Promise<void> {
  const { command, occupancy, response } = params;
  const decode = (): Record<string, unknown> =>
    decodeNodeInvokeParams(params.paramsJSON ?? "{}") as Record<string, unknown>;
  try {
    switch (command) {
      case NODE_OCCUPANCY_ACQUIRE_COMMAND: {
        const raw = decode();
        const result = occupancy.acquire({
          sessionKey: requireCallerSessionKey(params.sessionKey, raw.sessionKey, command),
          sessionId: requireString(raw.sessionId, "sessionId"),
          agentId: normalizeOptionalString(raw.agentId) ?? undefined,
          runId: requireString(raw.runId, "runId"),
          turnId: normalizeOptionalString(raw.turnId) ?? undefined,
          leaseToken: requireString(raw.leaseToken, "leaseToken"),
        });
        if (!result.ok) {
          await respondRejection(response, result);
          return;
        }
        await response.json(result);
        return;
      }
      case NODE_OCCUPANCY_RENEW_COMMAND: {
        const raw = decode();
        const result = occupancy.renew({
          sessionKey: requireCallerSessionKey(params.sessionKey, raw.sessionKey, command),
          leaseToken: requireString(raw.leaseToken, "leaseToken"),
        });
        if (!result.ok) {
          await respondRejection(response, result);
          return;
        }
        await response.json(result);
        return;
      }
      case NODE_OCCUPANCY_RELEASE_COMMAND: {
        const raw = decode();
        const result = occupancy.release({
          sessionKey: requireCallerSessionKey(params.sessionKey, raw.sessionKey, command),
          leaseToken: requireString(raw.leaseToken, "leaseToken"),
        });
        if (!result.ok) {
          await respondRejection(response, result);
          return;
        }
        await response.json(result);
        return;
      }
      case NODE_OCCUPANCY_STATUS_COMMAND: {
        // A session sees the holder identity only for its own lease; anyone may
        // learn whether the device is occupied.
        await response.json(occupancy.status(normalizeOptionalString(params.sessionKey)));
        return;
      }
      case NODE_OCCUPANCY_REVOKE_COMMAND: {
        const raw = params.paramsJSON ? decode() : {};
        // Naming a session turns this into a session call: the caller must be
        // the holder and present the current token. An invoke with no session
        // identity anywhere is the operator force-clear path.
        const callerSessionKey = resolveCallerSessionKey(params.sessionKey, raw.sessionKey);
        const result = await occupancy.revoke(
          callerSessionKey
            ? {
                sessionKey: callerSessionKey,
                leaseToken: requireString(raw.leaseToken, "leaseToken"),
              }
            : {},
        );
        if (!result.ok) {
          await respondRejection(response, result);
          return;
        }
        await response.json(result);
        return;
      }
      default:
        await response.error("UNAVAILABLE", "command not supported");
    }
  } catch (error) {
    await response.invalid(error);
  }
}

async function respondRejection(
  response: NodeInvokeResponder,
  rejection: NodeOccupancyRejection,
): Promise<void> {
  await response.error(rejection.code, rejection.message);
}
