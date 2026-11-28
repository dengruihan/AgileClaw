import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFICE_PREVIEW_CACHE_IDLE_TTL_MS,
  OFFICE_PREVIEW_CACHE_MAX_ENTRIES,
  OFFICE_PREVIEW_MAX_BYTES,
} from "./office-preview-limits.js";

const hoisted = vi.hoisted(() => ({
  convert: vi.fn(),
}));

vi.mock("./office-preview-convert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./office-preview-convert.js")>()),
  convertOfficeDocumentToPdf: hoisted.convert,
}));

import type { OfficePreviewSource } from "./office-preview.js";

const { buildOfficePreviewPayload, resolveOfficePreviewFamily, resolveOfficePreviewTarget } =
  await import("./office-preview.js");
const { officePreviewCacheKey, readCachedOfficePdf, storeCachedOfficePdf } =
  await import("./office-preview-cache.js");

let sequence = 0;
function uniqueDocxBytes(): Buffer {
  sequence += 1;
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`synthetic-source-${sequence}`),
  ]);
}

function source(bytes: Buffer, filename = "budget.docx", extra: Partial<OfficePreviewSource> = {}) {
  let reads = 0;
  return {
    payloadSource: {
      filename,
      mimeType: DOCX_MIME,
      sizeBytes: bytes.length,
      read: async () => {
        reads += 1;
        return bytes;
      },
      ...extra,
    } satisfies OfficePreviewSource,
    reads: () => reads,
  };
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pdf = Buffer.from("%PDF-1.7\npreview");

afterEach(() => {
  hoisted.convert.mockReset();
});

describe("Office preview family detection", () => {
  it.each([
    ["report.docx", "docx"],
    ["budget.XLSX", "xlsx"],
    ["deck.pptx", "pptx"],
  ] as const)("maps %s to %s", (filename, format) => {
    expect(resolveOfficePreviewTarget(filename)?.format).toBe(format);
  });

  it("keeps legacy binary Office families separate from modern packages", () => {
    expect(resolveOfficePreviewTarget("ledger.xls")).toEqual({
      kind: "legacy",
      mimeType: "application/vnd.ms-excel",
    });
    expect(resolveOfficePreviewFamily({ filename: "ledger.xls" })).toEqual({
      legacy: true,
      office: true,
    });
    expect(resolveOfficePreviewFamily({ filename: "notes.txt" })).toEqual({
      legacy: false,
      office: false,
    });
  });

  it("recognizes a modern package from its MIME type without a filename", () => {
    expect(
      resolveOfficePreviewFamily({
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation; charset=binary",
      }),
    ).toEqual({ format: "pptx", legacy: false, office: true });
  });
});

describe("buildOfficePreviewPayload", () => {
  it("returns the converted PDF with its declared size", async () => {
    const bytes = uniqueDocxBytes();
    hoisted.convert.mockResolvedValue({ pdf });
    const { payloadSource } = source(bytes, "budget");

    const preview = await buildOfficePreviewPayload(payloadSource);

    expect(preview).toEqual({
      kind: "office",
      format: "docx",
      state: "ready",
      pdf: {
        mimeType: "application/pdf",
        data: pdf.toString("base64"),
        sizeBytes: pdf.byteLength,
      },
    });
    // A display title without an extension still reaches LibreOffice's filter.
    expect(hoisted.convert).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "budget.docx", bytes }),
    );
  });

  it("reports an encrypted package without calling the converter", async () => {
    const encrypted = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("EncryptedPackage", "utf16le"),
    ]);
    const { payloadSource } = source(encrypted, "secret.docx", { sizeBytes: encrypted.length });

    expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
      kind: "office",
      format: "docx",
      state: "password-protected",
    });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("reports non-package bytes as invalid without calling the converter", async () => {
    const bytes = Buffer.from("not a zip package");
    const { payloadSource } = source(bytes, "broken.docx");

    expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
      kind: "office",
      format: "docx",
      state: "invalid",
    });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("refuses an oversized declared source before reading it", async () => {
    const bytes = uniqueDocxBytes();
    const { payloadSource, reads } = source(bytes, "budget.docx", {
      sizeBytes: OFFICE_PREVIEW_MAX_BYTES + 1,
    });

    expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
      kind: "office",
      format: "docx",
      state: "too-large",
    });
    expect(reads()).toBe(0);
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("refuses an oversized read source", async () => {
    const bytes = Buffer.alloc(OFFICE_PREVIEW_MAX_BYTES + 1, 0x50);
    bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
    const { payloadSource } = source(bytes, "budget.docx", { sizeBytes: undefined });

    expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
      kind: "office",
      format: "docx",
      state: "too-large",
    });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "failed", "too-large"] as const)(
    "maps a %s conversion onto the same visible state",
    async (failure) => {
      hoisted.convert.mockResolvedValue({ failure });
      const { payloadSource } = source(uniqueDocxBytes());

      expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
        kind: "office",
        format: "docx",
        state: failure,
      });
    },
  );

  it("keeps legacy OLE containers metadata-only", async () => {
    const { payloadSource } = source(Buffer.from("legacy"), "ledger.xls", {
      mimeType: undefined,
    });

    expect(await buildOfficePreviewPayload(payloadSource)).toEqual({
      kind: "office",
      state: "unsupported",
    });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("leaves non-Office files to their existing preview path", async () => {
    const { payloadSource } = source(Buffer.from("plain"), "notes.txt", {
      mimeType: undefined,
    });

    expect(await buildOfficePreviewPayload(payloadSource)).toBeUndefined();
  });
});

describe("converted-PDF cache", () => {
  it("serves the second open of identical bytes from cache", async () => {
    hoisted.convert.mockResolvedValue({ pdf });
    const bytes = uniqueDocxBytes();

    expect((await buildOfficePreviewPayload(source(bytes).payloadSource))?.state).toBe("ready");
    expect((await buildOfficePreviewPayload(source(bytes).payloadSource))?.state).toBe("ready");

    expect(hoisted.convert).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent conversions of the same bytes into one job", async () => {
    let release: ((result: { pdf: Buffer }) => void) | undefined;
    hoisted.convert.mockImplementation(
      () =>
        new Promise<{ pdf: Buffer }>((resolve) => {
          release = resolve;
        }),
    );
    const bytes = uniqueDocxBytes();

    const first = buildOfficePreviewPayload(source(bytes).payloadSource);
    const second = buildOfficePreviewPayload(source(bytes).payloadSource);
    await vi.waitFor(() => expect(hoisted.convert).toHaveBeenCalledOnce());
    release?.({ pdf });

    expect((await first)?.state).toBe("ready");
    expect((await second)?.state).toBe("ready");
    expect(hoisted.convert).toHaveBeenCalledOnce();
  });

  it("expires an idle entry after the cache lifetime", () => {
    const key = `idle-${String(sequence)}`;
    storeCachedOfficePdf(key, pdf, 1_000);

    expect(readCachedOfficePdf(key, 1_000 + OFFICE_PREVIEW_CACHE_IDLE_TTL_MS)).toBeUndefined();
  });

  it("refreshes the idle lifetime on every hit", () => {
    const key = `refresh-${String(sequence)}`;
    storeCachedOfficePdf(key, pdf, 0);
    // A hit just before expiry extends the entry by another full lifetime.
    expect(readCachedOfficePdf(key, OFFICE_PREVIEW_CACHE_IDLE_TTL_MS - 1)).toBe(pdf);

    expect(readCachedOfficePdf(key, OFFICE_PREVIEW_CACHE_IDLE_TTL_MS + 1)).toBe(pdf);
    // The extension lands at (TTL + 1) + TTL; one millisecond later it is gone.
    expect(readCachedOfficePdf(key, OFFICE_PREVIEW_CACHE_IDLE_TTL_MS * 2 + 2)).toBeUndefined();
  });

  it("evicts the least recently used preview beyond the entry cap", () => {
    const now = 10_000;
    const keys = Array.from(
      { length: OFFICE_PREVIEW_CACHE_MAX_ENTRIES + 1 },
      (_unused, index) => `capacity-${String(index)}-${String(sequence)}`,
    );
    for (const key of keys) {
      storeCachedOfficePdf(key, pdf, now);
    }

    expect(readCachedOfficePdf(keys[0]!, now)).toBeUndefined();
    expect(readCachedOfficePdf(keys.at(-1)!, now)).toBe(pdf);
  });

  it("keys entries by source bytes and converter generation only", () => {
    const bytes = uniqueDocxBytes();

    expect(officePreviewCacheKey(bytes)).toBe(officePreviewCacheKey(Buffer.from(bytes)));
    expect(officePreviewCacheKey(bytes)).toMatch(/^gotenberg-9-libreoffice:[0-9a-f]{64}$/u);
  });
});
