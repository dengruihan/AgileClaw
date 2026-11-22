// Composition regression: the protocol client the Control UI runs, a real HTTP
// handler, and the real staging store, in one flow. Two mocked layers previously
// let a scope bug through: begin carried session/agent, part and commit did not.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  uploadChatAttachmentInParts,
  type ChatAttachmentUploadRequest,
  type ChatAttachmentUploadResponse,
} from "../shared/chat-attachment-upload-client.js";
import {
  beginStagedChatAttachment,
  consumeStagedChatAttachment,
  discardChatAttachmentUploads,
  resetChatAttachmentUploadsForTests,
  writeStagedChatAttachmentPart,
} from "./chat-attachment-upload-store.js";
import { handleChatAttachmentUploadHttpRequest } from "./chat-attachment-uploads.js";

const SCOPE = { sessionKey: "agent:main:main", agentId: "main" };
const MAX_BYTES = 4096;

let server: http.Server;
let origin = "";
let stagingRoot = "";
let stateDir = "";
let cfg: OpenClawConfig;
const config = (): OpenClawConfig =>
  ({
    agents: { defaults: { mediaMaxMb: MAX_BYTES / (1024 * 1024) } },
  }) as unknown as OpenClawConfig;

async function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    void handleChatAttachmentUploadHttpRequest(req, res, {
      auth: undefined as never,
      getRuntimeConfig: () => cfg,
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
}

async function stopServer(): Promise<void> {
  if (!server) {
    return;
  }
  const closing = server;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => {
    closing.close(() => resolve());
  });
}

type Captured = { url: string; body?: Blob };

/** The Control UI's transport adapter: same-origin POST, JSON response. */
function captureSender(captured: Captured[], options: { dropScope?: boolean } = {}) {
  return async (request: ChatAttachmentUploadRequest): Promise<ChatAttachmentUploadResponse> => {
    const parsed = new URL(request.url);
    // A legacy/broken client dropped the scope after begin; that must fail.
    const dropScope = options.dropScope === true && parsed.searchParams.get("action") !== "begin";
    if (dropScope) {
      parsed.searchParams.delete("sessionKey");
      parsed.searchParams.delete("agentId");
    }
    const url = parsed.toString();
    captured.push({ url, ...(request.body ? { body: request.body } : {}) });
    const response = await fetch(url, {
      method: "POST",
      ...(request.body ? { body: request.body } : {}),
      signal: request.signal,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

const PDF_BYTES = Buffer.from("%PDF-1.4\nstaged attachment payload\n");

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-upload-compose-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  cfg = config();
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-upload-compose-parts-"));
  resetChatAttachmentUploadsForTests({ stagingRoot: async () => stagingRoot });
  await startServer();
});

afterEach(async () => {
  await stopServer();
  await discardChatAttachmentUploads();
  await fs.rm(stagingRoot, { recursive: true, force: true });
});

describe("direct attachment upload composition", () => {
  it("runs the UI protocol client against the real handler and store", async () => {
    const captured: Captured[] = [];
    const staged = await uploadChatAttachmentInParts({
      basePath: origin,
      file: new Blob([PDF_BYTES], { type: "application/pdf" }),
      sizeBytes: PDF_BYTES.length,
      mimeType: "application/pdf",
      fileName: "notes.pdf",
      scope: SCOPE,
      signal: new AbortController().signal,
      send: captureSender(captured),
      onProgress: () => {},
    });

    // Every protocol step presented the admitted scope, not just begin.
    expect(captured.map((request) => new URL(request.url).searchParams.get("action"))).toEqual([
      "begin",
      "part",
      "commit",
    ]);
    for (const request of captured) {
      const query = new URL(request.url).searchParams;
      expect(query.get("sessionKey")).toBe(SCOPE.sessionKey);
      expect(query.get("agentId")).toBe(SCOPE.agentId);
    }

    const media = consumeStagedChatAttachment(staged.uploadId, SCOPE, { maxBytes: MAX_BYTES });
    expect(media.size).toBe(PDF_BYTES.length);
    expect(await fs.readFile(media.path)).toEqual(PDF_BYTES);
    await fs.rm(media.path, { force: true });
  });

  it("fails at the first part when a client stops repeating the admitted scope", async () => {
    const captured: Captured[] = [];
    await expect(
      uploadChatAttachmentInParts({
        basePath: origin,
        file: new Blob([PDF_BYTES], { type: "application/pdf" }),
        sizeBytes: PDF_BYTES.length,
        mimeType: "application/pdf",
        fileName: "notes.pdf",
        scope: SCOPE,
        signal: new AbortController().signal,
        send: captureSender(captured, { dropScope: true }),
      }),
    ).rejects.toMatchObject({ code: "scope-mismatch" });
    // Begin carried the scope; the dropped-scope part never reached the store.
    expect(captured).toHaveLength(2);
  });

  it("replays a commit whose response was lost without publishing twice", async () => {
    const begin = await beginStagedChatAttachment({
      scope: SCOPE,
      declaredBytes: PDF_BYTES.length,
      maxBytes: MAX_BYTES,
    });
    await writeStagedChatAttachmentPart({
      uploadId: begin.uploadId,
      offset: 0,
      stream: (async function* () {
        yield PDF_BYTES;
      })(),
      scope: SCOPE,
      maxBytes: MAX_BYTES,
    });
    const commit = async () =>
      (
        await fetch(
          `${origin}/api/chat/attachments/upload?${new URLSearchParams({
            action: "commit",
            uploadId: begin.uploadId,
            sessionKey: SCOPE.sessionKey,
            agentId: SCOPE.agentId,
          })}`,
          { method: "POST" },
        )
      ).json() as Promise<Record<string, unknown>>;

    const first = await commit();
    const replay = await commit();
    expect(replay).toEqual(first);

    const media = consumeStagedChatAttachment(begin.uploadId, SCOPE, { maxBytes: MAX_BYTES });
    await fs.rm(media.path, { force: true });
    expect(() =>
      consumeStagedChatAttachment(begin.uploadId, SCOPE, { maxBytes: MAX_BYTES }),
    ).toThrow(/already used/);
  });

  it("enforces the part ceiling it advertised at begin", async () => {
    const begin = await beginStagedChatAttachment({
      scope: SCOPE,
      declaredBytes: 64,
      maxBytes: MAX_BYTES,
      partBytes: 8,
    });
    await expect(
      writeStagedChatAttachmentPart({
        uploadId: begin.uploadId,
        offset: 0,
        stream: (async function* () {
          yield Buffer.alloc(9);
        })(),
        scope: SCOPE,
        maxBytes: MAX_BYTES,
      }),
    ).rejects.toMatchObject({ code: "part-too-large" });
    await discardChatAttachmentUploads();
  });
});
