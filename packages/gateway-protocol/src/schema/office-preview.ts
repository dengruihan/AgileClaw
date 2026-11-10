// Gateway Protocol schema module defines read-only Office preview shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

/**
 * Bounded typed facts for read-only Office previews.
 *
 * The Gateway parses OOXML packages itself and ships displayed layout facts:
 * worksheet grids with resolved styles, word-processing pages with runs and
 * tables, and slide outlines. Nothing here carries raw HTML/CSS, macro code,
 * formulas, or external relationships; every value is untrusted display data.
 */

/** Modern OOXML container the Gateway parsed for an `office` preview. */
export const SessionFileOfficeFormatSchema = Type.Union([
  Type.Literal("xlsx"),
  Type.Literal("docx"),
  Type.Literal("pptx"),
]);

/** Whether the Gateway could build the requested structured preview. */
export const SessionFileOfficePreviewStateSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("unsupported"),
  Type.Literal("too-large"),
  Type.Literal("invalid"),
  Type.Literal("password-protected"),
]);

/** Normalized `#rrggbb` color; document-authored themes resolve before the wire. */
const OfficeHexColorSchema = Type.String({ pattern: "^#[0-9a-f]{6}$" });
const OfficeHorizontalAlignmentSchema = Type.Union([
  Type.Literal("left"),
  Type.Literal("center"),
  Type.Literal("right"),
  Type.Literal("justify"),
]);
const OfficeVerticalAlignmentSchema = Type.Union([
  Type.Literal("top"),
  Type.Literal("middle"),
  Type.Literal("bottom"),
]);

/** Bounded inline image: only PNG, JPEG, GIF, and WebP data URLs are accepted. */
const OfficeInlineImageDataUrlSchema = Type.String({
  maxLength: 700_000,
  pattern: "^data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$",
});

/** Run-level emphasis and font facts shared by text runs and spreadsheet styles. */
const OfficeTextStyleProperties = {
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
  underline: Type.Optional(Type.Boolean()),
  strike: Type.Optional(Type.Boolean()),
  fontName: Type.Optional(Type.String({ maxLength: 64 })),
  fontSizePt: Type.Optional(Type.Number({ minimum: 1, maximum: 400 })),
  color: Type.Optional(OfficeHexColorSchema),
  /** Word superscript/subscript (`w:vertAlign`). */
  verticalAlign: Type.Optional(
    Type.Union([Type.Literal("superscript"), Type.Literal("subscript")]),
  ),
};

const OfficeBorderSideSchema = closedObject({
  style: Type.Union([
    Type.Literal("thin"),
    Type.Literal("medium"),
    Type.Literal("thick"),
    Type.Literal("dashed"),
    Type.Literal("dotted"),
    Type.Literal("double"),
  ]),
  color: Type.Optional(OfficeHexColorSchema),
});

const OfficeBorderSchema = closedObject({
  top: Type.Optional(OfficeBorderSideSchema),
  right: Type.Optional(OfficeBorderSideSchema),
  bottom: Type.Optional(OfficeBorderSideSchema),
  left: Type.Optional(OfficeBorderSideSchema),
});

/** One deduplicated spreadsheet cell style, referenced by `cells[].style`. */
const SessionFileOfficeCellStyleSchema = closedObject({
  ...OfficeTextStyleProperties,
  /** Solid fill background, resolved from theme/indexed colors. */
  fill: Type.Optional(OfficeHexColorSchema),
  horizontal: Type.Optional(OfficeHorizontalAlignmentSchema),
  vertical: Type.Optional(OfficeVerticalAlignmentSchema),
  wrapText: Type.Optional(Type.Boolean()),
  border: Type.Optional(OfficeBorderSchema),
  indent: Type.Optional(Type.Integer({ minimum: 0, maximum: 250 })),
  /** Sanitized number-format code, e.g. `#,##0.00`; display values are resolved already. */
  numberFormat: Type.Optional(Type.String({ maxLength: 128 })),
});

/** One rendered worksheet column. */
const SessionFileOfficeSheetColumnSchema = closedObject({
  /** Excel character-unit width; `0` keeps the sheet default. */
  width: Type.Number({ minimum: 0, maximum: 255 }),
  hidden: Type.Optional(Type.Boolean()),
});

/** One styled cell inside the rendered worksheet window. */
const SessionFileOfficeCellSchema = closedObject({
  /** 0-based index into the sheet's rendered rows. */
  row: Type.Integer({ minimum: 0, maximum: 199 }),
  /** 0-based column index. */
  column: Type.Integer({ minimum: 0, maximum: 39 }),
  /** Index into `SessionFileOfficeSheet.styles`. */
  style: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  /** Explicitly plain cell: overrides a styled sheet `defaultStyle`. */
  plain: Type.Optional(Type.Boolean()),
});

/** One merged range resolved to rendered row/column indices. */
const SessionFileOfficeMergeSchema = closedObject({
  row: Type.Integer({ minimum: 0, maximum: 199 }),
  column: Type.Integer({ minimum: 0, maximum: 39 }),
  rowSpan: Type.Integer({ minimum: 1, maximum: 200 }),
  columnSpan: Type.Integer({ minimum: 1, maximum: 16_384 }),
});

/** One worksheet of a workbook preview; `rows` keeps display strings for text readers. */
export const SessionFileOfficeSheetSchema = closedObject({
  name: Type.String({ maxLength: 256 }),
  rows: Type.Array(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 200 }), {
    maxItems: 200,
  }),
  /** True 1-based worksheet row for each rendered row; sparse sheets skip empty rows. */
  rowNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 200 })),
  /** Rows and columns the sheet declares, including ones omitted by truncation. */
  rowCount: Type.Integer({ minimum: 0 }),
  /** Bounded by the spreadsheet column limit so malformed references stay valid. */
  columnCount: Type.Integer({ minimum: 0, maximum: 16_384 }),
  truncated: Type.Optional(Type.Boolean()),
  /** Rendered column facts, index-aligned with the displayed column letters. */
  columns: Type.Optional(Type.Array(SessionFileOfficeSheetColumnSchema, { maxItems: 40 })),
  /** Row heights in points, index-aligned with `rowNumbers`; `0` keeps the default. */
  rowHeights: Type.Optional(
    Type.Array(Type.Number({ minimum: 0, maximum: 409 }), { maxItems: 200 }),
  ),
  /** Rendered frozen rows and columns; absent when the sheet has no frozen pane. */
  frozenRows: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
  frozenColumns: Type.Optional(Type.Integer({ minimum: 0, maximum: 40 })),
  showGridLines: Type.Optional(Type.Boolean()),
  tabColor: Type.Optional(OfficeHexColorSchema),
  /** Hidden worksheet tabs keep their declaration but no rendered body. */
  hidden: Type.Optional(Type.Boolean()),
  mergedCells: Type.Optional(Type.Array(SessionFileOfficeMergeSchema, { maxItems: 500 })),
  cells: Type.Optional(Type.Array(SessionFileOfficeCellSchema, { maxItems: 20_000 })),
  styles: Type.Optional(Type.Array(SessionFileOfficeCellStyleSchema, { maxItems: 256 })),
  /** Style index applied to every cell without an explicit `cells` entry. */
  defaultStyle: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
});

/** One sanitized body block of a word-processing document preview. */
export const SessionFileOfficeBlockSchema = closedObject({
  kind: Type.Union([Type.Literal("heading"), Type.Literal("paragraph"), Type.Literal("listItem")]),
  level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  text: Type.String({ maxLength: 8_000 }),
});

/** One slide outline of a presentation preview. */
export const SessionFileOfficeSlideSchema = closedObject({
  index: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String({ maxLength: 512 })),
  lines: Type.Array(Type.String({ maxLength: 2_000 }), { maxItems: 80 }),
});

/** One styled text run inside a document paragraph. */
const SessionFileOfficeRunSchema = closedObject({
  text: Type.String({ maxLength: 8_000 }),
  ...OfficeTextStyleProperties,
});

/** Paragraph role resolved from styles, outline levels, and numbering. */
const OfficeParagraphRoleSchema = Type.Union([
  Type.Literal("title"),
  Type.Literal("heading"),
  Type.Literal("body"),
  Type.Literal("listItem"),
]);

/** One document paragraph with resolved alignment, spacing, and runs. */
const SessionFileOfficeParagraphSchema = closedObject({
  kind: Type.Literal("paragraph"),
  role: OfficeParagraphRoleSchema,
  level: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  /** Numbering label computed from `numbering.xml`, e.g. `1.` or `•`. */
  listMarker: Type.Optional(Type.String({ maxLength: 32 })),
  /** Flattened accessible text; `runs` carries the styled segments. */
  text: Type.String({ maxLength: 8_000 }),
  alignment: Type.Optional(OfficeHorizontalAlignmentSchema),
  spaceBeforePt: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  spaceAfterPt: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  lineSpacingPt: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
  indentLeftPt: Type.Optional(Type.Number({ minimum: 0, maximum: 2_000 })),
  indentRightPt: Type.Optional(Type.Number({ minimum: 0, maximum: 2_000 })),
  /** Negative values are hanging indents. */
  indentFirstLinePt: Type.Optional(Type.Number({ minimum: -2_000, maximum: 2_000 })),
  runs: Type.Array(SessionFileOfficeRunSchema, { maxItems: 200 }),
});

/** One table cell with spans, shading, borders, and paragraph content. */
const SessionFileOfficeTableCellSchema = closedObject({
  columnSpan: Type.Optional(Type.Integer({ minimum: 1, maximum: 63 })),
  rowSpan: Type.Optional(Type.Integer({ minimum: 1, maximum: 255 })),
  shading: Type.Optional(OfficeHexColorSchema),
  border: Type.Optional(OfficeBorderSchema),
  paragraphs: Type.Array(SessionFileOfficeParagraphSchema, { maxItems: 40 }),
});

const SessionFileOfficeTableRowSchema = closedObject({
  cells: Type.Array(SessionFileOfficeTableCellSchema, { maxItems: 64 }),
});

/** One document table with grid widths and resolved cell spans. */
const SessionFileOfficeTableSchema = closedObject({
  kind: Type.Literal("table"),
  /** Column widths in points from `w:tblGrid`; empty when the table has no grid. */
  columnWidthsPt: Type.Array(Type.Number({ minimum: 0, maximum: 2_000 }), { maxItems: 64 }),
  border: Type.Optional(OfficeBorderSchema),
  rows: Type.Array(SessionFileOfficeTableRowSchema, { maxItems: 200 }),
});

/**
 * One unique inlined image. Document pages reference media by index so a file
 * that repeats the same image never repeats its bytes on the wire.
 */
const SessionFileOfficeMediaSchema = closedObject({
  dataUrl: OfficeInlineImageDataUrlSchema,
});

/** One bounded safe inline image anchored in a document page. */
const SessionFileOfficeImageSchema = closedObject({
  kind: Type.Literal("image"),
  /** Index into `SessionFileOfficePreview.media`. */
  media: Type.Integer({ minimum: 0, maximum: 23 }),
  widthPt: Type.Number({ minimum: 0, maximum: 2_000 }),
  heightPt: Type.Number({ minimum: 0, maximum: 2_000 }),
  alt: Type.Optional(Type.String({ maxLength: 512 })),
});

/** One typed document body block. */
const SessionFileOfficeDocBlockSchema = Type.Union([
  SessionFileOfficeParagraphSchema,
  SessionFileOfficeTableSchema,
  SessionFileOfficeImageSchema,
]);

/** One approximate page card of a document preview. */
const SessionFileOfficePageSchema = closedObject({
  widthPt: Type.Number({ minimum: 1, maximum: 2_000 }),
  heightPt: Type.Number({ minimum: 1, maximum: 2_000 }),
  marginTopPt: Type.Number({ minimum: 0, maximum: 1_000 }),
  marginRightPt: Type.Number({ minimum: 0, maximum: 1_000 }),
  marginBottomPt: Type.Number({ minimum: 0, maximum: 1_000 }),
  marginLeftPt: Type.Number({ minimum: 0, maximum: 1_000 }),
  blocks: Type.Array(SessionFileOfficeDocBlockSchema, { maxItems: 500 }),
});

/** Every structured omission the Office readers can report. */
const SessionFileOfficeOmittedFeatureSchema = Type.Union([
  Type.Literal("charts"),
  Type.Literal("comments"),
  Type.Literal("conditionalFormatting"),
  Type.Literal("dataValidation"),
  Type.Literal("drawings"),
  Type.Literal("embeddedObjects"),
  Type.Literal("equations"),
  Type.Literal("exactPagination"),
  Type.Literal("floatingObjects"),
  Type.Literal("images"),
  Type.Literal("multipleSections"),
  Type.Literal("pivotTables"),
]);

/** One explicit dropped-or-approximated feature notice. */
const SessionFileOfficeOmittedSchema = closedObject({
  feature: SessionFileOfficeOmittedFeatureSchema,
  /** Occurrences found; `0` marks an approximation notice such as page layout. */
  count: Type.Integer({ minimum: 0 }),
});

/** Structured read-only payload rendered by the Control UI office viewer. */
export const SessionFileOfficePreviewSchema = closedObject({
  format: SessionFileOfficeFormatSchema,
  /** True when any sheet, block, slide, page, run, or text limit cut the payload short. */
  truncated: Type.Optional(Type.Boolean()),
  sheets: Type.Optional(Type.Array(SessionFileOfficeSheetSchema, { maxItems: 20 })),
  blocks: Type.Optional(Type.Array(SessionFileOfficeBlockSchema, { maxItems: 2_000 })),
  slides: Type.Optional(Type.Array(SessionFileOfficeSlideSchema, { maxItems: 100 })),
  /** Approximate page cards for word-processing documents. */
  pages: Type.Optional(Type.Array(SessionFileOfficePageSchema, { maxItems: 50 })),
  /** Unique inline images referenced by page image blocks. */
  media: Type.Optional(Type.Array(SessionFileOfficeMediaSchema, { maxItems: 24 })),
  /**
   * Header/footer paragraphs for the document's supported (final) section.
   * They are serialized once and apply to every page card.
   */
  header: Type.Optional(Type.Array(SessionFileOfficeParagraphSchema, { maxItems: 20 })),
  footer: Type.Optional(Type.Array(SessionFileOfficeParagraphSchema, { maxItems: 20 })),
  /** Features this preview intentionally dropped or approximated. */
  omitted: Type.Optional(Type.Array(SessionFileOfficeOmittedSchema, { maxItems: 20 })),
});

export type SessionFileOfficeFormat = Static<typeof SessionFileOfficeFormatSchema>;
export type SessionFileOfficePreviewState = Static<typeof SessionFileOfficePreviewStateSchema>;
export type SessionFileOfficeCellStyle = Static<typeof SessionFileOfficeCellStyleSchema>;
export type SessionFileOfficeSheetColumn = Static<typeof SessionFileOfficeSheetColumnSchema>;
export type SessionFileOfficeCell = Static<typeof SessionFileOfficeCellSchema>;
export type SessionFileOfficeMerge = Static<typeof SessionFileOfficeMergeSchema>;
export type SessionFileOfficeSheet = Static<typeof SessionFileOfficeSheetSchema>;
export type SessionFileOfficeBlock = Static<typeof SessionFileOfficeBlockSchema>;
export type SessionFileOfficeSlide = Static<typeof SessionFileOfficeSlideSchema>;
export type SessionFileOfficeRun = Static<typeof SessionFileOfficeRunSchema>;
export type SessionFileOfficeParagraph = Static<typeof SessionFileOfficeParagraphSchema>;
export type SessionFileOfficeTableCell = Static<typeof SessionFileOfficeTableCellSchema>;
export type SessionFileOfficeTableRow = Static<typeof SessionFileOfficeTableRowSchema>;
export type SessionFileOfficeTable = Static<typeof SessionFileOfficeTableSchema>;
export type SessionFileOfficeMedia = Static<typeof SessionFileOfficeMediaSchema>;
export type SessionFileOfficeImage = Static<typeof SessionFileOfficeImageSchema>;
export type SessionFileOfficeDocBlock = Static<typeof SessionFileOfficeDocBlockSchema>;
export type SessionFileOfficePage = Static<typeof SessionFileOfficePageSchema>;
export type SessionFileOfficeOmittedFeature = Static<typeof SessionFileOfficeOmittedFeatureSchema>;
export type SessionFileOfficeOmitted = Static<typeof SessionFileOfficeOmittedSchema>;
export type SessionFileOfficePreview = Static<typeof SessionFileOfficePreviewSchema>;
