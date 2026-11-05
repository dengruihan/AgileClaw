import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));

const { runDeviceExec } = await import("./device-exec.js");

const base = {
  deviceId: "device-a",
  rootSessionKey: "agent:main:root",
  leaseToken: "lease-1",
  agentId: "main",
  runId: "run-1",
};

beforeEach(() => {
  callGatewayTool.mockReset();
});

describe("runDeviceExec", () => {
  it("dispatches system.run with the root session envelope and lease token", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "darwin\n", stderr: "" },
    });
    const result = await runDeviceExec({
      ...base,
      platform: "darwin",
      params: { command: "uname -s", workdir: "/tmp/ws" },
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: expect.any(Number) },
      expect.objectContaining({
        nodeId: "device-a",
        command: "system.run",
        sessionKey: "agent:main:root",
        params: expect.objectContaining({
          command: ["/bin/sh", "-c", "uname -s"],
          rawCommand: "uname -s",
          cwd: "/tmp/ws",
          sessionKey: "agent:main:root",
          agentId: "main",
          runId: "run-1",
          leaseToken: "lease-1",
        }),
      }),
      undefined,
    );
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, nodeId: "device-a" });
  });

  it("reports a failed exit without pretending success", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { success: false, exitCode: 2, stdout: "", stderr: "boom" },
    });
    const result = await runDeviceExec({ ...base, params: { command: "false" } });
    expect(result.details).toMatchObject({ status: "failed", exitCode: 2 });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("boom") });
  });

  it("rejects background, PTY, elevated, and host overrides instead of escaping the lease", async () => {
    await expect(
      runDeviceExec({ ...base, params: { command: "sleep 1 &", background: true } }),
    ).rejects.toThrow(/foreground/);
    await expect(runDeviceExec({ ...base, params: { command: "top", pty: true } })).rejects.toThrow(
      /PTY/,
    );
    await expect(
      runDeviceExec({ ...base, params: { command: "sudo ls", elevated: true } }),
    ).rejects.toThrow(/elevate/);
    await expect(
      runDeviceExec({ ...base, params: { command: "uname", host: "gateway" } }),
    ).rejects.toThrow(/host override/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects a per-call node that is not the scoped device", async () => {
    await expect(
      runDeviceExec({ ...base, params: { command: "uname", node: "device-b" } }),
    ).rejects.toThrow(/scoped to device device-a/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("bounds large output instead of dropping the result", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "x".repeat(200_000), stderr: "" },
    });
    const result = await runDeviceExec({ ...base, params: { command: "cat big" } });
    expect(result.details).toMatchObject({ truncated: true });
    expect((result.details as { aggregated: string }).aggregated.length).toBeLessThan(200_000);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("output truncated") });
  });
});
