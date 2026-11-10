// Read-only canonical pairing check: saved Gateway + device identity + reusable node token.
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { loadNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { formatGatewayCandidateUrl } from "./gateway-candidate-url.js";

/**
 * Whether one saved node credential can authenticate every candidate without
 * a setup code. Read-only: never reads or prints the token itself.
 */
export async function canReuseNodeHostDeviceToken(params: {
  savedGateway?: NodeHostGatewayConfig;
  gatewayCandidates: readonly NodeHostGatewayConfig[];
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const savedGatewayScope = params.savedGateway
    ? gatewayOriginScope(formatGatewayCandidateUrl(params.savedGateway))
    : undefined;
  return Boolean(
    savedGatewayScope &&
    params.gatewayCandidates.every(
      (candidate) => gatewayOriginScope(formatGatewayCandidateUrl(candidate)) === savedGatewayScope,
    ) &&
    (
      await loadDeviceAuthTokenReadOnly({
        deviceId: params.deviceId,
        role: "node",
        env: params.env ?? process.env,
      })
    )?.token,
  );
}

/**
 * The saved Gateway endpoint when a node credential exists to reconnect without a setup code.
 * Node tokens are not bound to an endpoint, so callers must present the reconnect as conditional.
 */
export async function loadResumableNodeHostGateway(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostGatewayConfig | undefined> {
  // A failed first enrollment saves the endpoint before any device token exists.
  const gateway = (await loadNodeHostConfig(env))?.gateway;
  const identity = gateway ? loadDeviceIdentityIfPresent({ env }) : null;
  return gateway &&
    identity &&
    (await canReuseNodeHostDeviceToken({
      savedGateway: gateway,
      gatewayCandidates: [gateway],
      deviceId: identity.deviceId,
      env,
    }))
    ? gateway
    : undefined;
}
