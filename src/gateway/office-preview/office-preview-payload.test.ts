import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/artifacts.js";
import { OFFICE_PREVIEW_MAX_BYTES } from "./office-preview-limits.js";
import { buildOfficePreviewPayload } from "./office-preview-payload.js";
import { buildDocxFixture, buildXlsxFixture } from "./office-preview.test-support.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared Office preview payload", () => {
  it("reuses the Office parser for a workbook", async () => {
    const buffer = await buildXlsxFixture();
    const preview = await buildOfficePreviewPayload({
      filename: "budget.xlsx",
      mimeType: XLSX_MIME,
      sizeBytes: buffer.length,
      read: async () => buffer,
    });

    expect(preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    expect(preview?.preview?.sheets?.[0]?.rows[1]).toEqual(["Rent", "1200"]);
    expect(Value.Check(ArtifactOfficePreviewSchema, preview)).toBe(true);
  });

  it("selects the document reader from the MIME type when the name is generic", async () => {
    const buffer = await buildDocxFixture();
    const preview = await buildOfficePreviewPayload({
      filename: "download",
      mimeType: DOCX_MIME,
      read: async () => buffer,
    });

    expect(preview).toMatchObject({ kind: "office", format: "docx", state: "ready" });
    expect(preview?.preview?.blocks?.[0]?.text).toBe("Quarterly report");
    expect(Value.Check(ArtifactOfficePreviewSchema, preview)).toBe(true);
  });

  it("reports legacy containers without parsing them", async () => {
    const read = vi.fn();
    const preview = await buildOfficePreviewPayload({
      filename: "ledger.xls",
      mimeType: "application/vnd.ms-excel",
      read,
    });

    expect(preview).toEqual({ kind: "office", state: "unsupported" });
    expect(read).not.toHaveBeenCalled();
    expect(Value.Check(ArtifactOfficePreviewSchema, preview)).toBe(true);
  });

  it("reports a declared size over the 8 MiB cap without reading", async () => {
    const read = vi.fn();
    const preview = await buildOfficePreviewPayload({
      filename: "huge.xlsx",
      mimeType: XLSX_MIME,
      sizeBytes: OFFICE_PREVIEW_MAX_BYTES + 1,
      read,
    });

    expect(preview).toEqual({ kind: "office", format: "xlsx", state: "too-large" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects renamed or corrupt packages without a fake preview", async () => {
    const renamed = await buildOfficePreviewPayload({
      filename: "report.docx",
      mimeType: DOCX_MIME,
      read: async () => Buffer.from("this is not a package"),
    });
    const corrupt = await buildOfficePreviewPayload({
      filename: "report.docx",
      mimeType: DOCX_MIME,
      read: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]),
    });

    expect(renamed).toEqual({ kind: "office", format: "docx", state: "invalid" });
    expect(corrupt).toEqual({ kind: "office", format: "docx", state: "invalid" });
  });

  it("leaves non-Office files on their existing preview path", async () => {
    const preview = await buildOfficePreviewPayload({
      filename: "report.pdf",
      mimeType: "application/pdf",
      read: async () => Buffer.from("%PDF-1.4"),
    });

    expect(preview).toBeUndefined();
  });
});
