import {
  releaseDeviceScopeLease,
  type DeviceScopeRegistry,
} from "../../gateway/server-methods/session-device-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
/**
 * Turn-end device lease release.
 *
 * A node occupancy lease has no TTL, so a turn that used a device must hand it
 * back when it ends; otherwise every other session sees DEVICE_OCCUPIED until
 * the node restarts. Release is best effort: a disconnected node clears its own
 * occupancy, and a failed release is recorded as a warning instead of failing
 * the turn.
 */
import { logWarn } from "../../logger.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

/**
 * Release the mirrored device lease for one root session. Returns true when a
 * mirror was dropped; false when the turn held no lease or the Gateway is not
 * this process's owner.
 */
export async function releaseTurnDeviceScopeLease(params: {
  rootSessionKey: string;
  /** Registry captured when the lease was used; turn end may be past tool context. */
  registry?: DeviceScopeRegistry;
  deviceId?: string;
  leaseToken?: string;
}): Promise<boolean> {
  const registry = params.registry ?? getInProcessGatewayToolContext()?.nodeRegistry;
  if (!registry) {
    return false;
  }
  try {
    return await releaseDeviceScopeLease({
      registry,
      rootSessionKey: params.rootSessionKey,
      ...(params.deviceId ? { deviceId: params.deviceId } : {}),
      ...(params.leaseToken ? { leaseToken: params.leaseToken } : {}),
    });
  } catch (error) {
    // Release failure must stay visible without blocking the settled turn.
    logWarn(
      `device scope: turn-end lease release failed session=${params.rootSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}
