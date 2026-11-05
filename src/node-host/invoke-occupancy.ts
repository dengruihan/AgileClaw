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
          sessionKey: requireString(raw.sessionKey, "sessionKey"),
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
          sessionKey: requireString(raw.sessionKey, "sessionKey"),
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
          sessionKey: requireString(raw.sessionKey, "sessionKey"),
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
        await response.json(occupancy.status());
        return;
      }
      case NODE_OCCUPANCY_REVOKE_COMMAND: {
        const raw = params.paramsJSON ? decode() : {};
        // A dispatching session may only revoke its own lease, and must present
        // the current token; operator invokes carry no session identity.
        const callerSessionKey = normalizeOptionalString(params.sessionKey) ?? undefined;
        const result = await occupancy.revoke({
          sessionKey: callerSessionKey ?? normalizeOptionalString(raw.sessionKey) ?? undefined,
          ...(callerSessionKey ? { leaseToken: requireString(raw.leaseToken, "leaseToken") } : {}),
        });
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
