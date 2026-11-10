/**
 * DOCX table layout resolution.
 *
 * Word tables are a grid of cells with spans, vertical merges, borders, and
 * shading; a naive paragraph walk flattens them. This reader keeps the grid,
 * resolves `gridSpan` and `vMerge` continuation rows into typed spans, and
 * applies table-style borders plus explicit cell borders and shading.
 */
import type {
  SessionFileOfficeParagraph,
  SessionFileOfficeTable,
  SessionFileOfficeTableCell,
} from "../../../packages/gateway-protocol/src/index.js";
import type { DocxStyleResolver } from "./office-preview-docx-styles.js";
import { findTableBorders, tableStyleId } from "./office-preview-docx-styles.js";
import { OFFICE_PREVIEW_MAX_DOCX_TABLE_CELLS } from "./office-preview-limits.js";
import type { OmittedFeatureCounter } from "./office-preview-theme.js";
import { twipsToPoints, wordShadingFill } from "./office-preview-theme.js";
import {
  childNamed,
  childrenNamed,
  elements,
  propertyChild,
  valAttribute,
  wordAttribute,
  type XmlElement,
} from "./office-preview-xml.js";

export type DocxBorder = NonNullable<SessionFileOfficeTableCell["border"]>;
type DocxBorderSide = NonNullable<DocxBorder["top"]>;

export type DocxTableContext = {
  styles: DocxStyleResolver;
  counter: OmittedFeatureCounter;
  /** Builds cell paragraph content; page breaks inside cells are ignored. */
  buildParagraphs: (paragraph: XmlElement) => SessionFileOfficeParagraph[];
  state: { tableCellsUsed: number; truncated: boolean };
};

function readBorderSide(side: XmlElement | undefined): DocxBorderSide | undefined {
  if (!side) {
    return undefined;
  }
  const value = valAttribute(side);
  if (!value || value === "nil" || value === "none") {
    return undefined;
  }
  const size = Number.parseFloat(wordAttribute(side, "sz") ?? "");
  const color = wordAttribute(side, "color");
  const normalizedColor =
    color && /^[0-9a-fA-F]{6}$/u.test(color) ? `#${color.toLowerCase()}` : undefined;
  const style: DocxBorderSide["style"] =
    value === "double" || value === "triple"
      ? "double"
      : value.includes("dash")
        ? "dashed"
        : value.includes("dot")
          ? "dotted"
          : Number.isFinite(size) && size >= 12
            ? "thick"
            : Number.isFinite(size) && size >= 8
              ? "medium"
              : "thin";
  return { style, ...(normalizedColor ? { color: normalizedColor } : {}) };
}

function readBorderElement(borders: XmlElement | undefined): {
  outer?: DocxBorder;
  inside?: DocxBorder;
} {
  if (!borders) {
    return {};
  }
  const outer: DocxBorder = {};
  const top = readBorderSide(propertyChild(borders, "top"));
  const right = readBorderSide(propertyChild(borders, "right"));
  const bottom = readBorderSide(propertyChild(borders, "bottom"));
  const left = readBorderSide(propertyChild(borders, "left"));
  if (top) {
    outer.top = top;
  }
  if (right) {
    outer.right = right;
  }
  if (bottom) {
    outer.bottom = bottom;
  }
  if (left) {
    outer.left = left;
  }
  const insideH = readBorderSide(propertyChild(borders, "insideH"));
  const insideV = readBorderSide(propertyChild(borders, "insideV"));
  const inside: DocxBorder = {};
  if (insideH) {
    inside.top = insideH;
    inside.bottom = insideH;
  }
  if (insideV) {
    inside.left = insideV;
    inside.right = insideV;
  }
  return {
    ...(Object.keys(outer).length > 0 ? { outer } : {}),
    ...(Object.keys(inside).length > 0 ? { inside } : {}),
  };
}

function mergeBorders(
  base: DocxBorder | undefined,
  extra: DocxBorder | undefined,
): DocxBorder | undefined {
  if (!base && !extra) {
    return undefined;
  }
  const merged: DocxBorder = { ...base, ...extra };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function buildCellParagraphs(
  cell: XmlElement,
  context: DocxTableContext,
): SessionFileOfficeParagraph[] {
  const paragraphs: SessionFileOfficeParagraph[] = [];
  for (const paragraph of childrenNamed(cell, "p")) {
    if (paragraphs.length >= 40) {
      context.state.truncated = true;
      break;
    }
    paragraphs.push(...context.buildParagraphs(paragraph).slice(0, 40 - paragraphs.length));
  }
  const nestedTables = childrenNamed(cell, "tbl").length;
  if (nestedTables > 0) {
    // Nested tables are not represented in the cell payload.
    context.counter.add("floatingObjects", nestedTables);
  }
  return paragraphs;
}

function readTableCell(
  cell: XmlElement,
  columnSpan: number,
  tableBorder: DocxBorder | undefined,
  context: DocxTableContext,
): SessionFileOfficeTableCell {
  const properties = childNamed(cell, "tcPr");
  const shading = wordShadingFill(childNamed(properties, "shd"));
  const cellBorder = readBorderElement(childNamed(properties, "tcBorders")).outer;
  const border = mergeBorders(tableBorder, cellBorder);
  return {
    ...(columnSpan > 1 ? { columnSpan: Math.min(63, columnSpan) } : {}),
    ...(shading ? { shading } : {}),
    ...(border ? { border } : {}),
    paragraphs: buildCellParagraphs(cell, context),
  };
}

/** Builds one typed table block; callers place it in the document page flow. */
export function buildDocxTable(
  table: XmlElement,
  context: DocxTableContext,
): SessionFileOfficeTable {
  const tableProperties = childNamed(table, "tblPr");
  const chain = context.styles.tableChain(tableProperties, tableStyleId(tableProperties));
  const borders = readBorderElement(findTableBorders(chain));
  const grid = elements(table, "w:tblGrid")[0];
  const columnWidthsPt = childrenNamed(grid, "gridCol")
    .map((column) => twipsToPoints(wordAttribute(column, "w")))
    .filter((width): width is number => width !== undefined && width <= 2_000)
    .slice(0, 64);
  const rows: SessionFileOfficeTable["rows"] = [];
  const activeMerges = new Map<number, SessionFileOfficeTableCell>();
  for (const row of childrenNamed(table, "tr")) {
    if (rows.length >= 200) {
      context.state.truncated = true;
      break;
    }
    const cells: SessionFileOfficeTableCell[] = [];
    let gridColumn = 0;
    for (const cell of childrenNamed(row, "tc")) {
      if (
        context.state.tableCellsUsed >= OFFICE_PREVIEW_MAX_DOCX_TABLE_CELLS ||
        cells.length >= 64
      ) {
        context.state.truncated = true;
        break;
      }
      const properties = childNamed(cell, "tcPr");
      const gridSpanValue = Number.parseInt(
        valAttribute(propertyChild(properties, "gridSpan")) ?? "1",
        10,
      );
      const gridSpan = Math.max(
        1,
        Math.min(63, Number.isSafeInteger(gridSpanValue) ? gridSpanValue : 1),
      );
      const verticalMerge = propertyChild(properties, "vMerge");
      const continues = verticalMerge !== undefined && valAttribute(verticalMerge) !== "restart";
      context.state.tableCellsUsed += 1;
      if (continues) {
        const merged = activeMerges.get(gridColumn);
        if (merged) {
          merged.rowSpan = Math.min(255, (merged.rowSpan ?? 1) + 1);
        } else {
          cells.push(readTableCell(cell, gridSpan, borders.inside, context));
        }
        gridColumn += gridSpan;
        continue;
      }
      activeMerges.delete(gridColumn);
      const tableCell = readTableCell(cell, gridSpan, borders.inside, context);
      if (valAttribute(verticalMerge) === "restart") {
        activeMerges.set(gridColumn, tableCell);
      }
      cells.push(tableCell);
      gridColumn += gridSpan;
    }
    rows.push({ cells });
  }
  return {
    kind: "table",
    columnWidthsPt,
    ...(borders.outer ? { border: borders.outer } : {}),
    rows,
  };
}
