// @vitest-environment jsdom
// Direct-read lifecycle: one slot's Remove must cancel only that transfer, and a
// transport that finishes after removal must never re-add the attachment.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { ChatAttachmentReadLifecycle, readChatAttachmentFile } from "./chat-attachment-reads.ts";

const uploadMocks = vi.hoisted(() => ({
  stageChatAttachment: vi.fn(),
}));

vi.mock("./chat-attachment-upload.ts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, stageChatAttachment: uploadMocks.stageChatAttachment };
});

const MB = 1024 * 1024;
// One-frame budget of 1 byte forces the direct-upload path for any real file.
const limits = { maxBytes: 1024 * MB, maxImageBytes: 6 * MB, maxBatchBytes: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Destination = {
  attachments: ChatAttachment[];
  changes: ChatAttachment[][];
  pending: number[];
};

function makeDestination(): Destination {
  return { attachments: [], changes: [], pending: [] };
}

beforeEach(() => {
  uploadMocks.stageChatAttachment.mockReset();
});

describe("direct attachment read lifecycle", () => {
  it("aborts the slot's own transfer and never re-adds it after completion", async () => {
    const upload = deferred<{ uploadId: string; sizeBytes: number; mimeType: string }>();
    const signals: AbortSignal[] = [];
    uploadMocks.stageChatAttachment.mockImplementation(async (params: { signal: AbortSignal }) => {
      signals.push(params.signal);
      return await upload.promise;
    });
    const destination = makeDestination();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const file = new File([new Uint8Array([1, 2, 3, 4])], "seminar.mp4", { type: "video/mp4" });
    const [entry] = reads.begin([file], destination.attachments, {
      getAttachments: () => destination.attachments,
      onAttachmentsChange: (next) => {
        destination.attachments = next;
        destination.changes.push(next);
      },
      onPendingReadsChange: (delta) => {
        destination.pending.push(delta);
        reads.updatePending(reads.readSignal, delta);
      },
    });
    readChatAttachmentFile(file, entry!, reads, {
      readSignal: reads.readSignal,
      attachmentLimits: limits,
      attachmentUpload: { basePath: "", sessionKey: "agent:main:main", agentId: "main" },
    });

    expect(reads.pendingReads).toBe(1);
    const signal = signals[0]!;
    expect(signal.aborted).toBe(false);

    // The user removes exactly this slot while its part is still in flight.
    reads.remove(entry!);
    expect(signal.aborted).toBe(true);
    expect(reads.pendingReads).toBe(0);
    expect(destination.changes).toEqual([]);

    // Even a transport that ignores the abort cannot publish the attachment.
    upload.resolve({
      uploadId: "9c1f0d1e-0000-4000-8000-000000000010",
      sizeBytes: 1,
      mimeType: "video/mp4",
    });
    await upload.promise;
    await Promise.resolve();
    expect(destination.attachments).toEqual([]);
    expect(destination.changes).toEqual([]);
    expect(reads.pendingReads).toBe(0);
  });

  it("cancels every direct read when the composer scope aborts", async () => {
    const upload = deferred<{ uploadId: string; sizeBytes: number; mimeType: string }>();
    const signals: AbortSignal[] = [];
    uploadMocks.stageChatAttachment.mockImplementation(async (params: { signal: AbortSignal }) => {
      signals.push(params.signal);
      return await upload.promise;
    });
    const destination = makeDestination();
    const reads = new ChatAttachmentReadLifecycle(() => {});
    const file = new File([new Uint8Array([1, 2, 3, 4])], "archive.zip", {
      type: "application/zip",
    });
    const [entry] = reads.begin([file], destination.attachments, {
      getAttachments: () => destination.attachments,
      onAttachmentsChange: (next) => {
        destination.attachments = next;
        destination.changes.push(next);
      },
      onPendingReadsChange: (delta) => {
        destination.pending.push(delta);
        reads.updatePending(reads.readSignal, delta);
      },
    });
    readChatAttachmentFile(file, entry!, reads, {
      readSignal: reads.readSignal,
      attachmentLimits: limits,
      attachmentUpload: { basePath: "" },
    });
    reads.abortReads();
    expect(signals[0]!.aborted).toBe(true);
    expect(reads.pendingReads).toBe(0);
    upload.resolve({
      uploadId: "9c1f0d1e-0000-4000-8000-000000000011",
      sizeBytes: 1,
      mimeType: "application/zip",
    });
    await upload.promise;
    await Promise.resolve();
    expect(destination.attachments).toEqual([]);
  });
});
