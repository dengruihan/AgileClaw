import type { StyleInfo } from "lit/directives/style-map.js";
import type {
  SessionFileOfficeCellStyle,
  SessionFileOfficeParagraph,
  SessionFileOfficeRun,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";

type OfficeBorder = NonNullable<SessionFileOfficeCellStyle["border"]>;

/** Office lengths are points; the browser CSS pixel is 1/96 inch. */
const POINTS_TO_PX = 4 / 3;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const DOCUMENT_FONT_FALLBACK = '"Segoe UI", Calibri, Carlito, "Noto Sans", sans-serif';

export function officePointsToPx(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * POINTS_TO_PX;
}

export function officeColor(value: string | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function officeFontFamily(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const safe = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/["'\\<>;{}]/gu, "")
    .trim()
    .slice(0, 64);
  return safe ? `"${safe}", ${DOCUMENT_FONT_FALLBACK}` : undefined;
}

function officeFontSize(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return `${Math.min(400, Math.max(1, Math.round(value * 10) / 10))}pt`;
}

function officeTextDecoration(
  run: Pick<SessionFileOfficeRun, "underline" | "strike">,
): string | undefined {
  const parts = [
    run.underline ? "underline" : undefined,
    run.strike ? "line-through" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function officeVerticalOffset(run: SessionFileOfficeRun): {
  verticalAlign?: "sub" | "super";
  fontSize?: string;
} {
  if (run.verticalAlign !== "superscript" && run.verticalAlign !== "subscript") {
    return {};
  }
  return {
    verticalAlign: run.verticalAlign === "superscript" ? "super" : "sub",
    // Word renders raised/lowered text smaller without changing the run's
    // declared size, so scale the resolved point size instead of the em.
    fontSize:
      run.fontSizePt === undefined ? "0.7em" : officeFontSize(Math.max(1, run.fontSizePt * 0.7)),
  };
}

/** Typed run presentation shared by document paragraphs and table cells. */
export function officeRunStyle(run: SessionFileOfficeRun): StyleInfo {
  const vertical = officeVerticalOffset(run);
  return {
    fontWeight: run.bold ? "700" : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: officeTextDecoration(run),
    color: run.color ? officeColor(run.color, "inherit") : undefined,
    fontFamily: officeFontFamily(run.fontName),
    fontSize: vertical.fontSize ?? officeFontSize(run.fontSizePt),
    verticalAlign: vertical.verticalAlign,
  };
}

/** Paragraph layout in points converted to CSS pixels. */
export function officeParagraphStyle(paragraph: SessionFileOfficeParagraph): StyleInfo {
  return {
    textAlign: paragraph.alignment,
    marginTop:
      paragraph.spaceBeforePt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.spaceBeforePt) ?? 0) * 100) / 100}px`,
    marginBottom:
      paragraph.spaceAfterPt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.spaceAfterPt) ?? 0) * 100) / 100}px`,
    lineHeight:
      paragraph.lineSpacingPt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.lineSpacingPt) ?? 0) * 100) / 100}px`,
    marginLeft:
      paragraph.indentLeftPt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.indentLeftPt) ?? 0) * 100) / 100}px`,
    marginRight:
      paragraph.indentRightPt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.indentRightPt) ?? 0) * 100) / 100}px`,
    textIndent:
      paragraph.indentFirstLinePt === undefined
        ? undefined
        : `${Math.round((officePointsToPx(paragraph.indentFirstLinePt) ?? 0) * 100) / 100}px`,
  };
}

function officeBorderSide(side: NonNullable<OfficeBorder["top"]> | undefined): string | undefined {
  if (!side) {
    return undefined;
  }
  const width = side.style === "medium" ? "2px" : side.style === "thin" ? "1px" : "3px";
  const line =
    side.style === "dashed"
      ? "dashed"
      : side.style === "dotted"
        ? "dotted"
        : side.style === "double"
          ? "double"
          : "solid";
  return `${width} ${line} ${officeColor(side.color, "rgb(60 64 67)")}`;
}

/** Border sides mapped to CSS longhands; absent sides keep the host default. */
export function officeBorderStyle(border: OfficeBorder | undefined): StyleInfo {
  if (!border) {
    return {};
  }
  return {
    borderTop: officeBorderSide(border.top),
    borderRight: officeBorderSide(border.right),
    borderBottom: officeBorderSide(border.bottom),
    borderLeft: officeBorderSide(border.left),
  };
}

/** Pick readable text for an uncolored cell that carries a solid fill. */
function officeReadableTextColor(fill: string): string {
  const red = Number.parseInt(fill.slice(1, 3), 16);
  const green = Number.parseInt(fill.slice(3, 5), 16);
  const blue = Number.parseInt(fill.slice(5, 7), 16);
  const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  return luminance > 0.55 ? "rgb(31 35 40)" : "rgb(255 255 255)";
}

/** Spreadsheet cell presentation; `undefined` style keeps the sheet default. */
export function officeCellStyle(style: SessionFileOfficeCellStyle | undefined): StyleInfo {
  if (!style) {
    return {};
  }
  const fill = style.fill ? officeColor(style.fill, "transparent") : undefined;
  return {
    backgroundColor: fill,
    color: style.color
      ? officeColor(style.color, "inherit")
      : fill && fill !== "transparent"
        ? officeReadableTextColor(fill)
        : undefined,
    fontWeight: style.bold ? "700" : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: officeTextDecoration(style),
    fontFamily: officeFontFamily(style.fontName),
    fontSize: officeFontSize(style.fontSizePt),
    textAlign: style.horizontal,
    verticalAlign:
      style.vertical === "middle" ? "middle" : style.vertical === "bottom" ? "bottom" : undefined,
    whiteSpace: style.wrapText ? "pre-wrap" : undefined,
    overflowWrap: style.wrapText ? "anywhere" : undefined,
    paddingLeft: style.indent === undefined ? undefined : `${4 + style.indent * 8}px`,
    ...officeBorderStyle(style.border),
  };
}

/** Minimum readable default for a column with no declared width. */
export const OFFICE_SHEET_DEFAULT_COLUMN_PX = 64;
/** Excel row default is 15 points. */
export const OFFICE_SHEET_DEFAULT_ROW_PX = 20;
/** Row-number gutter and column-letter band used by sticky offsets. */
export const OFFICE_SHEET_ROW_HEADER_PX = 46;
export const OFFICE_SHEET_COLUMN_HEADER_PX = 20;

/**
 * Excel column width is measured in characters, not pixels. The canonical
 * Calibri 11 conversion is `width * 7 + 5` pixels, so a 30-character column is
 * about 215px and must not be imported as a 30px pixel width.
 */
export function officeSheetColumnWidthPx(width: number, hidden = false): number {
  if (hidden) {
    return 0;
  }
  if (!Number.isFinite(width) || width <= 0) {
    return OFFICE_SHEET_DEFAULT_COLUMN_PX;
  }
  return Math.max(16, Math.round(width * 7 + 5));
}

export function officeSheetRowHeightPx(points: number | undefined): number {
  if (typeof points !== "number" || !Number.isFinite(points) || points <= 0) {
    return OFFICE_SHEET_DEFAULT_ROW_PX;
  }
  return Math.max(8, Math.round(points * POINTS_TO_PX));
}
