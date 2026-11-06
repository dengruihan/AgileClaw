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
      expect.any(Object),
    );
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, nodeId: "device-a" });
    // The lease token is admission material; it never reaches model-visible output.
    expect(JSON.stringify(result)).not.toContain("lease-1");
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

  it("rejects per-call gateway overrides that would retarget the invoke", async () => {
    await expect(
      runDeviceExec({ ...base, params: { command: "uname", gatewayUrl: "ws://elsewhere" } }),
    ).rejects.toThrow(/gateway overrides/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});

describe("runDeviceExec streaming", () => {
  function captureStream() {
    let stream:
      | { onProgress: (chunk: string) => void; isRuntimeCurrent: () => boolean }
      | undefined;
    callGatewayTool.mockImplementation(
      async (_method: string, _opts: unknown, _invoke: unknown, extra: unknown) => {
        stream = (extra as { nodeInvokeStream?: typeof stream })?.nodeInvokeStream;
        return { payload: { success: true, exitCode: 0, stdout: "done", stderr: "" } };
      },
    );
    return () => stream;
  }

  it("opts into streamOutput and forwards bounded chunks to onUpdate", async () => {
    const getStream = captureStream();
    const updates: Array<{ text: string; status: string }> = [];
    const result = await runDeviceExec({
      ...base,
      params: { command: "build" },
      onUpdate: (update) => {
        const text = update.content[0];
        updates.push({
          text: text?.type === "text" ? text.text : "",
          status: (update.details as { status: string }).status,
        });
      },
    });
    const invoke = callGatewayTool.mock.calls[0]![2] as { params: Record<string, unknown> };
    expect(invoke.params.streamOutput).toBe(true);
    const stream = getStream();
    expect(stream).toBeDefined();
    stream!.onProgress("step 1\n");
    stream!.onProgress("step 2\n");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ text: "step 1\n", status: "running" });
    expect(updates[1]).toMatchObject({ text: "step 1\nstep 2\n", status: "running" });
    // The final result stays the single authoritative outcome.
    expect(result.details).toMatchObject({ status: "completed", aggregated: "done" });
  });

  it("keeps only a rolling tail and goes quiet after the stream budget", async () => {
    const getStream = captureStream();
    let updates = 0;
    let lastText = "";
    await runDeviceExec({
      ...base,
      params: { command: "flood" },
      onUpdate: (update) => {
        updates += 1;
        const text = update.content[0];
        lastText = text?.type === "text" ? text.text : "";
      },
    });
    const stream = getStream()!;
    stream.onProgress(`${"a".repeat(20 * 1024)}\n`);
    expect(updates).toBe(1);
    expect(lastText.length).toBeLessThanOrEqual(4 * 1024 + 1);
    // Once the total budget is spent, further chunks are dropped, not forwarded.
    stream.onProgress(`${"b".repeat(20 * 1024)}\n`);
    stream.onProgress("more");
    expect(updates).toBe(1);
    expect(stream.isRuntimeCurrent()).toBe(false);
  });

  it("ignores empty heartbeat chunks without emitting an update", async () => {
    const getStream = captureStream();
    let updates = 0;
    await runDeviceExec({
      ...base,
      params: { command: "silent" },
      onUpdate: () => {
        updates += 1;
      },
    });
    const stream = getStream()!;
    stream.onProgress("");
    expect(updates).toBe(0);
  });

  it("stops forwarding once the caller aborts", async () => {
    const getStream = captureStream();
    const controller = new AbortController();
    let updates = 0;
    await runDeviceExec({
      ...base,
      params: { command: "long" },
      signal: controller.signal,
      onUpdate: () => {
        updates += 1;
      },
    });
    const stream = getStream()!;
    controller.abort();
    stream.onProgress("late");
    expect(updates).toBe(0);
    expect(stream.isRuntimeCurrent()).toBe(false);
  });

  it("stays final-result-only when no onUpdate consumer exists", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "ok", stderr: "" },
    });
    await runDeviceExec({ ...base, params: { command: "uname" } });
    const invoke = callGatewayTool.mock.calls[0]![2] as { params: Record<string, unknown> };
    expect(invoke.params.streamOutput).toBeUndefined();
    expect(callGatewayTool.mock.calls[0]![3]).toEqual({});
  });
});
