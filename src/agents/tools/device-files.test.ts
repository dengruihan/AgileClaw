import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();
const planFileEdit = vi.fn();

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));
vi.mock("../sessions/tools/file-tool-planning.js", () => ({
  planFileEdit: (...args: unknown[]) => planFileEdit(...args),
}));

const { applyDevicePatch, editDeviceFile, listDeviceDirectory, readDeviceFile, writeDeviceFile } =
  await import("./device-files.js");

const base = {
  deviceId: "device-a",
  rootSessionKey: "agent:main:root",
  leaseToken: "lease-1",
};

function filePayload(overrides: Record<string, unknown> = {}) {
  return { payload: { ok: true, ...overrides } };
}

beforeEach(() => {
  callGatewayTool.mockReset();
  planFileEdit.mockReset();
});

describe("device file adapters", () => {
  it("reads through file.fetch with the lease token on every call", async () => {
    callGatewayTool.mockResolvedValue(
      filePayload({
        path: "/ws/notes.txt",
        size: 5,
        mimeType: "text/plain",
        base64: Buffer.from("hello").toString("base64"),
      }),
    );
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
    callGatewayTool.mockResolvedValue(
      filePayload({
        path: "/ws",
        entries: [
          { name: "src", isDir: true },
          { name: "a.txt", isDir: false, size: 3 },
        ],
        truncated: false,
      }),
    );
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
    callGatewayTool.mockResolvedValue(
      filePayload({ path: "/ws/out.txt", size: 5, sha256: "abc", overwritten: false }),
    );
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

describe("editDeviceFile", () => {
  const editHappyPath = {
    stat: filePayload({ path: "/ws/a.txt", type: "file", size: 11 }),
    fetch: filePayload({
      path: "/ws/a.txt",
      size: 11,
      mimeType: "text/plain",
      base64: Buffer.from("hello world").toString("base64"),
    }),
    write: filePayload({ path: "/ws/a.txt", size: 11, sha256: "x" }),
  };

  function mockEditSequence(
    overrides: {
      verify?: Record<string, unknown>;
      verifyStat?: Record<string, unknown>;
      fetch?: Record<string, unknown>;
      stat?: Record<string, unknown>;
    } = {},
  ) {
    let statCalls = 0;
    callGatewayTool.mockImplementation(async (_method: string, _opts: unknown, invoke: unknown) => {
      const command = (invoke as { command: string }).command;
      if (command === "file.stat") {
        statCalls += 1;
        const defaults =
          statCalls > 1
            ? // The post-write verification stat reports the persisted content.
              { path: "/ws/a.txt", type: "file", size: Buffer.byteLength("hello device") }
            : editHappyPath.stat.payload;
        return {
          payload: {
            ok: true,
            ...(statCalls > 1 ? (overrides.verifyStat ?? defaults) : (overrides.stat ?? defaults)),
          },
        };
      }
      if (command === "file.fetch") {
        return { payload: { ok: true, ...(overrides.fetch ?? editHappyPath.fetch.payload) } };
      }
      return { payload: { ok: true, ...(overrides.verify ?? editHappyPath.write.payload) } };
    });
  }

  it("applies planned replacements over stat/fetch/write with the canonical path pinned", async () => {
    mockEditSequence();
    planFileEdit.mockResolvedValue({
      changed: true,
      editCount: 1,
      content: "hello device",
      receipt: { diff: "- world\n+ device", patch: "*** Begin Patch", firstChangedLine: 1 },
    });
    const result = await editDeviceFile({
      ...base,
      params: { path: "/ws/a.txt", edits: [{ oldText: "world", newText: "device" }] },
    });
    expect(planFileEdit).toHaveBeenCalledWith(
      {
        path: "/ws/a.txt",
        content: "hello world",
        edits: [{ oldText: "world", newText: "device" }],
      },
      undefined,
    );
    const commands = callGatewayTool.mock.calls.map(
      (call) => (call[2] as { command: string }).command,
    );
    expect(commands).toEqual(["file.stat", "file.fetch", "file.write", "file.stat"]);
    const write = callGatewayTool.mock.calls[2]![2] as { params: Record<string, unknown> };
    expect(write.params).toMatchObject({
      path: "/ws/a.txt",
      overwrite: true,
      createParents: true,
      expectedCanonicalPath: "/ws/a.txt",
      leaseToken: "lease-1",
    });
    expect(write.params.contentBase64).toBe(Buffer.from("hello device").toString("base64"));
    expect(result.content[0]).toMatchObject({
      text: "Successfully replaced 1 block(s) in /ws/a.txt.",
    });
    expect(result.details).toMatchObject({ changed: true, diff: "- world\n+ device" });
  });

  it("returns the no-change plan without touching the device file", async () => {
    mockEditSequence();
    planFileEdit.mockResolvedValue({ changed: false, message: "no edits applied" });
    const result = await editDeviceFile({
      ...base,
      params: { path: "/ws/a.txt", edits: [{ oldText: "x", newText: "x" }] },
    });
    expect(result.content[0]).toMatchObject({ text: "no edits applied" });
    expect(result.details).toEqual({ changed: false });
    expect(
      callGatewayTool.mock.calls.some(
        (call) => (call[2] as { command: string }).command === "file.write",
      ),
    ).toBe(false);
  });

  it("appends the current device contents to a mismatch error for self-correction", async () => {
    mockEditSequence();
    planFileEdit.mockRejectedValue(
      new Error("Could not find the exact text in /ws/a.txt. The old text must match exactly."),
    );
    await expect(
      editDeviceFile({
        ...base,
        params: { path: "/ws/a.txt", edits: [{ oldText: "nope", newText: "x" }] },
      }),
    ).rejects.toThrow(/Current file contents:\nhello world/);
  });

  it("rejects a directory target before any content round trip", async () => {
    callGatewayTool.mockResolvedValue(filePayload({ path: "/ws", type: "directory", size: 0 }));
    await expect(
      editDeviceFile({ ...base, params: { path: "/ws", edits: [{ oldText: "a", newText: "b" }] } }),
    ).rejects.toThrow(/is a directory/);
    expect(
      callGatewayTool.mock.calls.some(
        (call) => (call[2] as { command: string }).command === "file.fetch",
      ),
    ).toBe(false);
  });

  it("fails verification when the persisted device file does not match the plan", async () => {
    mockEditSequence({ verifyStat: { path: "/ws/a.txt", type: "file", size: 99 } });
    planFileEdit.mockResolvedValue({
      changed: true,
      editCount: 1,
      content: "hello device",
      receipt: { diff: "", patch: "", firstChangedLine: 1 },
    });
    await expect(
      editDeviceFile({
        ...base,
        params: { path: "/ws/a.txt", edits: [{ oldText: "world", newText: "device" }] },
      }),
    ).rejects.toThrow(/Edit verification failed/);
  });

  it("refuses files larger than the device edit ceiling instead of truncating them", async () => {
    callGatewayTool.mockResolvedValue(
      filePayload({ path: "/ws/big.bin", type: "file", size: 17 * 1024 * 1024 }),
    );
    await expect(
      editDeviceFile({
        ...base,
        params: { path: "/ws/big.bin", edits: [{ oldText: "a", newText: "b" }] },
      }),
    ).rejects.toThrow(/device edit ceiling/);
  });
});

describe("applyDevicePatch", () => {
  const updatePatch = [
    "*** Begin Patch",
    "*** Update File: /ws/a.txt",
    "@@",
    "-world",
    "+device",
    "*** End Patch",
  ].join("\n");

  function mockUpdateSequence(overrides: { fetchText?: string } = {}) {
    const text = overrides.fetchText ?? "hello\nworld\n";
    callGatewayTool.mockImplementation(async (_method: string, _opts: unknown, invoke: unknown) => {
      const command = (invoke as { command: string }).command;
      if (command === "file.stat") {
        return filePayload({ path: "/ws/a.txt", type: "file", size: Buffer.byteLength(text) });
      }
      if (command === "file.fetch") {
        return filePayload({
          path: "/ws/a.txt",
          size: Buffer.byteLength(text),
          mimeType: "text/plain",
          base64: Buffer.from(text).toString("base64"),
        });
      }
      return filePayload({ path: "/ws/a.txt", size: 12, sha256: "y" });
    });
    return text;
  }

  it("applies Update File hunks through the shared patch owner and reports the summary", async () => {
    mockUpdateSequence();
    const result = await applyDevicePatch({ ...base, params: { input: updatePatch } });
    const commands = callGatewayTool.mock.calls.map(
      (call) => (call[2] as { command: string }).command,
    );
    expect(commands).toEqual(["file.stat", "file.fetch", "file.write"]);
    const write = callGatewayTool.mock.calls[2]![2] as { params: Record<string, unknown> };
    expect(write.params).toMatchObject({
      path: "/ws/a.txt",
      overwrite: true,
      expectedCanonicalPath: "/ws/a.txt",
      leaseToken: "lease-1",
    });
    expect(write.params.contentBase64).toBe(Buffer.from("hello\ndevice\n").toString("base64"));
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("M /ws/a.txt"),
    });
    expect(result.details).toMatchObject({
      summary: { added: [], modified: ["/ws/a.txt"], deleted: [] },
      deviceScope: "device-a",
    });
  });

  it("creates Add File hunks with an exclusive device write", async () => {
    callGatewayTool.mockResolvedValue(filePayload({ path: "/ws/new.txt", size: 6 }));
    const result = await applyDevicePatch({
      ...base,
      params: {
        input: ["*** Begin Patch", "*** Add File: /ws/new.txt", "+hello", "*** End Patch"].join(
          "\n",
        ),
      },
    });
    const invoke = callGatewayTool.mock.calls[0]![2] as { params: Record<string, unknown> };
    expect(invoke.params).toMatchObject({
      path: "/ws/new.txt",
      overwrite: false,
      createParents: true,
      leaseToken: "lease-1",
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("A /ws/new.txt") });
  });

  it("reports an existing Add File target with the Update File hint", async () => {
    callGatewayTool.mockResolvedValue({
      payload: {
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "filesystem identity differs from the authorized target",
      },
    });
    await expect(
      applyDevicePatch({
        ...base,
        params: {
          input: ["*** Begin Patch", "*** Add File: /ws/there.txt", "+x", "*** End Patch"].join(
            "\n",
          ),
        },
      }),
    ).rejects.toThrow(/the file already exists\./);
  });

  it("rejects Delete File hunks per call without touching the device", async () => {
    await expect(
      applyDevicePatch({
        ...base,
        params: {
          input: ["*** Begin Patch", "*** Delete File: /ws/a.txt", "*** End Patch"].join("\n"),
        },
      }),
    ).rejects.toThrow(/cannot delete '\/ws\/a\.txt'/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects Move to hunks per call with a clear reason", async () => {
    mockUpdateSequence();
    await expect(
      applyDevicePatch({
        ...base,
        params: {
          input: [
            "*** Begin Patch",
            "*** Update File: /ws/a.txt",
            "*** Move to: /ws/b.txt",
            "@@",
            "-world",
            "+device",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ).rejects.toThrow(/cannot move '\/ws\/a\.txt' to '\/ws\/b\.txt'/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects relative hunk paths that would resolve against the gateway workspace", async () => {
    await expect(
      applyDevicePatch({
        ...base,
        params: {
          input: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@",
            "-x",
            "+y",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    ).rejects.toThrow(/absolute device paths/);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("reports a pure no-op patch without writing", async () => {
    mockUpdateSequence();
    const result = await applyDevicePatch({
      ...base,
      params: {
        input: [
          "*** Begin Patch",
          "*** Update File: /ws/a.txt",
          "@@",
          "-world",
          "+world",
          "*** End Patch",
        ].join("\n"),
      },
    });
    expect(result.content[0]).toMatchObject({ text: "No changes made to /ws/a.txt." });
    expect(
      callGatewayTool.mock.calls.some(
        (call) => (call[2] as { command: string }).command === "file.write",
      ),
    ).toBe(false);
  });
});
