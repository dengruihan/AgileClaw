import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionFileOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/office-preview.js";
import { parseOfficePreviewBuffer } from "./office-preview-parse.js";
import { formatSpreadsheetCellValue } from "./office-preview-xlsx-format.js";
import { buildStyledXlsxFixture, buildXlsxFixture } from "./office-preview.test-support.js";

function value(raw: string, formatCode: string | undefined, date1904 = false): string {
  return formatSpreadsheetCellValue({ raw, type: undefined, formatCode, date1904 });
}

describe("spreadsheet value formatting", () => {
  it("formats currency, percentages, and grouped numbers without evaluating formulas", () => {
    expect(value("1200.5", "$#,##0.00")).toBe("$1,200.50");
    expect(value("-1200.5", "$#,##0.00")).toBe("-$1,200.50");
    expect(value("-1200.5", "#,##0.00;(#,##0.00)")).toBe("(1,200.50)");
    expect(value("1200", "#,##0")).toBe("1,200");
    expect(value("0.5", "0%")).toBe("50%");
    expect(value("0.125", "0.00%")).toBe("12.50%");
    expect(value("3.14159", "0.0")).toBe("3.1");
    // Optional fraction placeholders drop trailing zeros and orphan points.
    expect(value("1.2", "0.##")).toBe("1.2");
    expect(value("1", "0.##")).toBe("1");
    expect(value("1.234", "0.##")).toBe("1.23");
    expect(value("0.05", "0.##")).toBe("0.05");
    expect(value("1", "0.0#")).toBe("1.0");
    expect(value("1.25", "0.0#")).toBe("1.25");
    expect(value("1200.5", "#,##0.##")).toBe("1,200.5");
    expect(value("12345", "0.00E+00")).toBe("1.23E+04");
    expect(value("1200.5", "General")).toBe("1200.5");
    // Binary floating-point noise is hidden the way Excel's General format does.
    expect(value("0.30000000000000004", "General")).toBe("0.3");
  });

  it("converts serial dates with the 1900 leap-day and 1904 system rules", () => {
    expect(value("45306", "dd/mm/yyyy")).toBe("15/01/2024");
    expect(value("45306", "m/d/yyyy")).toBe("1/15/2024");
    expect(value("45306", "d-mmm-yy")).toBe("15-Jan-24");
    expect(value("45306", "dddd")).toBe("Monday");
    expect(value("61", "m/d/yyyy")).toBe("3/1/1900");
    expect(value("59", "m/d/yyyy")).toBe("2/28/1900");
    // Serial 60 is Excel's fictitious 1900-02-29; it clamps to the real prior day.
    expect(value("60", "m/d/yyyy")).toBe("2/28/1900");
    expect(value("0", "m/d/yyyy", true)).toBe("1/1/1904");
    // The 1904 system is 1,462 days behind the 1900 system.
    expect(value("43844", "m/d/yyyy", true)).toBe("1/15/2024");
    expect(value("0.5", "h:mm AM/PM")).toBe("12:00 PM");
    expect(value("0.75", "h:mm:ss")).toBe("18:00:00");
    expect(value("1.5", "[h]:mm:ss")).toBe("36:00:00");
  });

  it("keeps strings, booleans, errors, and empty cells as stored text", () => {
    expect(
      formatSpreadsheetCellValue({
        raw: "TRUE",
        type: "b",
        formatCode: undefined,
        date1904: false,
      }),
    ).toBe("TRUE");
    expect(
      formatSpreadsheetCellValue({
        raw: "FALSE",
        type: "b",
        formatCode: undefined,
        date1904: false,
      }),
    ).toBe("FALSE");
    expect(value("#DIV/0!", "0.00")).toBe("#DIV/0!");
    expect(
      formatSpreadsheetCellValue({ raw: "#N/A", type: "e", formatCode: "0.00", date1904: false }),
    ).toBe("#N/A");
    expect(value("", "0.00")).toBe("");
    expect(value("plain", "@")).toBe("plain");
  });
});

describe("styled workbook layout", () => {
  it("keeps real widths, heights, styles, merges, panes, and formatted values", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledXlsxFixture(), "xlsx");

    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    const sheet = preview?.sheets?.[0];
    expect(sheet?.name).toBe("Budget");
    expect(sheet?.rows).toEqual([
      ["Item", "Cost", "Date"],
      ["Rent", "$1,200.50", "15/01/2024"],
      ["Share", "0.125"],
    ]);
    expect(sheet?.columns).toEqual([{ width: 30 }, { width: 16 }, { width: 16 }]);
    expect(sheet?.rowHeights).toEqual([30, 0, 0]);
    expect(sheet?.frozenRows).toBe(1);
    expect(sheet?.frozenColumns).toBe(1);
    expect(sheet?.showGridLines).toBe(false);
    expect(sheet?.tabColor).toBe("#3300cc");
    expect(sheet?.mergedCells).toEqual([{ row: 0, column: 0, rowSpan: 1, columnSpan: 3 }]);

    const headerStyle = sheet?.styles?.[sheet.cells?.[0]?.style ?? -1];
    expect(headerStyle).toMatchObject({
      bold: true,
      fontSizePt: 14,
      fontName: "Calibri",
      color: "#ffffff",
      fill: "#dae3f3",
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    });
    expect(headerStyle?.border?.top).toEqual({ style: "thin", color: "#000000" });
    expect(sheet?.defaultStyle).toBe(0);
  });

  it("applies custom number formats only to numeric cells", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledXlsxFixture(), "xlsx");
    const sheet = preview?.sheets?.[0];
    const currencyCell = sheet?.cells?.find((cell) => cell.row === 1 && cell.column === 1);
    const dateCell = sheet?.cells?.find((cell) => cell.row === 1 && cell.column === 2);
    expect(sheet?.styles?.[currencyCell?.style ?? -1]?.numberFormat).toBe("$#,##0.00");
    expect(sheet?.styles?.[dateCell?.style ?? -1]?.numberFormat).toBe("dd/mm/yyyy");
  });

  it("reports unsupported workbook features as explicit omissions", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledXlsxFixture(), "xlsx");
    expect(preview?.omitted).toEqual([
      { feature: "conditionalFormatting", count: 1 },
      { feature: "dataValidation", count: 1 },
      { feature: "drawings", count: 1 },
      { feature: "charts", count: 1 },
      { feature: "pivotTables", count: 1 },
      { feature: "comments", count: 1 },
    ]);
    expect(preview?.truncated).toBeUndefined();
  });

  it("never evaluates formulas and keeps only their cached values", async () => {
    const sheetDataXml =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1" s="2"><f>SUM(B2:B3)</f><v>999</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Pending</t></is></c><c r="B2" s="2"><f>TODAY()</f></c></row>';
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({
        sheets: [{ name: "Formulas", sheetDataXml }],
        sharedStrings: [],
        extraParts: [
          {
            path: "xl/styles.xml",
            content:
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
          },
        ],
      }),
      "xlsx",
    );

    const sheet = preview?.sheets?.[0];
    // The cached value is formatted; the formula text is never evaluated.
    expect(sheet?.rows?.[0]).toEqual(["Total", "$999.00"]);
    // A formula without a cached value renders an empty cell, not a guess.
    expect(sheet?.rows?.[1]).toEqual(["Pending"]);
  });

  it("keeps an explicit plain cellXfs entry as an override of a styled default", async () => {
    const sheetDataXml =
      '<row r="1"><c r="A1" s="0" t="inlineStr"><is><t>Bold</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Plain</t></is></c></row>';
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({
        sheets: [{ name: "Override", sheetDataXml }],
        sharedStrings: [],
        extraParts: [
          {
            path: "xl/styles.xml",
            content:
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><b/><sz val="11"/><name val="Calibri"/></font><font/></fonts><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
          },
        ],
      }),
      "xlsx",
    );

    const sheet = preview?.sheets?.[0];
    expect(sheet?.defaultStyle).toBe(0);
    expect(sheet?.styles?.[0]?.bold).toBe(true);
    // A1 uses the styled default; B1 explicitly clears it.
    expect(sheet?.cells).toEqual([{ row: 0, column: 1, plain: true }]);
  });

  it("reports frozen panes only for frozen pane states", async () => {
    const splitView =
      '<sheetViews><sheetView><pane xSplit="1" ySplit="1" topLeftCell="B2" state="split"/></sheetView></sheetViews>';
    const frozenView =
      '<sheetViews><sheetView><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews>';
    const preview = parseOfficePreviewBuffer(
      await buildXlsxFixture({
        sheets: [
          {
            name: "Split",
            worksheetPrefixXml: splitView,
            sheetDataXml: '<row r="1"><c r="A1"><v>1</v></c></row>',
          },
          {
            name: "Frozen",
            worksheetPrefixXml: frozenView,
            sheetDataXml: '<row r="1"><c r="A1"><v>1</v></c></row>',
          },
        ],
        sharedStrings: [],
      }),
      "xlsx",
    );

    const split = preview?.sheets?.[0];
    expect(split?.frozenRows).toBeUndefined();
    expect(split?.frozenColumns).toBeUndefined();
    const frozen = preview?.sheets?.[1];
    expect(frozen?.frozenRows).toBe(1);
    expect(frozen?.frozenColumns).toBe(1);
  });

  it("keeps hidden worksheet tabs with their declaration", async () => {
    const preview = parseOfficePreviewBuffer(await buildStyledXlsxFixture(), "xlsx");
    expect(preview?.sheets?.map((sheet) => sheet.name)).toEqual(["Budget", "Hidden"]);
    expect(preview?.sheets?.[1]?.hidden).toBe(true);
    expect(preview?.sheets?.[0]?.hidden).toBeUndefined();
  });
});
