// @vitest-environment jsdom
// Direct upload boundary: a file above one frame's base64 budget is staged on
// the Gateway and referenced from chat.send by upload ID, never encoded inline.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatApiAttachments } from "../attachment-api.ts";
import {
  attachmentBatchRejection,
  attachmentNeedsDirectUpload,
  type ChatAttachmentLimits,
} from "./chat-attachment-admission.ts";
import {
  resolveChatAttachmentUploadTarget,
  stageChatAttachment,
} from "./chat-attachment-upload.ts";

const MB = 1024 * 1024;
const limits: ChatAttachmentLimits = {
  maxBytes: 1024 * MB,
  maxImageBytes: 6 * MB,
  maxBatchBytes: 18 * MB,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachmentNeedsDirectUpload", () => {
  it("stages non-image files above one frame budget and keeps smaller ones inline", () => {
    expect(attachmentNeedsDirectUpload(20 * MB, "application/pdf", limits)).toBe(true);
    expect(attachmentNeedsDirectUpload(1024 * MB, "application/pdf", limits)).toBe(true);
    expect(attachmentNeedsDirectUpload(18 * MB, "application/pdf", limits)).toBe(false);
    // Images keep the inline path; their own ceiling is far below any frame.
    expect(attachmentNeedsDirectUpload(20 * MB, "image/png", limits)).toBe(false);
    // Above the decoded ceiling the file is rejected, not silently uploaded.
    expect(attachmentNeedsDirectUpload(1024 * MB + 1, "application/pdf", limits)).toBe(false);
  });

  it("keeps direct uploads out of a request's batch budget", () => {
    expect(
      attachmentBatchRejection(
        [
          { id: "big", mimeType: "application/pdf", uploadId: "upload-1", sizeBytes: 900 * MB },
          { id: "small", mimeType: "application/pdf", sizeBytes: MB },
        ],
        { maxPayload: 25 * MB, attachments: { maxBytes: limits.maxBytes, maxImageBytes: 6 * MB } },
      ),
    ).toBeUndefined();
  });
});

describe("buildChatApiAttachments", () => {
  it("references a staged file by upload ID and sends no base64 content", () => {
    const payload = buildChatApiAttachments([
      {
        id: "staged-pdf",
        mimeType: "application/pdf",
        fileName: "large.pdf",
        uploadId: "9c1f0d1e-0000-4000-8000-000000000001",
        sizeBytes: 700 * MB,
      },
    ]);
    expect(payload).toEqual([
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "large.pdf",
        uploadId: "9c1f0d1e-0000-4000-8000-000000000001",
        sizeBytes: 700 * MB,
      },
    ]);
    expect(payload?.[0]).not.toHaveProperty("content");
  });
});

describe("stageChatAttachment", () => {
  it("begins, sends one part, and commits against the session it was admitted for", async () => {
    const requests: { url: string; body?: Blob }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const request = new URL(String(url), "http://localhost");
        requests.push({
          url: request.search,
          ...(init?.body instanceof Blob ? { body: init.body } : {}),
        });
        const action = request.searchParams.get("action");
        const body =
          action === "begin"
            ? { uploadId: "9c1f0d1e-0000-4000-8000-000000000002", partBytes: 16 * MB }
            : action === "part"
              ? { uploadId: "9c1f0d1e-0000-4000-8000-000000000002", receivedBytes: 4 }
              : {
                  uploadId: "9c1f0d1e-0000-4000-8000-000000000002",
                  sizeBytes: 4,
                  mimeType: "application/pdf",
                };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const target = resolveChatAttachmentUploadTarget({
      resourceBasePath: "/mount",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    const progress: number[] = [];
    const file = new File([new Uint8Array([1, 2, 3, 4])], "large.pdf", {
      type: "application/pdf",
    });
    const staged = await stageChatAttachment({
      file,
      target,
      signal: new AbortController().signal,
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(staged).toMatchObject({
      uploadId: "9c1f0d1e-0000-4000-8000-000000000002",
      sizeBytes: 4,
      mimeType: "application/pdf",
    });
    expect(requests.map((request) => new URLSearchParams(request.url).get("action"))).toEqual([
      "begin",
      "part",
      "commit",
    ]);
    const begin = new URLSearchParams(requests[0]!.url);
    expect(begin.get("sessionKey")).toBe("agent:main:main");
    expect(begin.get("agentId")).toBe("main");
    expect(begin.get("sizeBytes")).toBe("4");
    expect(requests[1]!.body?.size).toBe(4);
    expect(progress.at(-1)).toBe(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      "/mount/api/chat/attachments/upload?action=begin&sizeBytes=4&fileName=large.pdf&mimeType=application%2Fpdf&sessionKey=agent%3Amain%3Amain&agentId=main",
    );
  });

  it("stops before committing when the caller aborts during a part", async () => {
    const controller = new AbortController();
    const actions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const action = new URL(String(url), "http://localhost").searchParams.get("action");
        actions.push(action ?? "");
        if (action === "part") {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
        return new Response(JSON.stringify({ uploadId: "9c1f0d1e-0000-4000-8000-000000000003" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(
      stageChatAttachment({
        file: new File([new Uint8Array([1, 2])], "clip.bin", { type: "application/octet-stream" }),
        target: { basePath: "" },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(actions).toEqual(["begin", "part"]);
  });
});
