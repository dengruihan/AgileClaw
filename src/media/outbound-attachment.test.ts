// Outbound attachment tests cover media loading rules for outgoing messages.
import { afterEach, describe, expect, it, vi } from "vitest";

const loadWebMedia = vi.hoisted(() => vi.fn());
const saveMediaBuffer = vi.hoisted(() => vi.fn());

vi.mock("./web-media.js", () => ({
  loadWebMedia,
}));

vi.mock("./store.js", () => ({
  saveMediaBuffer,
}));

const { resolveOutboundAttachmentFromBuffer, resolveOutboundAttachmentFromUrl } =
  await import("./outbound-attachment.js");

afterEach(() => vi.clearAllMocks());

describe("resolveOutboundAttachmentFromUrl", () => {
  it("preserves the loaded file name when staging outbound media", async () => {
    const buffer = Buffer.from("pdf");
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/report---uuid.pdf",
      contentType: "application/pdf",
    });

    await resolveOutboundAttachmentFromUrl("./report.pdf", 1024);

    expect(loadWebMedia).toHaveBeenCalledWith(
      "./report.pdf",
      expect.objectContaining({ documentFallback: true }),
    );
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      buffer,
      "application/pdf",
      "outbound",
      1024,
      "report.pdf",
      undefined,
      { preserveContentType: false },
    );
  });

  it("pins a loader-classified generic document through staging", async () => {
    const buffer = Buffer.from([0, 1, 2, 3]);
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "application/octet-stream",
      fileName: "broken.mp3",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/broken---uuid.mp3",
      contentType: "application/octet-stream",
    });

    await resolveOutboundAttachmentFromUrl("/tmp/workspace/broken.mp3", 1024);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      buffer,
      "application/octet-stream",
      "outbound",
      1024,
      "broken.mp3",
      undefined,
      { preserveContentType: true },
    );
  });

  it("stages HTML through the same attachment path without a preview failure", async () => {
    const buffer = Buffer.from("<!doctype html><title>report</title>");
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "text/html",
      fileName: "report.html",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/report---uuid.html",
      contentType: "text/html",
    });

    const result = await resolveOutboundAttachmentFromUrl("/tmp/workspace/report.html", 1024);

    expect(result).toEqual({
      path: "/tmp/media/outbound/report---uuid.html",
      contentType: "text/html",
    });
  });
});

describe("resolveOutboundAttachmentFromBuffer", () => {
  it.each([undefined, () => {}])(
    "stages outbound buffers with metadata and an optional publication guard (%s)",
    async (assertCommitAllowed) => {
      const buffer = Buffer.from("hello");
      saveMediaBuffer.mockResolvedValueOnce({
        path: "/tmp/media/outbound/note---uuid.txt",
        contentType: "text/plain",
      });

      const result = await resolveOutboundAttachmentFromBuffer(buffer, 1024, {
        contentType: "text/plain",
        filename: "note.txt",
        assertCommitAllowed,
      });

      expect(saveMediaBuffer).toHaveBeenCalledWith(
        buffer,
        "text/plain",
        "outbound",
        1024,
        "note.txt",
        undefined,
        assertCommitAllowed ? { assertCommitAllowed } : undefined,
      );
      expect(result).toEqual({
        path: "/tmp/media/outbound/note---uuid.txt",
        contentType: "text/plain",
      });
    },
  );
});
