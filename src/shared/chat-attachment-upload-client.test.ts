// Protocol-level proof for abandoning a direct chat attachment upload: a
// cancelled transfer asks the Gateway to release the staged slot it owns, and
// that release never becomes a second user-visible error. The sender is stubbed
// here because the transport belongs to the Control UI adapter; the real HTTP
// boundary is proven in src/gateway/chat-attachment-uploads.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
  uploadChatAttachmentInParts,
  type ChatAttachmentUploadRequest,
  type ChatAttachmentUploadResponse,
} from "./chat-attachment-upload-client.js";

const SCOPE = { sessionKey: "agent:main:main", agentId: "main" };
const UPLOAD_ID = "9c1f0d1e-0000-4000-8000-0000000000ab";

function actionOf(request: ChatAttachmentUploadRequest): string | null {
  return new URL(request.url, "http://localhost").searchParams.get("action");
}

function uploadParams(
  send: (request: ChatAttachmentUploadRequest) => Promise<ChatAttachmentUploadResponse>,
  signal: AbortSignal,
) {
  return {
    file: new Blob([new Uint8Array([1, 2, 3, 4])]),
    sizeBytes: 4,
    mimeType: "application/octet-stream",
    scope: SCOPE,
    signal,
    send,
  };
}

describe("uploadChatAttachmentInParts", () => {
  it("releases the staged slot it is abandoning when the caller cancels", async () => {
    const controller = new AbortController();
    const requests: { action: string | null; query: URLSearchParams }[] = [];
    const send = async (
      request: ChatAttachmentUploadRequest,
    ): Promise<ChatAttachmentUploadResponse> => {
      const url = new URL(request.url, "http://localhost");
      requests.push({ action: url.searchParams.get("action"), query: url.searchParams });
      if (url.searchParams.get("action") === "part") {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
      return { status: 200, body: { uploadId: UPLOAD_ID, partBytes: 2 } };
    };

    await expect(
      uploadChatAttachmentInParts(uploadParams(send, controller.signal)),
    ).rejects.toThrow(/aborted/i);

    // The Gateway is told to drop the half-sent upload instead of holding its
    // staging slot for the one-hour expiry.
    await vi.waitFor(() => expect(requests.map((request) => request.action)).toContain("discard"));
    const discard = requests.find((request) => request.action === "discard");
    expect(discard?.query.get("uploadId")).toBe(UPLOAD_ID);
    expect(discard?.query.get("sessionKey")).toBe(SCOPE.sessionKey);
    expect(discard?.query.get("agentId")).toBe(SCOPE.agentId);
    expect(requests.filter((request) => request.action === "commit")).toHaveLength(0);
  });

  it("keeps the caller's cancellation when the release request itself fails", async () => {
    const controller = new AbortController();
    const send = vi.fn(
      async (request: ChatAttachmentUploadRequest): Promise<ChatAttachmentUploadResponse> => {
        const action = actionOf(request);
        if (action === "part") {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
        if (action === "discard") {
          throw new Error("release endpoint unreachable");
        }
        return { status: 200, body: { uploadId: UPLOAD_ID, partBytes: 2 } };
      },
    );

    // A failed release stays silent: the caller sees only its own cancellation,
    // and the Gateway still drops an interrupted part stream on its own.
    await expect(
      uploadChatAttachmentInParts(uploadParams(send, controller.signal)),
    ).rejects.toThrow(/aborted/i);
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([request]) => actionOf(request) === "discard")).toBe(true),
    );
  });

  it("resumes a lost part from the confirmed offset without releasing the upload", async () => {
    const actions: string[] = [];
    let partAttempts = 0;
    const offsets: (string | null)[] = [];
    const send = async (
      request: ChatAttachmentUploadRequest,
    ): Promise<ChatAttachmentUploadResponse> => {
      const url = new URL(request.url, "http://localhost");
      const action = url.searchParams.get("action");
      actions.push(action ?? "");
      if (action === "begin") {
        return { status: 200, body: { uploadId: UPLOAD_ID, partBytes: 2 } };
      }
      if (action === "part") {
        partAttempts += 1;
        offsets.push(url.searchParams.get("offset"));
        // The first part's response was lost after the Gateway confirmed it.
        return partAttempts === 1
          ? {
              status: 409,
              body: {
                error: { code: "offset-mismatch", message: "offset mismatch", receivedBytes: 2 },
              },
            }
          : { status: 200, body: { uploadId: UPLOAD_ID, receivedBytes: 4 } };
      }
      return {
        status: 200,
        body: { uploadId: UPLOAD_ID, sizeBytes: 4, mimeType: "application/octet-stream" },
      };
    };

    const staged = await uploadChatAttachmentInParts(
      uploadParams(send, new AbortController().signal),
    );

    expect(staged.uploadId).toBe(UPLOAD_ID);
    expect(offsets).toEqual(["0", "2"]);
    // A resumable part keeps the staged upload; only an abandoned one is released.
    expect(actions).toEqual(["begin", "part", "part", "commit"]);
  });
});
