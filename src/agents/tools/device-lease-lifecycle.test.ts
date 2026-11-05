import { afterEach, describe, expect, it, vi } from "vitest";

const releaseDeviceScopeLease = vi.fn();
const gatewayContext = vi.fn();

vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  releaseDeviceScopeLease: (...args: unknown[]) => releaseDeviceScopeLease(...args),
}));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));

const { releaseTurnDeviceScopeLease } = await import("./device-lease-lifecycle.js");

afterEach(() => {
  releaseDeviceScopeLease.mockReset();
  gatewayContext.mockReset();
});

describe("releaseTurnDeviceScopeLease", () => {
  it("releases through the Gateway registry when the turn used a lease", async () => {
    const registry = { invoke: vi.fn() };
    gatewayContext.mockReturnValue({ nodeRegistry: registry });
    releaseDeviceScopeLease.mockResolvedValue(true);
    await expect(releaseTurnDeviceScopeLease({ rootSessionKey: "agent:main:root" })).resolves.toBe(
      true,
    );
    expect(releaseDeviceScopeLease).toHaveBeenCalledWith({
      registry,
      rootSessionKey: "agent:main:root",
    });
  });

  it("is a no-op outside the Gateway process", async () => {
    gatewayContext.mockReturnValue(undefined);
    await expect(releaseTurnDeviceScopeLease({ rootSessionKey: "agent:main:root" })).resolves.toBe(
      false,
    );
    expect(releaseDeviceScopeLease).not.toHaveBeenCalled();
  });

  it("records a failed release without failing the settled turn", async () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { invoke: vi.fn() } });
    releaseDeviceScopeLease.mockRejectedValue(new Error("node gone"));
    await expect(releaseTurnDeviceScopeLease({ rootSessionKey: "agent:main:root" })).resolves.toBe(
      false,
    );
  });
});
