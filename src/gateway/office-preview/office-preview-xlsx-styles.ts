/**
 * XLSX cell-style resolution (`xl/styles.xml`).
 *
 * Excel references one `cellXfs` entry per cell, and each entry points at font,
 * fill, border, alignment, and number-format collections. This module resolves
 * only the entries the rendered window references, deduplicates identical
 * styles, and returns bounded typed styles plus the resolved number-format code
 * so display values can be formatted without a second styles pass.
 */
import type { SessionFileOfficeCellStyle } from "../../../packages/gateway-protocol/src/index.js";
import type { OfficeTheme } from "./office-preview-theme.js";
import { numericAttribute, resolveExcelColor } from "./office-preview-theme.js";
import { builtinNumberFormat, sanitizeNumberFormatCode } from "./office-preview-xlsx-format.js";
import {
  attribute,
  childNamed,
  childrenNamed,
  elements,
  tryParseXml,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

export type SpreadsheetStyleTable = {
  /** Deduplicated style table for the sheet payload. */
  styles: SessionFileOfficeCellStyle[];
  /** Style index for a `cellXfs` entry; undefined for the empty/default style. */
  styleIndexOf(xfIndex: number): number | undefined;
  /** Number-format code for a `cellXfs` entry. */
  formatCodeOf(xfIndex: number): string | undefined;
  /** Style index of `cellXfs[0]`, applied to cells without an explicit entry. */
  defaultStyle: number | undefined;
  /** True when the style table hit its bounded size. */
  truncated: boolean;
};

const EMPTY_STYLE_TABLE: SpreadsheetStyleTable = {
  styles: [],
  styleIndexOf: () => undefined,
  formatCodeOf: () => undefined,
  defaultStyle: undefined,
  truncated: false,
};

/** Reads Office's boolean property elements, where an explicit `0` means off. */
function onOff(element: XmlElement | undefined): boolean | undefined {
  if (!element) {
    return undefined;
  }
  const value = attribute(element, "val")?.toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

function borderStyleName(
  style: string | undefined,
): "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | undefined {
  switch (style) {
    case "thin":
    case "slantDashDot":
      return "thin";
    case "medium":
    case "mediumDashed":
    case "mediumDashDot":
    case "mediumDashDotDot":
      return "medium";
    case "thick":
      return "thick";
    case "dashed":
    case "dashDot":
    case "dashDotDot":
    case "longDash":
    case "longDashDot":
    case "longDashDotDot":
      return "dashed";
    case "dotted":
    case "hair":
      return "dotted";
    case "double":
      return "double";
    default:
      return undefined;
  }
}

function readFont(font: XmlElement | undefined, theme: OfficeTheme) {
  if (!font) {
    return undefined;
  }
  const style: NonNullable<SessionFileOfficeCellStyle> = {};
  const bold = onOff(childNamed(font, "b"));
  const italic = onOff(childNamed(font, "i"));
  const underline = onOff(childNamed(font, "u"));
  const strike = onOff(childNamed(font, "strike"));
  const sizePt = numericAttribute(childNamed(font, "sz"), "val", { min: 1, max: 400 });
  const name = attribute(childNamed(font, "name"), "val");
  const color = resolveExcelColor(childNamed(font, "color"), theme);
  const vertAlign = attribute(childNamed(font, "vertAlign"), "val");
  if (bold) {
    style.bold = true;
  }
  if (italic) {
    style.italic = true;
  }
  if (underline) {
    style.underline = true;
  }
  if (strike) {
    style.strike = true;
  }
  if (name) {
    style.fontName = name.slice(0, 64);
  }
  if (sizePt !== undefined) {
    style.fontSizePt = sizePt;
  }
  if (color) {
    style.color = color;
  }
  if (vertAlign === "superscript" || vertAlign === "subscript") {
    style.verticalAlign = vertAlign;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function readFill(fill: XmlElement | undefined, theme: OfficeTheme): string | undefined {
  const pattern = childNamed(fill, "patternFill");
  if (!pattern || attribute(pattern, "patternType") !== "solid") {
    return undefined;
  }
  return resolveExcelColor(childNamed(pattern, "fgColor"), theme);
}

function readBorderSide(side: XmlElement | undefined, theme: OfficeTheme) {
  if (!side) {
    return undefined;
  }
  const style = borderStyleName(attribute(side, "style"));
  if (!style) {
    return undefined;
  }
  const color = resolveExcelColor(childNamed(side, "color"), theme);
  return color ? { style, color } : { style };
}

function readBorder(border: XmlElement | undefined, theme: OfficeTheme) {
  if (!border) {
    return undefined;
  }
  const sides = {
    top: readBorderSide(childNamed(border, "top"), theme),
    right: readBorderSide(childNamed(border, "right"), theme),
    bottom: readBorderSide(childNamed(border, "bottom"), theme),
    left: readBorderSide(childNamed(border, "left"), theme),
  };
  const resolved: NonNullable<SessionFileOfficeCellStyle["border"]> = {};
  if (sides.top) {
    resolved.top = sides.top;
  }
  if (sides.right) {
    resolved.right = sides.right;
  }
  if (sides.bottom) {
    resolved.bottom = sides.bottom;
  }
  if (sides.left) {
    resolved.left = sides.left;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function readAlignment(xf: XmlElement) {
  const alignment = childNamed(xf, "alignment");
  if (!alignment) {
    return undefined;
  }
  const horizontal = attribute(alignment, "horizontal");
  const vertical = attribute(alignment, "vertical");
  const wrapText = attribute(alignment, "wrapText");
  const indent = numericAttribute(alignment, "indent", { min: 0, max: 250 });
  const resolved: NonNullable<SessionFileOfficeCellStyle> = {};
  if (
    horizontal === "left" ||
    horizontal === "center" ||
    horizontal === "right" ||
    horizontal === "justify"
  ) {
    resolved.horizontal = horizontal;
  } else if (horizontal === "centerContinuous") {
    resolved.horizontal = "center";
  } else if (horizontal === "distributed") {
    resolved.horizontal = "justify";
  }
  if (vertical === "top" || vertical === "bottom") {
    resolved.vertical = vertical;
  } else if (vertical === "center" || vertical === "justify" || vertical === "distributed") {
    resolved.vertical = "middle";
  }
  if (wrapText === "1" || wrapText === "true") {
    resolved.wrapText = true;
  }
  if (indent !== undefined && Number.isInteger(indent)) {
    resolved.indent = indent;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Parses one `cellXfs` entry into a bounded typed style. */
function readCellStyle(
  xf: XmlElement,
  parts: {
    fonts: readonly XmlElement[];
    fills: readonly XmlElement[];
    borders: readonly XmlElement[];
    formats: ReadonlyMap<number, string>;
    theme: OfficeTheme;
  },
): { style: SessionFileOfficeCellStyle; formatCode?: string } {
  const fontId = Number.parseInt(attribute(xf, "fontId") ?? "0", 10);
  const fillId = Number.parseInt(attribute(xf, "fillId") ?? "0", 10);
  const borderId = Number.parseInt(attribute(xf, "borderId") ?? "0", 10);
  const numFmtId = Number.parseInt(attribute(xf, "numFmtId") ?? "0", 10);
  const font = readFont(parts.fonts[fontId], parts.theme);
  const fill = readFill(parts.fills[fillId], parts.theme);
  const border = readBorder(parts.borders[borderId], parts.theme);
  const alignment = readAlignment(xf);
  const rawFormat = parts.formats.get(numFmtId) ?? builtinNumberFormat(numFmtId);
  const formatCode = rawFormat && rawFormat !== "General" ? rawFormat : undefined;
  const style: SessionFileOfficeCellStyle = {};
  if (font) {
    Object.assign(style, font);
  }
  if (fill) {
    style.fill = fill;
  }
  if (border) {
    style.border = border;
  }
  if (alignment) {
    Object.assign(style, alignment);
  }
  const sanitizedFormat = sanitizeNumberFormatCode(formatCode);
  if (sanitizedFormat) {
    style.numberFormat = sanitizedFormat;
  }
  return { style, ...(formatCode ? { formatCode } : {}) };
}

/** Reads spreadsheet styles; a missing or malformed part yields no styles. */
export function readSpreadsheetStyles(
  archive: OfficeZipArchive,
  theme: OfficeTheme,
): SpreadsheetStyleTable {
  const xml = archive.readText("xl/styles.xml");
  const doc = xml ? tryParseXml(xml) : undefined;
  if (!doc) {
    return EMPTY_STYLE_TABLE;
  }
  const formats = new Map<number, string>();
  for (const numFmt of elements(doc, "numFmt")) {
    const id = Number.parseInt(attribute(numFmt, "numFmtId") ?? "", 10);
    const code = attribute(numFmt, "formatCode");
    if (Number.isSafeInteger(id) && code) {
      formats.set(id, code);
    }
  }
  const fonts = childrenNamed(elements(doc, "fonts")[0], "font");
  const fills = childrenNamed(elements(doc, "fills")[0], "fill");
  const borders = childrenNamed(elements(doc, "borders")[0], "border");
  const xfs = childrenNamed(elements(doc, "cellXfs")[0], "xf");
  if (xfs.length === 0) {
    return EMPTY_STYLE_TABLE;
  }
  const parts = { fonts, fills, borders, formats, theme };
  const table: SessionFileOfficeCellStyle[] = [];
  const dedupe = new Map<string, number>();
  const styleIndexes = new Map<number, number>();
  const formatCodes = new Map<number, string>();
  let truncated = false;
  for (let xfIndex = 0; xfIndex < xfs.length; xfIndex += 1) {
    const xf = xfs[xfIndex];
    if (!xf) {
      continue;
    }
    const { style, formatCode } = readCellStyle(xf, parts);
    if (formatCode) {
      formatCodes.set(xfIndex, formatCode);
    }
    if (Object.keys(style).length === 0) {
      continue;
    }
    const key = JSON.stringify(style);
    const existing = dedupe.get(key);
    if (existing !== undefined) {
      styleIndexes.set(xfIndex, existing);
      continue;
    }
    if (table.length >= 256) {
      truncated = true;
      continue;
    }
    dedupe.set(key, table.length);
    styleIndexes.set(xfIndex, table.length);
    table.push(style);
  }
  return {
    styles: table,
    styleIndexOf: (xfIndex) => styleIndexes.get(xfIndex),
    formatCodeOf: (xfIndex) => formatCodes.get(xfIndex),
    defaultStyle: styleIndexes.get(0),
    truncated,
  };
}

/** Spreadsheet parts this reader cannot render, counted for omission notices. */
export function spreadsheetOmissionCounts(archive: OfficeZipArchive): {
  drawings: number;
  charts: number;
  pivotTables: number;
  comments: number;
} {
  let drawings = 0;
  let charts = 0;
  let pivotTables = 0;
  let comments = 0;
  for (const name of archive.names()) {
    // JSZip adds directory entries for nested parts; only files count.
    if (name.endsWith("/")) {
      continue;
    }
    if (name.startsWith("xl/drawings/")) {
      drawings += 1;
    } else if (name.startsWith("xl/charts/")) {
      charts += 1;
    } else if (name.startsWith("xl/pivotTables/") || name.startsWith("xl/pivotCache/")) {
      pivotTables += 1;
    } else if (name.startsWith("xl/comments")) {
      comments += 1;
    }
  }
  return { drawings, charts, pivotTables, comments };
}
