import { expect, it } from "vitest";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { resolveCreatingClientScopeDeviceId } from "./session-create-device-scope.js";

const paired = (deviceId: string, clientId?: string): PairedDevice => ({
  deviceId,
  publicKey: `key-${deviceId}`,
  clientId,
  createdAtMs: 1,
  approvedAtMs: 1,
});

const listPairedDevices = async () => ({
  paired: [
    paired("device-a", "client-a"),
    paired("device-b", "client-b"),
    paired("device-unbound"),
  ],
});

it("scopes a session to the verified paired device of a device-token client", async () => {
  await expect(
    resolveCreatingClientScopeDeviceId(
      { isDeviceTokenAuth: true, pairedClientId: "client-a" },
      { listPairedDevices },
    ),
  ).resolves.toBe("device-a");
});

it("keeps every other client gateway-scoped rather than guessing from wire identity", async () => {
  const deps = { listPairedDevices };
  // Shared-secret and local clients carry no verified device.
  await expect(resolveCreatingClientScopeDeviceId(null, deps)).resolves.toBeUndefined();
  await expect(
    resolveCreatingClientScopeDeviceId(
      { isDeviceTokenAuth: false, pairedClientId: "client-a" },
      deps,
    ),
  ).resolves.toBeUndefined();
  // A client id that no longer resolves to a paired device grants no scope.
  await expect(
    resolveCreatingClientScopeDeviceId(
      { isDeviceTokenAuth: true, pairedClientId: "client-revoked" },
      deps,
    ),
  ).resolves.toBeUndefined();
  await expect(
    resolveCreatingClientScopeDeviceId({ isDeviceTokenAuth: true }, deps),
  ).resolves.toBeUndefined();
});

it("fails open to gateway scope when the pairing store cannot be read", async () => {
  await expect(
    resolveCreatingClientScopeDeviceId(
      { isDeviceTokenAuth: true, pairedClientId: "client-a" },
      {
        listPairedDevices: async () => {
          throw new Error("store unavailable");
        },
      },
    ),
  ).resolves.toBeUndefined();
});
