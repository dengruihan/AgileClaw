import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { GatewayClient } from "./server-methods/types.js";

/**
 * Resolve the session device scope for a `sessions.create` caller.
 *
 * Only a client that authenticated through device-token auth carries a
 * server-verified pairing identity; its paired device becomes the created
 * session's scope. Everything else — shared-secret operators, Control UI,
 * local clients, unverified client ids — stays gateway-scoped (absent), and a
 * device that no longer resolves from the pairing store is never guessed from
 * wire-declared client identity.
 */
export async function resolveCreatingClientScopeDeviceId(
  client: Pick<GatewayClient, "isDeviceTokenAuth" | "pairedClientId"> | null | undefined,
  deps: {
    listPairedDevices?: () => Promise<{ paired: PairedDevice[] }>;
  } = {},
): Promise<string | undefined> {
  const pairedClientId = normalizeOptionalString(client?.pairedClientId);
  if (client?.isDeviceTokenAuth !== true || !pairedClientId) {
    return undefined;
  }
  const listPairedDevices =
    deps.listPairedDevices ??
    (async () => {
      const { listDevicePairingReadOnly } = await import("../infra/device-pairing.js");
      return listDevicePairingReadOnly();
    });
  try {
    const { paired } = await listPairedDevices();
    return paired.find((device) => device.clientId === pairedClientId)?.deviceId;
  } catch {
    // A pairing store that cannot be read grants no scope; the session stays
    // gateway-scoped rather than failing creation over a diagnostic lookup.
    return undefined;
  }
}
