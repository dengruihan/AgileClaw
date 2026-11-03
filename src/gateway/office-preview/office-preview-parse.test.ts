import { describe, expect, it } from "vitest";
import { parseOfficePreviewBuffer } from "./office-preview-parse.js";
import {
  buildDocxFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "./office-preview.test-support.js";

describe("parseOfficePreviewBuffer", () => {
  it("reads workbook sheets, shared strings, inline strings, numbers, and booleans", async () => {
    const preview = parseOfficePreviewBuffer(await buildXlsxFixture(), "xlsx");
    expect(preview).toMatchObject({ format: "xlsx" });
    expect(preview?.sheets?.map((sheet) => sheet.name)).toEqual(["Budget", "Notes"]);
    const budget = preview?.sheets?.[0];
    expect(budget?.rows).toEqual([
      ["Item", "Cost"],
      ["Rent", "1200"],
      ["0.5", "", "TRUE"],
    ]);
    expect(budget?.rowCount).toBe(3);
    expect(budget?.columnCount).toBe(3);
    expect(preview?.sheets?.[1]?.rows).toEqual([["Hello "]]);
  });

  it("keeps headings, paragraph runs, and list items for documents", async () => {
    const preview = parseOfficePreviewBuffer(await buildDocxFixture(), "docx");
    expect(preview?.blocks).toEqual([
      { kind: "heading", level: 1, text: "Quarterly report" },
      { kind: "paragraph", text: "Revenue grew\ta lot" },
      { kind: "listItem", text: "First point" },
    ]);
  });

  it("orders slides by the presentation slide list and splits the title", async () => {
    const preview = parseOfficePreviewBuffer(await buildPptxFixture(), "pptx");
    expect(preview?.slides).toEqual([
      { index: 1, title: "Roadmap", lines: ["Ship previews", "Measure adoption"] },
      { index: 2, title: "Risks", lines: ["Large workbooks"] },
    ]);
  });

  it("keeps empty packages renderable instead of failing", async () => {
    const preview = parseOfficePreviewBuffer(await buildXlsxFixture({ sheets: [] }), "xlsx");
    expect(preview).toEqual({ format: "xlsx", sheets: [] });
    expect(parseOfficePreviewBuffer(await buildDocxFixture(""), "docx")).toEqual({
      format: "docx",
      blocks: [],
    });
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

  it("never resolves external relationship targets", async () => {
    const docx = await buildDocxFixture(
      `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>External link</w:t></w:r></w:hyperlink></w:p>`,
    );
    const preview = parseOfficePreviewBuffer(docx, "docx");
    expect(preview?.blocks).toEqual([{ kind: "paragraph", text: "External link" }]);
  });
});
