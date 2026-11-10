// CLI-owned read-only saved-pairing report.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHostGatewayConfig } from "../../node-host/config.js";

const mocks = vi.hoisted(() => ({
  loadResumableNodeHostGateway: vi.fn<() => Promise<NodeHostGatewayConfig | undefined>>(
    async () => undefined,
  ),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  },
}));

vi.mock("../../node-host/resumable-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-host/resumable-gateway.js")>()),
  loadResumableNodeHostGateway: mocks.loadResumableNodeHostGateway,
}));

// mock-isolation: capture this command's JSON/log output without the process-global runtime.
vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: mocks.runtime.writeJson,
}));

const { runNodePairingStatus } = await import("./pairing.js");

const gateway = { host: "gateway.example", port: 443, tls: true };

describe("runNodePairingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadResumableNodeHostGateway.mockResolvedValue(undefined);
  });

  it("reports a resumable saved pairing as JSON", async () => {
    mocks.loadResumableNodeHostGateway.mockResolvedValueOnce(gateway);
    await runNodePairingStatus({ json: true });
    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0]?.[1]).toEqual({ resumable: true });
  });

  it("reports no saved pairing as JSON", async () => {
    await runNodePairingStatus({ json: true });
    expect(mocks.runtime.writeJson.mock.calls[0]?.[1]).toEqual({ resumable: false });
  });

  it("reports resume readiness without presenting a command", async () => {
    mocks.loadResumableNodeHostGateway.mockResolvedValueOnce(gateway);
    await runNodePairingStatus();
    expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining("can reconnect"));
    expect(JSON.stringify(mocks.runtime.log.mock.calls)).not.toContain("openclaw ");
  });

  it("keeps a failed read unknown instead of reporting unpaired", async () => {
    mocks.loadResumableNodeHostGateway.mockRejectedValueOnce(new Error("state unavailable"));
    await expect(runNodePairingStatus({ json: true })).rejects.toThrow(
      "Node pairing check failed: state unavailable",
    );
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();

    mocks.loadResumableNodeHostGateway.mockRejectedValueOnce(new Error("state unavailable"));
    await runNodePairingStatus();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Node pairing check failed: state unavailable",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runtime.log).not.toHaveBeenCalled();
  });
});
