import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionFileOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { parseOfficePreviewBuffer } from "./office-preview-parse.js";
import {
  buildDocxFixture,
  buildPptxFixture,
  buildSlideXml,
  buildXlsxFixture,
} from "./office-preview.test-support.js";

function expectValidPreview(preview: unknown) {
  expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
}

describe("parseOfficePreviewBuffer", () => {
  it("reads workbook sheets, shared strings, inline strings, numbers, and booleans", async () => {
    const preview = parseOfficePreviewBuffer(await buildXlsxFixture(), "xlsx");
    expectValidPreview(preview);
    expect(preview).toMatchObject({ format: "xlsx" });
    expect(preview?.sheets?.map((sheet) => sheet.name)).toEqual(["Budget", "Notes"]);
    const budget = preview?.sheets?.[0];
    expect(budget?.rows).toEqual([
      ["Item", "Cost"],
      ["Rent", "1200"],
      ["0.5", "", "TRUE"],
    ]);
    expect(budget?.rowNumbers).toEqual([1, 2, 3]);
    expect(budget?.rowCount).toBe(3);
    expect(budget?.columnCount).toBe(3);
    expect(preview?.sheets?.[1]?.rows).toEqual([["Hello "]]);
  });

  it("keeps real row numbers for sparse worksheets", async () => {
    const sheetDataXml =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>third</t></is></c></row>';
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({
        sheets: [{ name: "Sparse", sheetDataXml }],
        sharedStrings: [],
      }),
      "xlsx",
    );

    expectValidPreview(preview);
    const sheet = preview?.sheets?.[0];
    expect(sheet?.rows).toEqual([["first"], ["third"]]);
    expect(sheet?.rowNumbers).toEqual([1, 3]);
    expect(sheet?.rowCount).toBe(3);
    expect(sheet?.truncated).toBeUndefined();
  });

  it("bounds rows by the rendered count even when every row repeats r=1", async () => {
    const sheetDataXml = Array.from(
      { length: 201 },
      (_, index) => `<row r="1"><c r="A1"><v>${index}</v></c></row>`,
    ).join("");
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({ sheets: [{ name: "Bogus", sheetDataXml }], sharedStrings: [] }),
      "xlsx",
    );

    expectValidPreview(preview);
    const sheet = preview?.sheets?.[0];
    expect(sheet?.rows).toHaveLength(200);
    // Duplicate declarations are repaired monotonically, so labels stay distinct.
    expect(sheet?.rowNumbers?.[0]).toBe(1);
    expect(sheet?.rowNumbers?.[199]).toBe(200);
    expect(sheet?.truncated).toBe(true);
    expect(preview?.truncated).toBe(true);
  });

  it("rejects overlong column references instead of overflowing the payload", async () => {
    const overlong = "A".repeat(400);
    const sheetDataXml =
      `<row r="1"><c r="${overlong}1"><v>1</v></c><c r="B1"><v>2</v></c></row>` +
      '<row r="2"><c r="XFD2"><v>3</v></c></row>';
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({ sheets: [{ name: "Columns", sheetDataXml }], sharedStrings: [] }),
      "xlsx",
    );

    expectValidPreview(preview);
    const sheet = preview?.sheets?.[0];
    // The malformed reference resolves to no column and falls back to position.
    expect(sheet?.rows[0]).toEqual(["1", "2"]);
    expect(sheet?.columnCount).toBe(16_384);
    expect(Number.isSafeInteger(sheet?.columnCount)).toBe(true);
    // The wire format is JSON, which would turn a non-finite value into null.
    const serialized = JSON.stringify(preview);
    expect(serialized).toContain('"columnCount":16384');
    expect(serialized).not.toContain('"columnCount":null');
  });

  it("keeps headings, paragraph runs, and list items for documents", async () => {
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(), "docx");
    expectValidPreview(preview);
    expect(preview?.blocks).toEqual([
      { kind: "heading", level: 1, text: "Quarterly report" },
      { kind: "paragraph", text: "Revenue grew\ta lot" },
      { kind: "listItem", text: "First point" },
    ]);
  });

  it("orders slides by the presentation slide list and splits the title", async () => {
    const preview = parseOfficePreviewBuffer(await buildPptxFixture(), "pptx");
    expectValidPreview(preview);
    expect(preview?.slides).toEqual([
      { index: 1, title: "Roadmap", lines: ["Ship previews", "Measure adoption"] },
      { index: 2, title: "Risks", lines: ["Large workbooks"] },
    ]);
  });

  it("reports every per-slide cut in the preview-level truncated flag", async () => {
    const manyLines = Array.from({ length: 81 }, (_, index) => `line ${index + 1}`);
    const longLine = "x".repeat(2_001);
    const longTitle = "t".repeat(600);
    const preview = parseOfficePreviewBuffer(
      await buildPptxFixture([
        { title: "Many lines", lines: manyLines },
        { title: "Long line", lines: [longLine] },
        { title: longTitle, lines: ["Short"] },
      ]),
      "pptx",
    );

    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.lines).toHaveLength(80);
    expect(preview?.slides?.[1]?.lines?.[0]).toHaveLength(2_000);
    expect(preview?.slides?.[2]?.title).toHaveLength(512);
    expect(preview?.truncated).toBe(true);
  });

  it("keeps empty packages renderable instead of failing", async () => {
    const workbook = parseOfficePreviewBuffer(await buildXlsxFixture({ sheets: [] }), "xlsx");
    expectValidPreview(workbook);
    expect(workbook).toEqual({ format: "xlsx", sheets: [] });
    const document = parseOfficePreviewBuffer(await buildDocxFixture(""), "docx");
    expectValidPreview(document);
    expect(document).toEqual({ format: "docx", blocks: [] });
  });

  it("truncates a sheet once the row limit is exceeded", async () => {
    const rows = Array.from({ length: 260 }, (_, index) => [
      { column: "A", value: `row ${index}` },
    ]);
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({ sheets: [{ name: "Long", rows }], sharedStrings: [] }),
      "xlsx",
    );
    const sheet = preview?.sheets?.[0];
    expectValidPreview(preview);
    expect(sheet?.rows).toHaveLength(200);
    expect(sheet?.rowCount).toBe(260);
    expect(sheet?.truncated).toBe(true);
    expect(preview?.truncated).toBe(true);
  });

  it("caps the number of rendered sheets", async () => {
    const sheets = Array.from({ length: 24 }, (_, index) => ({
      name: `Sheet ${index + 1}`,
      rows: [[{ column: "A", value: "x" }]],
    }));
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({ sheets, sharedStrings: [] }),
      "xlsx",
    );
    expectValidPreview(preview);
    expect(preview?.sheets).toHaveLength(20);
    expect(preview?.truncated).toBe(true);
  });

  it("returns null for corrupt, non-zip, and wrong-format buffers", async () => {
    expect(parseOfficePreviewBuffer(Buffer.from("not a zip"), "xlsx")).toBeNull();
    const xlsx = await buildXlsxFixture();
    expect(parseOfficePreviewBuffer(xlsx.subarray(0, 40), "xlsx")).toBeNull();
    // A workbook package has no word/document.xml, so the docx reader refuses it.
    expect(parseOfficePreviewBuffer(xlsx, "docx")).toBeNull();
  });

  it("never reads workbook parts behind external relationships", async () => {
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({
        sheets: [{ name: "Budget", rows: [[{ column: "A", value: "1" }]] }],
        sharedStrings: [],
        linkedSheets: [{ name: "External", relationshipId: "rIdExternal" }],
        workbookRelationships: [
          {
            id: "rIdExternal",
            target: "/hidden/secret-sheet.xml",
            targetMode: "External",
          },
          {
            id: "rIdEscape",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
            target: "../../../etc/passwd",
          },
        ],
        extraParts: [
          {
            path: "hidden/secret-sheet.xml",
            // Would parse as a worksheet with a visible marker if it were read.
            content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>EXTERNAL_WORKBOOK_SECRET</t></is></c></row></sheetData></worksheet>`,
          },
        ],
      }),
      "xlsx",
    );

    expectValidPreview(preview);
    expect(preview?.sheets?.map((sheet) => sheet.name)).toEqual(["Budget", "External"]);
    const external = preview?.sheets?.[1];
    expect(external?.rows).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("EXTERNAL_WORKBOOK_SECRET");
  });

  it("never reads slide parts behind external relationships", async () => {
    const preview = parseOfficePreviewBuffer(
      await buildPptxFixture([{ title: "Roadmap", lines: ["Ship"] }], {
        // The slide list points directly at an in-package part marked
        // TargetMode="External". If the relationship filter disappeared, the
        // secret would resolve and the assertions below would fail.
        linkedSlides: [{ id: 999, relationshipId: "rIdSecret" }],
        presentationRelationships: [
          {
            id: "rIdSecret",
            type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
            target: "/hidden/secret-slide.xml",
            targetMode: "External",
          },
        ],
        extraParts: [
          {
            path: "hidden/secret-slide.xml",
            content: buildSlideXml("EXTERNAL_SLIDE_SECRET", ["EXTERNAL_SLIDE_SECRET"]),
          },
        ],
      }),
      "pptx",
    );

    expectValidPreview(preview);
    expect(preview?.slides).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain("EXTERNAL_SLIDE_SECRET");
  });
});
