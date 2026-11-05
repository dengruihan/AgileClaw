import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { GatewayClient } from "./server-methods/types.js";

/**
 * Resolve the session device scope for a `sessions.create` caller.
 *
 * Only device-token auth carries a device identity the handshake verified
 * (`connect.device.id` against the paired record's public key). That id names the
 * physical device, unlike wire client ids, which name an app and can match several
 * paired devices. Everything else — shared-secret operators, Control UI, local
 * clients, wire-declared ids — stays gateway-scoped, and the pairing row is
 * rechecked so a device retired after the handshake grants no scope.
 */
export async function resolveCreatingClientScopeDeviceId(
  client: Pick<GatewayClient, "isDeviceTokenAuth" | "connect"> | null | undefined,
  deps: {
    getPairedDevice?: (deviceId: string) => Promise<PairedDevice | null>;
  } = {},
): Promise<string | undefined> {
  const deviceId = normalizeOptionalString(client?.connect?.device?.id);
  if (client?.isDeviceTokenAuth !== true || !deviceId) {
    return undefined;
  }
  const readPairedDevice =
    deps.getPairedDevice ??
    (async (id: string) => {
      const { getPairedDevice } = await import("../infra/device-pairing.js");
      return getPairedDevice(id);
    });
  try {
    const paired = await readPairedDevice(deviceId);
    return paired?.deviceId === deviceId ? deviceId : undefined;
  } catch {
    // A pairing store that cannot be read grants no scope; the session stays
    // gateway-scoped rather than failing creation over a diagnostic lookup.
    return undefined;
  }
}
