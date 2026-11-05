import { describe, expect, test } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import type { GatewayClient } from "./types.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

// The real connection shape for a device-token client: the verified identity is
// the connect frame's device, never the app client id.
function deviceTokenClient(deviceId: string): GatewayClient {
  return {
    connId: "conn-device-create",
    isDeviceTokenAuth: true,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      client: { id: "openclaw-ios", version: "test", platform: "ios", mode: "node" },
      device: {
        id: deviceId,
        publicKey: `pk-${deviceId}`,
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    },
  } as GatewayClient;
}

async function pairDevice(deviceId: string): Promise<void> {
  const requested = await requestDevicePairing({
    deviceId,
    publicKey: `pk-${deviceId}`,
    clientId: "openclaw-ios",
    clientMode: "node",
    platform: "ios",
    role: "operator",
    roles: ["operator"],
    scopes: [],
  });
  const approved = await approveDevicePairing(requested.request.requestId, { callerScopes: [] });
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${deviceId}`);
  }
}

describe("sessions.create device scope", () => {
  test("stamps the paired device of a device-token client on the created row", async () => {
    const { storePath } = await createSessionStoreDir();
    await pairDevice("device-ios-create");
    const sessionKey = "agent:main:dashboard:device-scoped-create";

    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey },
      {
        client: deviceTokenClient("device-ios-create"),
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.scopeDeviceId).toBe(
      "device-ios-create",
    );
  });

  test("keeps a create gateway-scoped when the verified device no longer resolves", async () => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:unpaired-device-create";

    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey },
      {
        client: deviceTokenClient("device-not-paired"),
      },
    );

    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey, storePath })?.scopeDeviceId,
    ).toBeUndefined();
  });
});
