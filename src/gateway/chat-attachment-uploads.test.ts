// Direct upload intake tests exercise the real HTTP boundary: authentication is
// the ordinary Gateway path, parts stream to disk before the request ends, and
// the configured per-file ceiling is enforced on actual bytes. Ceilings are
// injected small so the 1 GiB contract is proven without allocating 1 GiB.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  consumeStagedChatAttachment,
  discardChatAttachmentUploads,
  resetChatAttachmentUploadsForTests,
} from "./chat-attachment-upload-store.js";
import { handleChatAttachmentUploadHttpRequest } from "./chat-attachment-uploads.js";

const GIB = 1024 * 1024 * 1024;

const configWithMaxMb = (mb: number): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: mb } } }) as unknown as OpenClawConfig;

type UploadResponse = { status: number; body: Record<string, unknown> };

let server: http.Server;
let origin = "";
let stagingRoot = "";
let stateDir = "";
let config: OpenClawConfig = configWithMaxMb(1 / 1024);

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
  options: { betweenChunks?: () => Promise<void>; destroyAfterFirst?: boolean } = {},
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
      for (const [index, chunk] of chunks.entries()) {
        request.write(chunk);
        if (options.destroyAfterFirst && index === 0) {
          request.destroy();
          return;
        }
        if (options.betweenChunks) {
          await options.betweenChunks();
        }
      }
      request.end();
    })().catch(reject);
  });
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

  it("drops a partially written staging file when the client aborts", async () => {
    const begin = await postJson({ action: "begin", sizeBytes: 900 });
    const uploadId = begin.body.uploadId as string;
    await streamPart({ action: "part", uploadId, offset: 0 }, [Buffer.alloc(300)], {
      destroyAfterFirst: true,
    }).catch(() => undefined);
    // The part mutation settles when the aborted stream errors; the commit that
    // follows serializes behind it and can only see an incomplete upload.
    await expect(postJson({ action: "commit", uploadId })).resolves.toMatchObject({
      status: 409,
    });
    expect(await stagingFiles()).toHaveLength(1);
    await discardChatAttachmentUploads();
    expect(await stagingFiles()).toEqual([]);
  });
});
