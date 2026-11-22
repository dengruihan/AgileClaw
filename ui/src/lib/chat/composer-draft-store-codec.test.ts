// Durable draft codec: a direct upload persists a reference, not the bytes, so
// the codec must accept reference-only attachments (and mixed batches) without
// discarding the whole draft on the next reload.
import { describe, expect, it } from "vitest";
import {
  captureDurableChatAttachments,
  hydrateDurableComposerAttachments,
} from "../../pages/chat/durable-composer-persistence.ts";
import { parseStoredDraft } from "./composer-draft-store-codec.ts";

const UPLOAD_ID = "9c1f0d1e-0000-4000-8000-000000000021";

function storedDraft(attachments: unknown[]) {
  return {
    key: "chat:v4:agent:main:main",
    ownerKey: "[]",
    gatewayOwner: "default",
    recoveryScope: "owner-1",
    scopeKey: "chat:v4:agent:main:main",
    updatedAt: 1,
    writeId: "write-1",
    text: "attached notes",
    revision: 3,
    attachments,
  };
}

describe("parseStoredDraft attachments", () => {
  it("keeps a reference-only direct upload and the draft text", () => {
    const parsed = parseStoredDraft(
      storedDraft([
        { uploadId: UPLOAD_ID, mimeType: "application/pdf", fileName: "big.pdf", sizeBytes: 900 },
      ]),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.text).toBe("attached notes");
    expect(parsed?.attachments).toEqual([
      { uploadId: UPLOAD_ID, mimeType: "application/pdf", fileName: "big.pdf", sizeBytes: 900 },
    ]);
  });

  it("keeps a mixed inline and direct batch", () => {
    const parsed = parseStoredDraft(
      storedDraft([
        { blob: new Blob(["inline"], { type: "text/plain" }), mimeType: "text/plain" },
        { uploadId: UPLOAD_ID, mimeType: "application/zip", origin: "file" },
      ]),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.attachments).toHaveLength(2);
    expect(parsed?.attachments[1]).toMatchObject({ uploadId: UPLOAD_ID, origin: "file" });
  });

  it.each([
    { uploadId: "", mimeType: "text/plain" },
    { uploadId: 42, mimeType: "text/plain" },
    { mimeType: "text/plain" },
    { uploadId: UPLOAD_ID },
    { uploadId: UPLOAD_ID, mimeType: "text/plain", sizeBytes: Number.NaN },
  ])("rejects a malformed attachment shape %#", (attachment) => {
    expect(parseStoredDraft(storedDraft([attachment]))).toBeNull();
  });
});

describe("direct upload draft round-trip", () => {
  it("captures a reference without reading bytes and hydrates it back", async () => {
    const stored = captureDurableChatAttachments([
      {
        id: "staged",
        mimeType: "application/pdf",
        fileName: "big.pdf",
        sizeBytes: 900,
        uploadId: UPLOAD_ID,
      },
    ]);
    expect(stored).toEqual([
      { uploadId: UPLOAD_ID, mimeType: "application/pdf", fileName: "big.pdf", sizeBytes: 900 },
    ]);
    expect(parseStoredDraft(storedDraft(stored))).not.toBeNull();

    const restored = await hydrateDurableComposerAttachments(stored!);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      uploadId: UPLOAD_ID,
      mimeType: "application/pdf",
      fileName: "big.pdf",
      sizeBytes: 900,
    });
    // No local bytes exist for a reference-only attachment.
    expect(restored[0]?.dataUrl).toBeUndefined();
  });
});
