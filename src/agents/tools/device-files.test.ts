import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));

const { listDeviceDirectory, readDeviceFile, writeDeviceFile } = await import("./device-files.js");

const base = {
  deviceId: "device-a",
  rootSessionKey: "agent:main:root",
  leaseToken: "lease-1",
};

beforeEach(() => {
  callGatewayTool.mockReset();
});

describe("device file adapters", () => {
  it("reads through file.fetch with the lease token on every call", async () => {
    callGatewayTool.mockResolvedValue({
      payload: {
        ok: true,
        path: "/ws/notes.txt",
        size: 5,
        mimeType: "text/plain",
        base64: Buffer.from("hello").toString("base64"),
      },
    });
    const result = await readDeviceFile({ ...base, params: { path: "notes.txt" } });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        nodeId: "device-a",
        command: "file.fetch",
        sessionKey: "agent:main:root",
        params: expect.objectContaining({ path: "notes.txt", leaseToken: "lease-1" }),
      }),
      undefined,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("hello") });
    expect(result.details).toMatchObject({ path: "/ws/notes.txt", size: 5 });
  });

  it("lists a device directory without mixing in the gateway filesystem", async () => {
    callGatewayTool.mockResolvedValue({
      payload: {
        ok: true,
        path: "/ws",
        entries: [
          { name: "src", isDir: true },
          { name: "a.txt", isDir: false, size: 3 },
        ],
        truncated: false,
      },
    });
    const result = await listDeviceDirectory({ ...base, params: { path: "/ws" } });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 60_000 },
      expect.objectContaining({
        command: "dir.list",
        params: expect.objectContaining({ path: "/ws", leaseToken: "lease-1" }),
      }),
      undefined,
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("dir  src"),
    });
  });

  it("writes through file.write with a sender-computed integrity hash", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { ok: true, path: "/ws/out.txt", size: 5, sha256: "abc", overwritten: false },
    });
    const result = await writeDeviceFile({
      ...base,
      params: { path: "/ws/out.txt", content: "hello" },
    });
    const invoke = callGatewayTool.mock.calls[0]![2] as {
      command: string;
      params: Record<string, unknown>;
    };
    expect(invoke.command).toBe("file.write");
    expect(invoke.params).toMatchObject({
      path: "/ws/out.txt",
      contentBase64: Buffer.from("hello").toString("base64"),
      overwrite: true,
      createParents: true,
      leaseToken: "lease-1",
    });
    expect(String(invoke.params.expectedSha256)).toHaveLength(64);
    expect(result.details).toMatchObject({ path: "/ws/out.txt", size: 5 });
  });

  it("surfaces a node policy denial instead of a partial result", async () => {
    callGatewayTool.mockResolvedValue({
      payload: { ok: false, code: "PATH_DENIED", message: "path denied by node policy" },
    });
    await expect(readDeviceFile({ ...base, params: { path: "/etc/passwd" } })).rejects.toThrow(
      /PATH_DENIED\): path denied by node policy/,
    );
  });
});
