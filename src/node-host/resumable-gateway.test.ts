// Saved-pairing resume requires the canonical endpoint, identity, and node token.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import type { NodeHostConfig } from "./config.js";

const mocks = vi.hoisted(() => ({
  loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
  loadDeviceIdentityIfPresent: vi.fn(
    () => null as { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null,
  ),
  loadDeviceAuthTokenReadOnly: vi.fn<typeof loadDeviceAuthTokenReadOnly>(async () => null),
}));

// mock-isolation: the canonical SQLite reader has its own owner tests; this file checks how the three saved facts combine.
vi.mock("./config.js", () => ({ loadNodeHostConfig: mocks.loadNodeHostConfig }));
// mock-isolation: no real device key may be created by a resume-read test.
vi.mock("../infra/device-identity.js", () => ({
  loadDeviceIdentityIfPresent: mocks.loadDeviceIdentityIfPresent,
}));
// mock-isolation: token reads stay off the shared-state worker store; the store owner has separate tests.
vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthTokenReadOnly: mocks.loadDeviceAuthTokenReadOnly,
}));

const { loadResumableNodeHostGateway } = await import("./resumable-gateway.js");

const gateway = { host: "gateway.example", port: 443, tls: true };
const identity = {
  deviceId: "device-fixture",
  publicKeyPem: "public-key-fixture",
  privateKeyPem: "private-key-fixture",
};

describe("loadResumableNodeHostGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadNodeHostConfig.mockResolvedValue({ version: 1, nodeId: "node-fixture", gateway });
    mocks.loadDeviceIdentityIfPresent.mockReturnValue(identity);
    mocks.loadDeviceAuthTokenReadOnly.mockResolvedValue({
      role: "node",
      token: "fixture-node-token",
      scopes: [],
      updatedAtMs: 1,
    });
  });

  it("offers the saved endpoint only when a reusable node token exists", async () => {
    await expect(loadResumableNodeHostGateway()).resolves.toEqual(gateway);
    expect(mocks.loadDeviceAuthTokenReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: identity.deviceId, role: "node" }),
    );

    // A failed first enrollment saves the endpoint before identity or token exists.
    mocks.loadDeviceAuthTokenReadOnly.mockClear();
    mocks.loadDeviceIdentityIfPresent.mockReturnValue(null);
    await expect(loadResumableNodeHostGateway()).resolves.toBeUndefined();
    expect(mocks.loadDeviceAuthTokenReadOnly).not.toHaveBeenCalled();

    mocks.loadDeviceIdentityIfPresent.mockReturnValue(identity);
    mocks.loadDeviceAuthTokenReadOnly.mockResolvedValue(null);
    await expect(loadResumableNodeHostGateway()).resolves.toBeUndefined();
  });

  it("does not claim resume readiness without a saved endpoint", async () => {
    mocks.loadNodeHostConfig.mockResolvedValue(null);
    await expect(loadResumableNodeHostGateway()).resolves.toBeUndefined();
    expect(mocks.loadDeviceAuthTokenReadOnly).not.toHaveBeenCalled();
  });
});
