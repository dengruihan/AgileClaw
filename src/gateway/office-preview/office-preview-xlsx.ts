/**
 * Read-only XLSX layout parser.
 *
 * Produces the worksheet facts the Control UI needs to look like a workbook:
 * formatted display values, column widths, row heights, merges, frozen panes,
 * gridline visibility, tab color, and deduplicated cell styles. Formulas are
 * never evaluated: only stored values are read, and cells whose formula has no
 * cached value stay empty.
 */
import type {
  SessionFileOfficeCell,
  SessionFileOfficeMerge,
  SessionFileOfficePreview,
  SessionFileOfficeSheet,
  SessionFileOfficeSheetColumn,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  OFFICE_PREVIEW_MAX_CELL_CHARS,
  OFFICE_PREVIEW_MAX_MERGES,
  OFFICE_PREVIEW_MAX_SHEET_CELLS,
  OFFICE_PREVIEW_MAX_SHEET_COLUMNS,
  OFFICE_PREVIEW_MAX_SHEET_ROWS,
  OFFICE_PREVIEW_MAX_SHEETS,
  OFFICE_PREVIEW_MAX_SPREADSHEET_CHARS,
} from "./office-preview-limits.js";
import type { OfficeTheme } from "./office-preview-theme.js";
import {
  numericAttribute,
  OmittedFeatureCounter,
  readOfficeTheme,
  resolveExcelColor,
} from "./office-preview-theme.js";
import { formatSpreadsheetCellValue } from "./office-preview-xlsx-format.js";
import {
  readSpreadsheetStyles,
  spreadsheetOmissionCounts,
  type SpreadsheetStyleTable,
} from "./office-preview-xlsx-styles.js";
import {
  attribute,
  CharacterBudget,
  childNamed,
  cleanText,
  columnIndexFromReference,
  elements,
  MAX_SPREADSHEET_COLUMNS,
  parseCellRange,
  readRelationships,
  tryParseXml,
  type XmlElement,
} from "./office-preview-xml.js";
import { OfficeZipArchive } from "./office-preview-zip.js";

type WorksheetFacts = Omit<SessionFileOfficeSheet, "name">;

type ColumnDefinition = { min: number; max: number; width: number; hidden: boolean };

function sharedStringValues(archive: OfficeZipArchive): string[] {
  const xml = archive.readText("xl/sharedStrings.xml");
  if (!xml) {
    return [];
  }
  const doc = tryParseXml(xml);
  if (!doc) {
    return [];
  }
  const values: string[] = [];
  for (const item of elements(doc, "si")) {
    const runs: string[] = [];
    // Read only direct text and rich-text runs; phonetic hints stay excluded.
    for (const child of Array.from(item.children)) {
      const name = child.nodeName.replace(/^[a-z0-9]+:/iu, "");
      if (name === "t") {
        runs.push(child.textContent ?? "");
      } else if (name === "r") {
        for (const text of elements(child, "t")) {
          runs.push(text.textContent ?? "");
        }
      }
    }
    values.push(cleanText(runs.join("")));
  }
  return values;
}

function trimTrailingEmpty(values: readonly string[]): string[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === "") {
    end -= 1;
  }
  return values.slice(0, end);
}

/** One rendered cell value plus the `cellXfs` index that styles it. */
function readCell(
  cell: XmlElement,
  sharedStrings: readonly string[],
  styles: SpreadsheetStyleTable,
  date1904: boolean,
): { text: string; xfIndex: number } {
  const type = attribute(cell, "t");
  const xfIndex = Number.parseInt(attribute(cell, "s") ?? "0", 10);
  const boundedXf = Number.isSafeInteger(xfIndex) && xfIndex >= 0 ? xfIndex : 0;
  if (type === "s") {
    const raw = elements(cell, "v")[0]?.textContent?.trim();
    const index = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return {
      text: Number.isSafeInteger(index) ? (sharedStrings[index] ?? "") : "",
      xfIndex: boundedXf,
    };
  }
  if (type === "inlineStr") {
    return {
      text: cleanText(
        elements(cell, "t")
          .map((node) => node.textContent ?? "")
          .join(""),
      ),
      xfIndex: boundedXf,
    };
  }
  const raw = elements(cell, "v")[0]?.textContent ?? "";
  return {
    text: formatSpreadsheetCellValue({
      raw,
      type,
      formatCode: styles.formatCodeOf(boundedXf),
      date1904,
    }),
    xfIndex: boundedXf,
  };
}

function readColumnDefinitions(doc: ReturnType<typeof tryParseXml>): ColumnDefinition[] {
  if (!doc) {
    return [];
  }
  const definitions: ColumnDefinition[] = [];
  for (const col of elements(doc, "col")) {
    const min = Number.parseInt(attribute(col, "min") ?? "", 10);
    const max = Number.parseInt(attribute(col, "max") ?? "", 10);
    const width = numericAttribute(col, "width", { min: 0, max: 255 });
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min) {
      continue;
    }
    definitions.push({
      min: min - 1,
      max: max - 1,
      width: width === undefined ? 0 : Math.round(width * 100) / 100,
      hidden: attribute(col, "hidden") === "1",
    });
  }
  return definitions;
}

function readColumnFacts(
  definitions: readonly ColumnDefinition[],
  columnCount: number,
): SessionFileOfficeSheetColumn[] {
  const width = Math.min(columnCount, OFFICE_PREVIEW_MAX_SHEET_COLUMNS);
  const columns: SessionFileOfficeSheetColumn[] = [];
  for (let index = 0; index < width; index += 1) {
    const definition = definitions.find((entry) => index >= entry.min && index <= entry.max);
    columns.push({
      width: definition?.width ?? 0,
      ...(definition?.hidden ? { hidden: true } : {}),
    });
  }
  return columns;
}

function readFrozenPane(doc: ReturnType<typeof tryParseXml>): {
  frozenRows?: number;
  frozenColumns?: number;
  showGridLines?: boolean;
} {
  if (!doc) {
    return {};
  }
  const view = elements(doc, "sheetView")[0];
  const pane = childNamed(view, "pane");
  // `split` is an ordinary movable split view; only frozen panes are layout.
  const paneState = attribute(pane, "state");
  const frozen = paneState === "frozen" || paneState === "frozenSplit";
  const frozenColumns = frozen ? numericAttribute(pane, "xSplit", { min: 0, max: 40 }) : undefined;
  const frozenRows = frozen ? numericAttribute(pane, "ySplit", { min: 0, max: 200 }) : undefined;
  return {
    ...(frozenRows ? { frozenRows: Math.floor(frozenRows) } : {}),
    ...(frozenColumns ? { frozenColumns: Math.floor(frozenColumns) } : {}),
    ...(attribute(view, "showGridLines") === "0" ? { showGridLines: false } : {}),
  };
}

function readMerges(
  doc: ReturnType<typeof tryParseXml>,
  rowNumbers: readonly number[],
  columnCount: number,
): { merges: SessionFileOfficeMerge[]; truncated: boolean } {
  if (!doc) {
    return { merges: [], truncated: false };
  }
  const renderedColumnCount = Math.min(columnCount, OFFICE_PREVIEW_MAX_SHEET_COLUMNS);
  const merges: SessionFileOfficeMerge[] = [];
  let truncated = false;
  for (const mergeCell of elements(doc, "mergeCell")) {
    const range = parseCellRange(attribute(mergeCell, "ref"));
    if (!range || (range.endColumn <= range.startColumn && range.endRow <= range.startRow)) {
      continue;
    }
    const anchor = rowNumbers.indexOf(range.startRow);
    if (anchor < 0 || range.startColumn >= renderedColumnCount) {
      continue;
    }
    const anchorColumn = Math.max(0, Math.min(range.startColumn, renderedColumnCount - 1));
    const endColumn = Math.min(range.endColumn, renderedColumnCount - 1);
    let endRow = anchor;
    for (let index = anchor; index < rowNumbers.length; index += 1) {
      if ((rowNumbers[index] ?? 0) <= range.endRow) {
        endRow = index;
      } else {
        break;
      }
    }
    const merge: SessionFileOfficeMerge = {
      row: anchor,
      column: anchorColumn,
      rowSpan: Math.max(1, endRow - anchor + 1),
      columnSpan: Math.max(1, endColumn - anchorColumn + 1),
    };
    if (merge.rowSpan === 1 && merge.columnSpan === 1) {
      continue;
    }
    if (merges.length >= OFFICE_PREVIEW_MAX_MERGES) {
      truncated = true;
      continue;
    }
    merges.push(merge);
  }
  return { merges, truncated };
}

function parseWorksheetXml(params: {
  xml: string;
  sharedStrings: readonly string[];
  styles: SpreadsheetStyleTable;
  theme: OfficeTheme;
  budget: CharacterBudget;
  date1904: boolean;
  counter: OmittedFeatureCounter;
}): WorksheetFacts {
  const doc = tryParseXml(params.xml);
  if (!doc) {
    return { rows: [], rowNumbers: [], rowCount: 0, columnCount: 0, truncated: true };
  }
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  const rowHeights: number[] = [];
  const cells: SessionFileOfficeCell[] = [];
  let customHeights = false;
  let displayedCells = 0;
  let rowCount = 0;
  let columnCount = 0;
  let truncated = false;

  for (const row of elements(doc, "row")) {
    const declaredRow = Number.parseInt(attribute(row, "r") ?? "", 10);
    // Only a positive, strictly increasing declaration is trusted. Duplicate or
    // malformed numbers are repaired so one archive cannot label unbounded rows.
    const rowNumber =
      Number.isSafeInteger(declaredRow) && declaredRow > rowCount ? declaredRow : rowCount + 1;
    rowCount = rowNumber;
    const rowCells = elements(row, "c");
    if (rows.length >= OFFICE_PREVIEW_MAX_SHEET_ROWS) {
      truncated = true;
      for (const cell of rowCells) {
        const column = columnIndexFromReference(attribute(cell, "r"));
        if (column !== undefined) {
          columnCount = Math.max(columnCount, column + 1);
        }
      }
      continue;
    }
    const renderedIndex = rows.length;
    const height = numericAttribute(row, "ht", { min: 0, max: 409 });
    rowHeights.push(height ?? 0);
    customHeights ||= height !== undefined;
    const values: string[] = [];
    let nextColumn = 0;
    for (const cell of rowCells) {
      const column = columnIndexFromReference(attribute(cell, "r")) ?? nextColumn;
      nextColumn = column + 1;
      columnCount = Math.min(MAX_SPREADSHEET_COLUMNS, Math.max(columnCount, column + 1));
      const { text, xfIndex } = readCell(
        cell,
        params.sharedStrings,
        params.styles,
        params.date1904,
      );
      const value = params.budget.take(text, OFFICE_PREVIEW_MAX_CELL_CHARS);
      if (displayedCells >= OFFICE_PREVIEW_MAX_SHEET_CELLS) {
        truncated = true;
        continue;
      }
      if (column >= OFFICE_PREVIEW_MAX_SHEET_COLUMNS) {
        truncated = true;
        continue;
      }
      while (values.length < column) {
        values.push("");
      }
      values[column] = value;
      displayedCells += 1;
      if (xfIndex !== 0) {
        const resolution = params.styles.resolveStyle(xfIndex);
        if (resolution && "style" in resolution) {
          cells.push({ row: renderedIndex, column, style: resolution.style });
        } else if (resolution && params.styles.defaultStyle !== undefined) {
          // An explicit empty `cellXfs` entry clears the styled sheet default.
          cells.push({ row: renderedIndex, column, plain: true });
        }
      }
    }
    rows.push(trimTrailingEmpty(values));
    rowNumbers.push(rowNumber);
  }

  if (params.budget.exhausted) {
    truncated = true;
  }
  while (rows.length > 0 && rows[rows.length - 1]?.length === 0) {
    rows.pop();
    rowNumbers.pop();
    rowHeights.pop();
  }
  if (params.styles.truncated) {
    truncated = true;
  }
  const conditionalFormats = elements(doc, "conditionalFormatting").length;
  if (conditionalFormats > 0) {
    params.counter.add("conditionalFormatting", conditionalFormats);
  }
  const dataValidations = elements(doc, "dataValidation").length;
  if (dataValidations > 0) {
    params.counter.add("dataValidation", dataValidations);
  }

  const { merges, truncated: mergesTruncated } = readMerges(doc, rowNumbers, columnCount);
  truncated ||= mergesTruncated;
  const visibleCells = cells.filter((cell) => cell.row < rows.length);
  const columns = readColumnFacts(readColumnDefinitions(doc), columnCount);
  const frozen = readFrozenPane(doc);
  const tabColor = resolveExcelColor(
    childNamed(elements(doc, "sheetPr")[0], "tabColor"),
    params.theme,
  );
  const facts: WorksheetFacts = {
    rows,
    rowNumbers,
    rowCount,
    columnCount,
    ...(columns.length > 0 ? { columns } : {}),
    ...(customHeights ? { rowHeights } : {}),
    ...frozen,
    ...(tabColor ? { tabColor } : {}),
    ...(merges.length > 0 ? { mergedCells: merges } : {}),
    ...(visibleCells.length > 0 ? { cells: visibleCells } : {}),
    ...(params.styles.styles.length > 0
      ? {
          styles: params.styles.styles,
          ...(params.styles.defaultStyle !== undefined
            ? { defaultStyle: params.styles.defaultStyle }
            : {}),
        }
      : {}),
    ...(truncated ? { truncated: true } : {}),
  };
  return facts;
}

/** Reads one workbook package; null means the package is not a workbook. */
export function parseSpreadsheet(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  const workbookXml = archive.readText("xl/workbook.xml");
  if (!workbookXml) {
    return null;
  }
  const doc = tryParseXml(workbookXml);
  if (!doc) {
    return null;
  }
  const relationships = readRelationships(archive, "xl/_rels/workbook.xml.rels", "xl/");
  const sharedStrings = sharedStringValues(archive);
  const theme = readOfficeTheme(archive, "xl/theme/theme1.xml");
  const styles = readSpreadsheetStyles(archive, theme);
  const budget = new CharacterBudget(OFFICE_PREVIEW_MAX_SPREADSHEET_CHARS);
  const counter = new OmittedFeatureCounter();
  const date1904 = ["1", "true"].includes(
    (attribute(elements(doc, "workbookPr")[0], "date1904") ?? "").toLowerCase(),
  );
  const sheets: SessionFileOfficeSheet[] = [];
  let truncated = false;

  for (const sheetNode of elements(doc, "sheet")) {
    if (sheets.length >= OFFICE_PREVIEW_MAX_SHEETS) {
      truncated = true;
      break;
    }
    const name = cleanText(attribute(sheetNode, "name") ?? "").slice(0, 256);
    const hidden = (attribute(sheetNode, "state") ?? "visible") !== "visible";
    const relationshipId = attribute(sheetNode, "r:id");
    const partPath = relationshipId ? relationships.get(relationshipId) : undefined;
    const xml = partPath ? archive.readText(partPath) : undefined;
    if (!xml) {
      // Chartsheets and unsupported sheet kinds keep their tab without content.
      sheets.push({
        name,
        rows: [],
        rowNumbers: [],
        rowCount: 0,
        columnCount: 0,
        ...(hidden ? { hidden: true } : {}),
      });
      continue;
    }
    let facts: WorksheetFacts;
    try {
      facts = parseWorksheetXml({
        xml,
        sharedStrings,
        styles,
        theme,
        budget,
        date1904,
        counter,
      });
    } catch {
      sheets.push({
        name,
        rows: [],
        rowNumbers: [],
        rowCount: 0,
        columnCount: 0,
        ...(hidden ? { hidden: true } : {}),
      });
      truncated = true;
      continue;
    }
    sheets.push({ name, ...(hidden ? { hidden: true } : {}), ...facts });
    if (facts.truncated) {
      truncated = true;
    }
  }

  const omissions = spreadsheetOmissionCounts(archive);
  if (omissions.drawings > 0) {
    counter.add("drawings", omissions.drawings);
  }
  if (omissions.charts > 0) {
    counter.add("charts", omissions.charts);
  }
  if (omissions.pivotTables > 0) {
    counter.add("pivotTables", omissions.pivotTables);
  }
  if (omissions.comments > 0) {
    counter.add("comments", omissions.comments);
  }
  if (budget.exhausted) {
    truncated = true;
  }
  return {
    format: "xlsx",
    sheets,
    ...(truncated ? { truncated: true } : {}),
    ...(counter.list().length > 0 ? { omitted: counter.list() } : {}),
  };
}
