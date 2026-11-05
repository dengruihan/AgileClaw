import { expect, it } from "vitest";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveCreatingClientScopeDeviceId } from "./session-create-device-scope.js";

const paired = (deviceId: string, clientId?: string): PairedDevice => ({
  deviceId,
  publicKey: `key-${deviceId}`,
  clientId,
  createdAtMs: 1,
  approvedAtMs: 1,
});

// The handshake-verified device identity lives on the connect frame, as it does
// for every real device-token connection; `pairedClientId` is browser-copilot only.
const deviceTokenClient = (deviceId: string | undefined, clientId = "openclaw-ios") =>
  ({
    isDeviceTokenAuth: true,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      client: { id: clientId, version: "test", platform: "ios", mode: "node" },
      ...(deviceId
        ? {
            device: {
              id: deviceId,
              publicKey: `key-${deviceId}`,
              signature: "signature",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
  }) as GatewayClient;

const readPairedDevice =
  (pairedDevices: PairedDevice[]) =>
  async (deviceId: string): Promise<PairedDevice | null> =>
    pairedDevices.find((device) => device.deviceId === deviceId) ?? null;

it("scopes a session to the handshake-verified device of a device-token client", async () => {
  await expect(
    resolveCreatingClientScopeDeviceId(deviceTokenClient("device-a"), {
      getPairedDevice: readPairedDevice([paired("device-a", "openclaw-ios")]),
    }),
  ).resolves.toBe("device-a");

  // Several paired devices may share the same app client id; the verified device
  // id still selects exactly one of them.
  await expect(
    resolveCreatingClientScopeDeviceId(deviceTokenClient("device-b", "openclaw-ios"), {
      getPairedDevice: readPairedDevice([
        paired("device-a", "openclaw-ios"),
        paired("device-b", "openclaw-ios"),
      ]),
    }),
  ).resolves.toBe("device-b");
});

it("keeps every client without a verified device gateway-scoped", async () => {
  const deps = { getPairedDevice: readPairedDevice([paired("device-a", "openclaw-ios")]) };
  // Shared-secret, local, and Control UI clients carry no verified device.
  expect(
    await resolveCreatingClientScopeDeviceId(
      { ...deviceTokenClient("device-a"), isDeviceTokenAuth: false },
      deps,
    ),
  ).toBeUndefined();
  await expect(resolveCreatingClientScopeDeviceId(null, deps)).resolves.toBeUndefined();
  // A device-token frame without a device identity grants no scope.
  await expect(
    resolveCreatingClientScopeDeviceId(deviceTokenClient(undefined), deps),
  ).resolves.toBeUndefined();
  // A wire client id that no longer resolves to a paired device grants no scope.
  await expect(
    resolveCreatingClientScopeDeviceId(deviceTokenClient("device-retired"), deps),
  ).resolves.toBeUndefined();
});

it("fails open to gateway scope when the pairing store cannot be read", async () => {
  await expect(
    resolveCreatingClientScopeDeviceId(deviceTokenClient("device-a"), {
      getPairedDevice: async () => {
        throw new Error("store unavailable");
      },
    }),
  ).resolves.toBeUndefined();
});
