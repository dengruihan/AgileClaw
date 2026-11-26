// Direct upload intake tests exercise the real HTTP boundary: authentication is
// the ordinary Gateway path, parts stream to disk before the request ends, and
// the configured per-file ceiling is enforced on actual bytes. Ceilings are
// injected small so the 1 GiB contract is proven without allocating 1 GiB.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginStagedChatAttachment,
  commitStagedChatAttachment,
  consumeStagedChatAttachment,
  discardChatAttachmentUploads,
  discardChatAttachmentUpload,
  resetChatAttachmentUploadsForTests,
  runStagedChatAttachmentMutation,
  shutdownChatAttachmentUploads,
  startChatAttachmentUploadMaintenance,
  writeStagedChatAttachmentPart,
} from "./chat-attachment-upload-store.js";
import { handleChatAttachmentUploadHttpRequest } from "./chat-attachment-uploads.js";
import { parseMessageWithAttachments } from "./chat-attachments.js";

const GIB = 1024 * 1024 * 1024;

const configWithMaxMb = (mb: number): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: mb } } }) as unknown as OpenClawConfig;

type UploadResponse = { status: number; body: Record<string, unknown> };

let server: http.Server;
let origin = "";
let stagingRoot = "";
let stateDir = "";
let config: OpenClawConfig = configWithMaxMb(1 / 1024);
const PARSE_SCOPE = { sessionKey: "agent:main:main", agentId: "main" };

/** Stages and commits one real upload, returning its reference. */
async function stageUpload(bytes: Buffer, mimeType: string, fileName: string): Promise<string> {
  const begin = await beginStagedChatAttachment({
    scope: PARSE_SCOPE,
    declaredBytes: bytes.length,
    maxBytes: 1024 * 1024,
    fileName,
    mimeType,
  });
  await writeStagedChatAttachmentPart({
    uploadId: begin.uploadId,
    offset: 0,
    stream: (async function* () {
      yield bytes;
    })(),
    scope: PARSE_SCOPE,
    maxBytes: 1024 * 1024,
  });
  await commitStagedChatAttachment({
    uploadId: begin.uploadId,
    scope: PARSE_SCOPE,
    maxBytes: 1024 * 1024,
  });
  return begin.uploadId;
}

function stagedResolver(maxBytes = 1024 * 1024) {
  return (uploadId: string) => consumeStagedChatAttachment(uploadId, PARSE_SCOPE, { maxBytes });
}

async function startServer(nextConfig: OpenClawConfig): Promise<void> {
  config = nextConfig;
  server = http.createServer((req, res) => {
    void handleChatAttachmentUploadHttpRequest(req, res, {
      // Test servers run without Gateway auth; the handler still applies its
      // operator-scope and upload-policy checks.
      auth: undefined as never,
      getRuntimeConfig: () => config,
      basePath: "",
    }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  currentServer = server;
}

let currentServer: http.Server | undefined;

async function stopServer(): Promise<void> {
  if (!currentServer) {
    return;
  }
  const closing = currentServer;
  currentServer = undefined;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => {
    closing.close(() => resolve());
  });
}

function uploadUrl(query: Record<string, string | number>): string {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  return `${origin}/api/chat/attachments/upload?${params.toString()}`;
}

async function postJson(
  query: Record<string, string | number>,
  body?: BodyInit,
): Promise<UploadResponse> {
  const response = await fetch(uploadUrl(query), {
    method: "POST",
    ...(body ? { body } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Streams `chunks` as separate writes so the server must consume them in order. */
function streamPart(
  query: Record<string, string | number>,
  chunks: readonly Buffer[],
  options: { betweenChunks?: () => Promise<void> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(uploadUrl(query), { method: "POST" }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (chunk: Buffer) => parts.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as Record<
            string,
            unknown
          >,
        }),
      );
    });
    request.on("error", reject);
    void (async () => {
      for (const chunk of chunks) {
        request.write(chunk);
        if (options.betweenChunks) {
          await options.betweenChunks();
        }
      }
      request.end();
    })().catch(reject);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function stagingFiles(): Promise<string[]> {
  return await fs.readdir(stagingRoot).catch(() => []);
}

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-upload-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(async () => {
  await stopServer();
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-upload-parts-"));
  resetChatAttachmentUploadsForTests({ stagingRoot: async () => stagingRoot });
  await startServer(configWithMaxMb(1 / 1024));
});

afterEach(async () => {
  await stopServer();
  await discardChatAttachmentUploads();
  await fs.rm(stagingRoot, { recursive: true, force: true });
});

describe("direct chat attachment uploads", () => {
  it("accepts exactly 1 GiB and rejects one byte more from the advertised ceiling", async () => {
    await stopServer();
    await startServer(configWithMaxMb(1024));
    const atLimit = await postJson({ action: "begin", sizeBytes: GIB, fileName: "big.bin" });
    expect(atLimit.status).toBe(200);
    expect(typeof atLimit.body.uploadId).toBe("string");

    const overLimit = await postJson({ action: "begin", sizeBytes: GIB + 1, fileName: "big.bin" });
    expect(overLimit.status).toBe(413);
    expect((overLimit.body.error as { code?: string }).code).toBe("too-large");
  });

  it("writes bytes while the request is still open, then publishes on commit", async () => {
    const body = Buffer.alloc(800, 7);
    const begin = await postJson({ action: "begin", sizeBytes: body.length, fileName: "clip.bin" });
    const uploadId = begin.body.uploadId as string;
    const firstHalf = body.subarray(0, 400);

    let stagedBytesAfterFirstChunk = -1;
    const part = await streamPart(
      { action: "part", uploadId, offset: 0 },
      [firstHalf, body.subarray(400)],
      {
        betweenChunks: async () => {
          const [file] = await stagingFiles();
          stagedBytesAfterFirstChunk = file
            ? (await fs.stat(path.join(stagingRoot, file))).size
            : 0;
        },
      },
    );
    // The first chunk reached disk before the client finished the request.
    expect(stagedBytesAfterFirstChunk).toBe(400);
    expect(part.status).toBe(200);
    expect(part.body.receivedBytes).toBe(body.length);

    const commit = await postJson({ action: "commit", uploadId });
    expect(commit.status).toBe(200);
    expect(commit.body.sizeBytes).toBe(body.length);

    const consumed = consumeStagedChatAttachment(uploadId, {}, { maxBytes: body.length });
    expect(consumed.size).toBe(body.length);
    expect((await fs.stat(consumed.path)).size).toBe(body.length);
    await fs.rm(consumed.path, { force: true });
    expect(await stagingFiles()).toEqual([]);
  });

  it("rejects a part that exceeds the declared size on actual bytes", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 10 });
    const uploadId = begin.body.uploadId as string;
    const part = await streamPart({ action: "part", uploadId, offset: 0 }, [Buffer.alloc(11)]);
    expect(part.status).toBe(413);
    // The oversized chunk is refused before any of it is written.
    expect((part.body.error as { receivedBytes?: number }).receivedBytes).toBe(0);
  });

  it("rejects an offset that does not match the bytes already received", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 100 });
    const uploadId = begin.body.uploadId as string;
    const part = await streamPart({ action: "part", uploadId, offset: 40 }, [Buffer.alloc(10)]);
    expect(part.status).toBe(409);
    expect((part.body.error as { receivedBytes?: number }).receivedBytes).toBe(0);
  });

  it("keeps the session binding an upload was admitted for", async () => {
    const begin = await postJson({
      action: "begin",
      sizeBytes: 4,
      sessionKey: "agent:main:one",
    });
    const uploadId = begin.body.uploadId as string;
    const part = await streamPart(
      { action: "part", uploadId, offset: 0, sessionKey: "agent:main:one" },
      [Buffer.alloc(4)],
    );
    expect(part.status).toBe(200);
    const otherSession = await postJson({
      action: "commit",
      uploadId,
      sessionKey: "agent:main:two",
    });
    expect(otherSession.status).toBe(403);
    expect((otherSession.body.error as { code?: string }).code).toBe("scope-mismatch");

    const wrongSessionPart = await streamPart(
      { action: "part", uploadId, offset: 4, sessionKey: "agent:main:two" },
      [Buffer.alloc(1)],
    );
    expect(wrongSessionPart.status).toBe(403);

    const commit = await postJson({
      action: "commit",
      uploadId,
      sessionKey: "agent:main:one",
    });
    expect(commit.status).toBe(200);
    const consumed = consumeStagedChatAttachment(
      uploadId,
      { sessionKey: "agent:main:one" },
      { maxBytes: 4 },
    );
    await fs.rm(consumed.path, { force: true });
  });

  it("consumes a committed upload exactly once", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 3 });
    const uploadId = begin.body.uploadId as string;
    await streamPart({ action: "part", uploadId, offset: 0 }, [Buffer.alloc(3)]);
    await postJson({ action: "commit", uploadId });

    const consumed = consumeStagedChatAttachment(uploadId, {}, { maxBytes: 3 });
    await fs.rm(consumed.path, { force: true });
    expect(() => consumeStagedChatAttachment(uploadId, {}, { maxBytes: 3 })).toThrow(
      /unknown, expired, or already used/,
    );
  });

  it("releases the staged slot when the client's part transfer is interrupted", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 900 });
    const uploadId = begin.body.uploadId as string;
    const request = http.request(
      uploadUrl({ action: "part", uploadId, offset: 0 }),
      { method: "POST" },
      (response) => response.resume(),
    );
    request.on("error", () => undefined);
    request.write(Buffer.alloc(300));
    // Wait until the server durably holds the first chunk, then vanish mid-body.
    await vi.waitFor(async () => {
      const [file] = await stagingFiles();
      expect(file ? (await fs.stat(path.join(stagingRoot, file))).size : 0).toBe(300);
    });
    request.destroy();

    // No client is finishing an interrupted transfer, so its staged bytes and
    // slot go immediately instead of riding the one-hour staging expiry.
    await vi.waitFor(async () => expect(await stagingFiles()).toEqual([]));
    await expect(postJson({ action: "commit", uploadId })).resolves.toMatchObject({
      status: 404,
    });
  });

  it("releases the staged slot when a part stream breaks mid-transfer", async () => {
    const begin = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: 900,
      maxBytes: 1024,
    });
    await expect(
      writeStagedChatAttachmentPart({
        uploadId: begin.uploadId,
        offset: 0,
        stream: (async function* () {
          yield Buffer.alloc(300);
          throw new Error("socket hang up");
        })(),
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(await stagingFiles()).toEqual([]);
    // The confirmed bytes are gone with the slot, so a retry cannot resume them.
    await expect(
      writeStagedChatAttachmentPart({
        uploadId: begin.uploadId,
        offset: 300,
        stream: (async function* () {})(),
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "unknown-upload" });
  });

  it("cancels a fully written upload that has not committed yet", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 4 });
    const uploadId = begin.body.uploadId as string;
    await expect(
      streamPart({ action: "part", uploadId, offset: 0 }, [Buffer.alloc(4)]),
    ).resolves.toMatchObject({ status: 200 });
    expect(await stagingFiles()).toHaveLength(1);

    const cancelled = await postJson({ action: "discard", uploadId });
    expect(cancelled).toEqual({ status: 200, body: { uploadId, discarded: true } });
    // The handle is closed and the file removed, so the queued commit sees no upload.
    expect(await stagingFiles()).toEqual([]);
    await expect(postJson({ action: "commit", uploadId })).resolves.toMatchObject({ status: 404 });
  });

  it("releases a cancelled upload's staged slot for the next begin", async () => {
    const begin = () => postJson({ action: "begin", sizeBytes: 8, sessionKey: "agent:main:one" });
    const uploadIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const started = await begin();
      expect(started.status).toBe(200);
      uploadIds.push(started.body.uploadId as string);
    }
    await expect(begin()).resolves.toMatchObject({ status: 503 });

    const cancelled = await postJson({
      action: "discard",
      uploadId: uploadIds[0]!,
      sessionKey: "agent:main:one",
    });
    expect(cancelled).toEqual({
      status: 200,
      body: { uploadId: uploadIds[0], discarded: true },
    });
    expect(await stagingFiles()).toHaveLength(7);
    // The freed slot is admissible immediately, before any TTL sweep runs.
    await expect(begin()).resolves.toMatchObject({ status: 200 });
  });

  it("keeps a cancel bound to the scope that staged the upload", async () => {
    const begin = await postJson({
      action: "begin",
      sizeBytes: 4,
      sessionKey: "agent:main:one",
      agentId: "main",
    });
    const uploadId = begin.body.uploadId as string;

    const foreign = await postJson({
      action: "discard",
      uploadId,
      sessionKey: "agent:main:two",
      agentId: "main",
    });
    expect(foreign.status).toBe(403);
    expect((foreign.body.error as { code?: string }).code).toBe("scope-mismatch");

    // The refused cancel deleted nothing: the admitting scope can still finish.
    await expect(
      streamPart(
        { action: "part", uploadId, offset: 0, sessionKey: "agent:main:one", agentId: "main" },
        [Buffer.alloc(4)],
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      postJson({ action: "commit", uploadId, sessionKey: "agent:main:one", agentId: "main" }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("releases a removed ready attachment's committed slot and bytes", async () => {
    const uploadIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      uploadIds.push(await stageUpload(Buffer.alloc(4), "application/pdf", "tiny.pdf"));
    }
    const begin = () => postJson({ action: "begin", sizeBytes: 4, ...PARSE_SCOPE });
    await expect(begin()).resolves.toMatchObject({ status: 503 });

    const removed = uploadIds[0]!;
    const mediaBefore = await inboundFiles();
    await expect(
      postJson({ action: "discard", uploadId: removed, ...PARSE_SCOPE }),
    ).resolves.toEqual({ status: 200, body: { uploadId: removed, discarded: true } });
    // Published media and the committed capacity are free again.
    expect(await inboundFiles()).toHaveLength(mediaBefore.length - 1);
    expect(() => consumeStagedChatAttachment(removed, PARSE_SCOPE, { maxBytes: 4 })).toThrow(
      /unknown, expired, or already used/,
    );
    await expect(begin()).resolves.toMatchObject({ status: 200 });
    // Repeating the release after a lost response is still a success.
    await expect(
      postJson({ action: "discard", uploadId: removed, ...PARSE_SCOPE }),
    ).resolves.toEqual({ status: 200, body: { uploadId: removed, discarded: false } });
  });

  it("never deletes an upload a send already adopted", async () => {
    const uploadId = await stageUpload(Buffer.alloc(4, 5), "application/pdf", "sent.pdf");
    const media = consumeStagedChatAttachment(uploadId, PARSE_SCOPE, { maxBytes: 4 });
    const bytes = await fs.readFile(media.path);

    // The send owns these bytes now; a late cancel must not touch them.
    await expect(postJson({ action: "discard", uploadId, ...PARSE_SCOPE })).resolves.toEqual({
      status: 200,
      body: { uploadId, discarded: false },
    });
    expect(await fs.readFile(media.path)).toEqual(bytes);
    await fs.rm(media.path, { force: true });
  });

  it("refuses a cancel from another authenticated owner of the same session", async () => {
    const begin = await beginStagedChatAttachment({
      scope: { ownerKey: "profile:alice", sessionKey: PARSE_SCOPE.sessionKey },
      declaredBytes: 4,
      maxBytes: 1024,
    });
    await expect(
      discardChatAttachmentUpload({
        uploadId: begin.uploadId,
        scope: { ownerKey: "profile:bob", sessionKey: PARSE_SCOPE.sessionKey },
      }),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
    expect(await stagingFiles()).toHaveLength(1);

    await expect(
      discardChatAttachmentUpload({
        uploadId: begin.uploadId,
        scope: { ownerKey: "profile:alice", sessionKey: PARSE_SCOPE.sessionKey },
      }),
    ).resolves.toEqual({ uploadId: begin.uploadId, discarded: true });
    expect(await stagingFiles()).toEqual([]);
  });

  it("deletes a consumed upload when a later validation rejects the send", async () => {
    const uploadId = await stageUpload(Buffer.from("plain text"), "text/plain", "notes.txt");
    let resolvedPath: string | undefined;
    await expect(
      parseMessageWithAttachments(
        "see file",
        [{ type: "file", mimeType: "text/plain", fileName: "notes.txt", uploadId }],
        {
          acceptNonImage: false,
          resolveStagedUpload: (id) => {
            const media = consumeStagedChatAttachment(id, PARSE_SCOPE, { maxBytes: 1024 });
            resolvedPath = media.path;
            return media;
          },
        },
      ),
    ).rejects.toThrow(/not supported on this entrypoint/);
    expect(resolvedPath).toBeTruthy();
    await expect(fs.stat(resolvedPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => stagedResolver()(uploadId)).toThrow(/already used/);
  });

  it("fails a duplicate upload reference and deletes the already adopted media", async () => {
    const uploadId = await stageUpload(Buffer.from("%PDF-1.4\n"), "application/pdf", "once.pdf");
    let resolvedPath: string | undefined;
    await expect(
      parseMessageWithAttachments(
        "two references",
        [
          { type: "file", mimeType: "application/pdf", fileName: "once.pdf", uploadId },
          { type: "file", mimeType: "application/pdf", fileName: "once.pdf", uploadId },
        ],
        {
          resolveStagedUpload: (id) => {
            const media = consumeStagedChatAttachment(id, PARSE_SCOPE, { maxBytes: 1024 });
            resolvedPath ??= media.path;
            return media;
          },
        },
      ),
    ).rejects.toThrow(/already used/);
    expect(resolvedPath).toBeTruthy();
    await expect(fs.stat(resolvedPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes consumed media when the request loses authority mid-parse", async () => {
    const uploadId = await stageUpload(Buffer.from("payload"), "application/pdf", "brief.pdf");
    let resolvedPath: string | undefined;
    let checks = 0;
    await expect(
      parseMessageWithAttachments(
        "see file",
        [{ type: "file", mimeType: "application/pdf", fileName: "brief.pdf", uploadId }],
        {
          resolveStagedUpload: (id) => {
            const media = consumeStagedChatAttachment(id, PARSE_SCOPE, { maxBytes: 1024 });
            resolvedPath = media.path;
            return media;
          },
          assertCurrent: () => {
            checks += 1;
            if (checks > 1) {
              throw new Error("authority changed");
            }
          },
        },
      ),
    ).rejects.toThrow(/authority changed/);
    expect(resolvedPath).toBeTruthy();
    await expect(fs.stat(resolvedPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops uploads omitted by the text-only image cap and keeps the adopted ones", async () => {
    const uploadIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      uploadIds.push(
        await stageUpload(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png", `shot-${index}.png`),
      );
    }
    const omittedPaths: string[] = [];
    const parsed = await parseMessageWithAttachments(
      "screens",
      uploadIds.map((uploadId) => ({
        type: "image",
        mimeType: "image/png",
        fileName: "shot.png",
        uploadId,
      })),
      {
        supportsImages: false,
        resolveStagedUpload: (id) => {
          const media = consumeStagedChatAttachment(id, PARSE_SCOPE, { maxBytes: 1024 });
          omittedPaths.push(media.path);
          return media;
        },
      },
    );
    expect(parsed.offloadedRefs).toHaveLength(10);
    expect(parsed.message).toContain("text-only attachment limit reached");
    // The eleventh upload was consumed but omitted, so its file must be gone.
    await expect(fs.stat(omittedPaths[10]!)).rejects.toMatchObject({ code: "ENOENT" });
    for (const ref of parsed.offloadedRefs) {
      await fs.rm(ref.path, { force: true });
    }
  });

  it("counts staged reservations against the unsent-byte ceiling", async () => {
    const beginGiB = () =>
      beginStagedChatAttachment({
        scope: PARSE_SCOPE,
        declaredBytes: GIB,
        maxBytes: GIB,
      });
    // Four reservations fill the 4 GiB ceiling; the fifth must be refused even
    // though only four staging files exist and nothing was written yet.
    for (let index = 0; index < 4; index += 1) {
      await expect(beginGiB()).resolves.toMatchObject({ partBytes: expect.any(Number) });
    }
    await expect(beginGiB()).rejects.toMatchObject({ code: "capacity" });

    // Releasing the reservations admits the same begin again.
    await discardChatAttachmentUploads();
    await expect(beginGiB()).resolves.toBeTruthy();
    await discardChatAttachmentUploads();
  });

  it("keeps the exact unsent boundary across the staged-to-committed transition", async () => {
    for (let index = 0; index < 3; index += 1) {
      await beginStagedChatAttachment({
        scope: PARSE_SCOPE,
        declaredBytes: GIB,
        maxBytes: GIB,
      });
    }
    await stageUpload(Buffer.alloc(100, 1), "application/pdf", "tiny.pdf");
    // The committed 100 bytes still count: only the remainder is admissible.
    const remaining = 4 * GIB - 3 * GIB - 100;
    await expect(
      beginStagedChatAttachment({
        scope: PARSE_SCOPE,
        declaredBytes: remaining,
        maxBytes: remaining,
      }),
    ).resolves.toBeTruthy();
    await expect(
      beginStagedChatAttachment({
        scope: PARSE_SCOPE,
        declaredBytes: remaining + 1,
        maxBytes: remaining + 1,
      }),
    ).rejects.toMatchObject({ code: "capacity" });
  });

  it("fences new admission and drains in-flight mutations before the final discard", async () => {
    const inboundBefore = await inboundFiles();
    // One staged-only upload and one committed-but-unsent upload must both go.
    const staged = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: 4,
      maxBytes: 1024,
      fileName: "staged.bin",
      mimeType: "application/octet-stream",
    });
    await stageUpload(Buffer.from("pending"), "application/pdf", "pending.pdf");
    expect(await inboundFiles()).toHaveLength(inboundBefore.length + 1);
    expect(await stagingFiles()).toHaveLength(1);

    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationSettled = false;
    const mutation = runStagedChatAttachmentMutation("probe", async () => {
      await mutationGate;
      mutationSettled = true;
    });
    const shutdown = shutdownChatAttachmentUploads();
    await Promise.resolve();

    // Admission is fenced immediately, while the in-flight mutation is joined.
    await expect(
      beginStagedChatAttachment({ scope: PARSE_SCOPE, declaredBytes: 4, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "shutting-down" });
    await expect(
      writeStagedChatAttachmentPart({
        uploadId: staged.uploadId,
        offset: 0,
        stream: (async function* () {
          yield Buffer.alloc(1);
        })(),
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "shutting-down" });
    await expect(
      commitStagedChatAttachment({ uploadId: staged.uploadId, scope: PARSE_SCOPE, maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "shutting-down" });
    expect(mutationSettled).toBe(false);

    releaseMutation();
    await mutation;
    await shutdown;
    expect(mutationSettled).toBe(true);
    // Final discard removed the published media and every staging file.
    expect(await inboundFiles()).toEqual(inboundBefore);
    expect(await stagingFiles()).toEqual([]);
  });
});

describe("direct upload capacity and shutdown interleavings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("counts a committing upload while its staging unlink is still pending", async () => {
    // Three 1 GiB reservations plus a real 100-byte upload that is parked at
    // the post-publication staging unlink. The accounting transfer is already
    // committed, so a further 1 GiB begin must not fit.
    for (let index = 0; index < 3; index += 1) {
      await beginStagedChatAttachment({ scope: PARSE_SCOPE, declaredBytes: GIB, maxBytes: GIB });
    }
    const tiny = Buffer.alloc(100, 3);
    const begin = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: tiny.length,
      maxBytes: 1024,
      fileName: "tiny.pdf",
      mimeType: "application/pdf",
    });
    await writeStagedChatAttachmentPart({
      uploadId: begin.uploadId,
      offset: 0,
      stream: (async function* () {
        yield tiny;
      })(),
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });

    const unlinkEntered = deferred();
    const releaseUnlink = deferred();
    const stagingPath = path.join(stagingRoot, `${begin.uploadId}.part`);
    const realRm = fs.rm.bind(fs);
    let gated = true;
    vi.spyOn(fs, "rm").mockImplementation((async (target: string, options?: unknown) => {
      if (gated && String(target) === stagingPath) {
        gated = false;
        unlinkEntered.resolve();
        await releaseUnlink.promise;
      }
      return await realRm(target, options as never);
    }) as typeof fs.rm);

    const commit = commitStagedChatAttachment({
      uploadId: begin.uploadId,
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    await unlinkEntered.promise;

    // While the unlink is held, the reservation must already be committed.
    await expect(
      beginStagedChatAttachment({ scope: PARSE_SCOPE, declaredBytes: GIB, maxBytes: GIB }),
    ).rejects.toMatchObject({ code: "capacity" });
    // The exact boundary stays admissible: 4 GiB - 3 GiB - 100 bytes.
    const remaining = 4 * GIB - 3 * GIB - tiny.length;
    await expect(
      beginStagedChatAttachment({
        scope: PARSE_SCOPE,
        declaredBytes: remaining,
        maxBytes: remaining,
      }),
    ).resolves.toBeTruthy();

    releaseUnlink.resolve();
    await expect(commit).resolves.toMatchObject({ sizeBytes: tiny.length });
  });

  it("rejects a begin that finishes opening its staging file after the final discard", async () => {
    const openEntered = deferred();
    const releaseOpen = deferred();
    const realOpen = fs.open.bind(fs);
    let gateNextStagingOpen = true;
    vi.spyOn(fs, "open").mockImplementation((async (
      target: string,
      flags: string,
      mode?: number,
    ) => {
      const handle = await realOpen(target as never, flags as never, mode as never);
      if (gateNextStagingOpen && flags === "wx") {
        gateNextStagingOpen = false;
        openEntered.resolve();
        await releaseOpen.promise;
      }
      return handle;
    }) as typeof fs.open);

    const lateBegin = beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: 4,
      maxBytes: 1024,
      fileName: "late.bin",
      mimeType: "application/octet-stream",
    });
    await openEntered.promise;

    vi.useFakeTimers();
    const shutdown = shutdownChatAttachmentUploads();
    await vi.advanceTimersByTimeAsync(5_000 + 1);
    await shutdown;
    vi.useRealTimers();

    // Even if a maintenance generation re-opens admission, this admitted begin
    // belongs to the retired generation and must not land.
    await startChatAttachmentUploadMaintenance();
    releaseOpen.resolve();
    await expect(lateBegin).rejects.toMatchObject({ code: "shutting-down" });
    expect(await stagingFiles()).toEqual([]);
    await expect(
      beginStagedChatAttachment({ scope: PARSE_SCOPE, declaredBytes: 4, maxBytes: 4 }),
    ).resolves.toBeTruthy();
  });

  it("never installs or returns a commit that publishes after the final discard", async () => {
    // Park the commit at its staging-handle close, i.e. after admission and
    // before publication; the shutdown deadline then expires under it.
    const closeEntered = deferred();
    const releaseClose = deferred();
    const realOpen = fs.open.bind(fs);
    let gateStagingClose = true;
    vi.spyOn(fs, "open").mockImplementation((async (
      target: string,
      flags: string,
      mode?: number,
    ) => {
      const handle = await realOpen(target as never, flags as never, mode as never);
      if (gateStagingClose && flags === "wx") {
        gateStagingClose = false;
        const realClose = handle.close.bind(handle);
        handle.close = (async () => {
          closeEntered.resolve();
          await releaseClose.promise;
          return await realClose();
        }) as typeof handle.close;
      }
      return handle;
    }) as typeof fs.open);

    const tiny = Buffer.from("late commit");
    const begin = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: tiny.length,
      maxBytes: 1024,
      fileName: "late.pdf",
      mimeType: "application/pdf",
    });
    await writeStagedChatAttachmentPart({
      uploadId: begin.uploadId,
      offset: 0,
      stream: (async function* () {
        yield tiny;
      })(),
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });

    const commit = commitStagedChatAttachment({
      uploadId: begin.uploadId,
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    await closeEntered.promise;
    const inboundBefore = await inboundFiles();

    vi.useFakeTimers();
    const shutdown = shutdownChatAttachmentUploads();
    await vi.advanceTimersByTimeAsync(5_000 + 1);
    await shutdown;
    vi.useRealTimers();

    releaseClose.resolve();
    await expect(commit).rejects.toMatchObject({ code: "shutting-down" });
    // Nothing was installed: no consumable ID, no published media, no staging file.
    expect(() =>
      consumeStagedChatAttachment(begin.uploadId, PARSE_SCOPE, { maxBytes: 1024 }),
    ).toThrow(/unknown, expired, or already used/);
    expect(await inboundFiles()).toEqual(inboundBefore);
    expect(await stagingFiles()).toEqual([]);
  });
});

describe("maintenance generation ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a replacement generation's upload after the previous shutdown settles", async () => {
    // An upload admitted by the current generation.
    const oldUpload = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: 4,
      maxBytes: 1024,
      fileName: "old.bin",
      mimeType: "application/octet-stream",
    });

    // Hold an old-generation mutation so the shutdown drain stays pending.
    const hold = deferred();
    const oldMutation = runStagedChatAttachmentMutation("old-generation", async () => {
      await hold.promise;
    });
    const oldShutdown = shutdownChatAttachmentUploads();
    const activation = startChatAttachmentUploadMaintenance();
    await Promise.resolve();

    // The replacement must not accept uploads while the old drain is held.
    await expect(
      beginStagedChatAttachment({ scope: PARSE_SCOPE, declaredBytes: 4, maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "shutting-down" });

    hold.resolve();
    await oldMutation;
    await oldShutdown;
    await activation;

    // The old generation's staged upload is gone, and its ID is fenced.
    expect(await stagingFiles()).toEqual([]);
    await expect(
      writeStagedChatAttachmentPart({
        uploadId: oldUpload.uploadId,
        offset: 0,
        stream: (async function* () {
          yield Buffer.alloc(4);
        })(),
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "unknown-upload" });

    // A new-generation upload stays writable and committable after the old discard.
    const payload = Buffer.from("fresh");
    const fresh = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: payload.length,
      maxBytes: 1024,
      fileName: "fresh.pdf",
      mimeType: "application/pdf",
    });
    await writeStagedChatAttachmentPart({
      uploadId: fresh.uploadId,
      offset: 0,
      stream: (async function* () {
        yield payload;
      })(),
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    await expect(
      commitStagedChatAttachment({
        uploadId: fresh.uploadId,
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).resolves.toMatchObject({ sizeBytes: payload.length });
    const media = consumeStagedChatAttachment(fresh.uploadId, PARSE_SCOPE, { maxBytes: 1024 });
    expect(await fs.readFile(media.path)).toEqual(payload);
    await fs.rm(media.path, { force: true });
  });

  it("does not retire an admitted begin when initial maintenance activates", async () => {
    const openEntered = deferred();
    const releaseOpen = deferred();
    const realOpen = fs.open.bind(fs);
    let gateNextStagingOpen = true;
    vi.spyOn(fs, "open").mockImplementation((async (
      target: string,
      flags: string,
      mode?: number,
    ) => {
      const handle = await realOpen(target as never, flags as never, mode as never);
      if (gateNextStagingOpen && flags === "wx") {
        gateNextStagingOpen = false;
        openEntered.resolve();
        await releaseOpen.promise;
      }
      return handle;
    }) as typeof fs.open);

    const payload = Buffer.from("startup");
    const begin = beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: payload.length,
      maxBytes: 1024,
      fileName: "startup.pdf",
      mimeType: "application/pdf",
    });
    await openEntered.promise;

    // Initial activation of an already-open store must not retire this admission.
    await startChatAttachmentUploadMaintenance();
    releaseOpen.resolve();

    const admitted = await begin;
    await writeStagedChatAttachmentPart({
      uploadId: admitted.uploadId,
      offset: 0,
      stream: (async function* () {
        yield payload;
      })(),
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    await expect(
      commitStagedChatAttachment({
        uploadId: admitted.uploadId,
        scope: PARSE_SCOPE,
        maxBytes: 1024,
      }),
    ).resolves.toMatchObject({ sizeBytes: payload.length });
    const media = consumeStagedChatAttachment(admitted.uploadId, PARSE_SCOPE, { maxBytes: 1024 });
    await fs.rm(media.path, { force: true });
  });

  it("keeps an admitted commit usable across initial maintenance activation", async () => {
    const closeEntered = deferred();
    const releaseClose = deferred();
    const realOpen = fs.open.bind(fs);
    let gateStagingClose = true;
    vi.spyOn(fs, "open").mockImplementation((async (
      target: string,
      flags: string,
      mode?: number,
    ) => {
      const handle = await realOpen(target as never, flags as never, mode as never);
      if (gateStagingClose && flags === "wx") {
        gateStagingClose = false;
        const realClose = handle.close.bind(handle);
        handle.close = (async () => {
          closeEntered.resolve();
          await releaseClose.promise;
          return await realClose();
        }) as typeof handle.close;
      }
      return handle;
    }) as typeof fs.open);

    const payload = Buffer.from("activation commit");
    const begin = await beginStagedChatAttachment({
      scope: PARSE_SCOPE,
      declaredBytes: payload.length,
      maxBytes: 1024,
      fileName: "activation.pdf",
      mimeType: "application/pdf",
    });
    await writeStagedChatAttachmentPart({
      uploadId: begin.uploadId,
      offset: 0,
      stream: (async function* () {
        yield payload;
      })(),
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    const commit = commitStagedChatAttachment({
      uploadId: begin.uploadId,
      scope: PARSE_SCOPE,
      maxBytes: 1024,
    });
    await closeEntered.promise;

    await startChatAttachmentUploadMaintenance();
    releaseClose.resolve();

    await expect(commit).resolves.toMatchObject({ sizeBytes: payload.length });
    const media = consumeStagedChatAttachment(begin.uploadId, PARSE_SCOPE, { maxBytes: 1024 });
    expect(await fs.readFile(media.path)).toEqual(payload);
    await fs.rm(media.path, { force: true });
  });
});

async function inboundFiles(): Promise<string[]> {
  const { getMediaDir } = await import("../media/store.js");
  return (await fs.readdir(path.join(getMediaDir(), "inbound")).catch(() => [])).toSorted();
}
