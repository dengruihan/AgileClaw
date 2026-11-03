/**
 * Read-only OOXML parsing for the Control UI Office preview.
 *
 * The Gateway ships only displayed facts: worksheet grids of plain strings,
 * sanitized body blocks for documents, and slide outlines for presentations.
 * Nothing here resolves external relationships, executes macros, loads media,
 * or evaluates formulas; every value is treated as untrusted text.
 */
import { DOMParser } from "linkedom";
import type {
  SessionFileOfficeBlock,
  SessionFileOfficeFormat,
  SessionFileOfficePreview,
  SessionFileOfficeSheet,
  SessionFileOfficeSlide,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  OFFICE_PREVIEW_MAX_BLOCKS,
  OFFICE_PREVIEW_MAX_BLOCK_CHARS,
  OFFICE_PREVIEW_MAX_CELL_CHARS,
  OFFICE_PREVIEW_MAX_DOCUMENT_CHARS,
  OFFICE_PREVIEW_MAX_PRESENTATION_CHARS,
  OFFICE_PREVIEW_MAX_SHEETS,
  OFFICE_PREVIEW_MAX_SHEET_CELLS,
  OFFICE_PREVIEW_MAX_SHEET_COLUMNS,
  OFFICE_PREVIEW_MAX_SHEET_ROWS,
  OFFICE_PREVIEW_MAX_SLIDES,
  OFFICE_PREVIEW_MAX_SLIDE_LINES,
  OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS,
  OFFICE_PREVIEW_MAX_SPREADSHEET_CHARS,
} from "./office-preview-limits.js";
import { OfficeZipArchive } from "./office-preview-zip.js";

// Untrusted Office text may embed control characters that break rendering.
// eslint-disable-next-line no-control-regex -- control characters are stripped from display text
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const HEADING_STYLE = /^heading\s*([1-6])$/iu;
const DEFAULT_NS = /^[a-z0-9]+:/iu;

/**
 * Minimal element surface this reader uses. The parser runs outside a DOM lib
 * (Gateway core), and linkedom satisfies these members structurally.
 */
type XmlElement = {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<XmlElement>;
  readonly children: ArrayLike<XmlElement>;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

type XmlDocumentBody = {
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

function parseXml(xml: string): XmlDocumentBody {
  return new DOMParser().parseFromString(xml, "text/xml");
}

/** Keeps only characters a text preview can render safely. */
function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/gu, "\n").replace(CONTROL_CHARACTERS, "");
}

/** Truncates without splitting a surrogate pair. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const codePoint = value.charCodeAt(maxChars - 1);
  return value.slice(0, codePoint >= 0xd800 && codePoint <= 0xdbff ? maxChars - 1 : maxChars);
}

function elements(root: XmlDocumentBody, tagName: string): XmlElement[] {
  return Array.from(root.getElementsByTagName(tagName));
}

function attribute(element: XmlElement | undefined, name: string): string | undefined {
  const value = element?.getAttribute(name)?.trim();
  return value ? value : undefined;
}

/** WordprocessingML stores property values in the `w:` namespace. */
function valAttribute(element: XmlElement | undefined): string | undefined {
  return attribute(element, "val") ?? attribute(element, "w:val");
}

function localName(nodeName: string): string {
  return nodeName.replace(DEFAULT_NS, "");
}

/** Resolves one relationship target inside the package; escapes are rejected. */
function resolvePackagePath(baseDir: string, target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("http:") || trimmed.startsWith("https:")) {
    return undefined;
  }
  const segments = (trimmed.startsWith("/") ? trimmed.slice(1) : `${baseDir}${trimmed}`).split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolved.length === 0) {
        return undefined;
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

function readRelationships(
  archive: OfficeZipArchive,
  relsPath: string,
  baseDir: string,
): Map<string, string> {
  const relationships = new Map<string, string>();
  const xml = archive.readText(relsPath);
  if (!xml) {
    return relationships;
  }
  try {
    const doc = parseXml(xml);
    for (const relationship of elements(doc, "Relationship")) {
      const id = attribute(relationship, "Id");
      const target = attribute(relationship, "Target");
      // External targets are never fetched; the preview only reads package parts.
      if (!id || !target || attribute(relationship, "TargetMode") === "External") {
        continue;
      }
      const resolved = resolvePackagePath(baseDir, target);
      if (resolved) {
        relationships.set(id, resolved);
      }
    }
  } catch {
    return relationships;
  }
  return relationships;
}

/** Character budget shared by one part so a single huge cell cannot starve the rest. */
class CharacterBudget {
  private remaining: number;
  exhausted = false;

  constructor(limit: number) {
    this.remaining = limit;
  }

  take(value: string, maxChars: number): string {
    if (this.remaining <= 0) {
      this.exhausted = true;
      return "";
    }
    const bounded = truncate(value, Math.min(maxChars, this.remaining));
    if (bounded.length < value.length) {
      this.exhausted = true;
    }
    this.remaining -= bounded.length;
    return bounded;
  }
}

function columnIndexFromReference(reference: string | undefined): number | undefined {
  const letters = reference?.match(/^[A-Za-z]+/u)?.[0];
  if (!letters) {
    return undefined;
  }
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function sharedStringValues(archive: OfficeZipArchive): string[] {
  const xml = archive.readText("xl/sharedStrings.xml");
  if (!xml) {
    return [];
  }
  const values: string[] = [];
  try {
    const doc = parseXml(xml);
    for (const item of elements(doc, "si")) {
      const runs: string[] = [];
      // Read only direct text and rich-text runs; phonetic hints stay excluded.
      for (const child of Array.from(item.children)) {
        const name = localName(child.nodeName);
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
  } catch {
    return [];
  }
  return values;
}

function cellValue(cell: XmlElement, sharedStrings: readonly string[]): string {
  const type = attribute(cell, "t");
  if (type === "s") {
    const raw = elements(cell, "v")[0]?.textContent?.trim();
    const index = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isSafeInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "inlineStr") {
    return cleanText(
      elements(cell, "t")
        .map((node) => node.textContent ?? "")
        .join(""),
    );
  }
  const raw = elements(cell, "v")[0]?.textContent ?? "";
  if (type === "b") {
    return raw.trim() === "1" ? "TRUE" : raw.trim() === "0" ? "FALSE" : cleanText(raw);
  }
  return cleanText(raw);
}

function trimTrailingEmpty(values: readonly string[]): string[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === "") {
    end -= 1;
  }
  return values.slice(0, end);
}

function parseWorksheet(
  xml: string,
  sharedStrings: readonly string[],
  budget: CharacterBudget,
): { sheet: Pick<SessionFileOfficeSheet, "rows" | "rowCount" | "columnCount" | "truncated"> } {
  const doc = parseXml(xml);
  const rows: string[][] = [];
  let displayedCells = 0;
  let rowCount = 0;
  let columnCount = 0;
  let truncated = false;

  for (const row of elements(doc, "row")) {
    const declaredRow = Number.parseInt(attribute(row, "r") ?? "", 10);
    const rowNumber = Number.isSafeInteger(declaredRow) ? declaredRow : rowCount + 1;
    rowCount = Math.max(rowCount, rowNumber);
    const cells = elements(row, "c");
    if (rowNumber > OFFICE_PREVIEW_MAX_SHEET_ROWS) {
      // Keep scanning only for declarations; rendered rows stay bounded.
      truncated = true;
      for (const cell of cells) {
        const column = columnIndexFromReference(attribute(cell, "r"));
        if (column !== undefined) {
          columnCount = Math.max(columnCount, column + 1);
        }
      }
      continue;
    }
    const values: string[] = [];
    let nextColumn = 0;
    for (const cell of cells) {
      const column = columnIndexFromReference(attribute(cell, "r")) ?? nextColumn;
      nextColumn = column + 1;
      columnCount = Math.max(columnCount, column + 1);
      const value = budget.take(cellValue(cell, sharedStrings), OFFICE_PREVIEW_MAX_CELL_CHARS);
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
    }
    rows.push(trimTrailingEmpty(values));
  }

  if (budget.exhausted) {
    truncated = true;
  }
  while (rows.length > 0 && rows[rows.length - 1]?.length === 0) {
    rows.pop();
  }
  return {
    sheet: {
      rows,
      rowCount,
      columnCount,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

function parseXlsx(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  const workbookXml = archive.readText("xl/workbook.xml");
  if (!workbookXml) {
    return null;
  }
  const relationships = readRelationships(archive, "xl/_rels/workbook.xml.rels", "xl/");
  const sharedStrings = sharedStringValues(archive);
  const budget = new CharacterBudget(OFFICE_PREVIEW_MAX_SPREADSHEET_CHARS);
  const sheets: SessionFileOfficeSheet[] = [];
  let truncated = false;

  for (const sheetNode of elements(parseXml(workbookXml), "sheet")) {
    if (sheets.length >= OFFICE_PREVIEW_MAX_SHEETS) {
      truncated = true;
      break;
    }
    const name = cleanText(attribute(sheetNode, "name") ?? "").slice(0, 256);
    const relationshipId = attribute(sheetNode, "r:id");
    const partPath = relationshipId ? relationships.get(relationshipId) : undefined;
    const xml = partPath ? archive.readText(partPath) : undefined;
    if (!xml) {
      // Chartsheets and unsupported sheet kinds keep their tab without content.
      sheets.push({ name, rows: [], rowCount: 0, columnCount: 0 });
      continue;
    }
    let parsed: ReturnType<typeof parseWorksheet>;
    try {
      parsed = parseWorksheet(xml, sharedStrings, budget);
    } catch {
      sheets.push({ name, rows: [], rowCount: 0, columnCount: 0 });
      truncated = true;
      continue;
    }
    sheets.push({ name, ...parsed.sheet });
    if (parsed.sheet.truncated) {
      truncated = true;
    }
  }

  if (budget.exhausted) {
    truncated = true;
  }
  return { format: "xlsx", sheets, ...(truncated ? { truncated: true } : {}) };
}

function paragraphText(paragraph: XmlElement): string {
  const parts: string[] = [];
  const visit = (element: XmlElement): void => {
    if (element.nodeType !== 1) {
      return;
    }
    const name = localName(element.nodeName);
    switch (name) {
      case "t":
        parts.push(element.textContent ?? "");
        return;
      case "tab":
        parts.push("\t");
        return;
      case "br":
      case "cr":
        parts.push("\n");
        break;
      // Paragraph/run properties and field codes carry no visible body text.
      case "pPr":
      case "rPr":
      case "delText":
      case "instrText":
        return;
      default:
        for (const child of Array.from(element.childNodes)) {
          visit(child);
        }
    }
  };
  for (const child of Array.from(paragraph.childNodes)) {
    visit(child);
  }
  return cleanText(parts.join(""));
}

function paragraphProperties(paragraph: XmlElement): XmlElement | undefined {
  return Array.from(paragraph.children).find((child) => localName(child.nodeName) === "pPr");
}

function propertyChild(properties: XmlElement | undefined, name: string): XmlElement | undefined {
  return properties
    ? Array.from(properties.children).find((child) => localName(child.nodeName) === name)
    : undefined;
}

function headingLevel(paragraph: XmlElement): number | undefined {
  const properties = paragraphProperties(paragraph);
  const style = valAttribute(propertyChild(properties, "pStyle"));
  if (style) {
    const match = style.match(HEADING_STYLE) ?? style.match(/^([1-6])$/u);
    if (match) {
      return Number.parseInt(match[1] ?? "", 10);
    }
  }
  const outlineLevel = Number.parseInt(
    valAttribute(propertyChild(properties, "outlineLvl")) ?? "",
    10,
  );
  return Number.isSafeInteger(outlineLevel) && outlineLevel >= 0 && outlineLevel <= 5
    ? outlineLevel + 1
    : undefined;
}

function isListItem(paragraph: XmlElement): boolean {
  return propertyChild(paragraphProperties(paragraph), "numPr") !== undefined;
}

function parseDocx(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  const documentXml = archive.readText("word/document.xml");
  if (!documentXml) {
    return null;
  }
  const budget = new CharacterBudget(OFFICE_PREVIEW_MAX_DOCUMENT_CHARS);
  const blocks: SessionFileOfficeBlock[] = [];
  let truncated = false;

  for (const paragraph of elements(parseXml(documentXml), "w:p")) {
    if (blocks.length >= OFFICE_PREVIEW_MAX_BLOCKS) {
      truncated = true;
      break;
    }
    const text = budget.take(paragraphText(paragraph), OFFICE_PREVIEW_MAX_BLOCK_CHARS).trim();
    if (!text) {
      continue;
    }
    const level = headingLevel(paragraph);
    if (level !== undefined) {
      blocks.push({ kind: "heading", level, text });
    } else if (isListItem(paragraph)) {
      blocks.push({ kind: "listItem", text });
    } else {
      blocks.push({ kind: "paragraph", text });
    }
  }

  if (budget.exhausted) {
    truncated = true;
  }
  return { format: "docx", blocks, ...(truncated ? { truncated: true } : {}) };
}

function shapeLines(shape: XmlElement): string[] {
  const lines: string[] = [];
  for (const paragraph of elements(shape, "a:p")) {
    const line = cleanText(
      elements(paragraph, "a:t")
        .map((node) => node.textContent ?? "")
        .join(""),
    ).trim();
    if (line) {
      lines.push(truncate(line, OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS));
    }
  }
  return lines;
}

function isTitleShape(shape: XmlElement): boolean {
  const placeholder = elements(shape, "p:ph")[0];
  const type = attribute(placeholder, "type");
  return type === "title" || type === "ctrTitle";
}

function parseSlide(xml: string, index: number): SessionFileOfficeSlide {
  const doc = parseXml(xml);
  const lines: string[] = [];
  let title: string | undefined;
  for (const shape of elements(doc, "p:sp")) {
    const shapeText = shapeLines(shape);
    if (shapeText.length === 0) {
      continue;
    }
    if (title === undefined && isTitleShape(shape)) {
      title = truncate(shapeText[0] ?? "", 512);
      lines.push(...shapeText.slice(1));
      continue;
    }
    lines.push(...shapeText);
  }
  const boundedLines = lines
    .filter((line) => line.length > 0)
    .slice(0, OFFICE_PREVIEW_MAX_SLIDE_LINES);
  return {
    index,
    ...(title ? { title } : {}),
    lines: boundedLines,
  };
}

function slideParts(archive: OfficeZipArchive): string[] {
  const presentationXml = archive.readText("ppt/presentation.xml");
  if (presentationXml) {
    const relationships = readRelationships(archive, "ppt/_rels/presentation.xml.rels", "ppt/");
    const parts: string[] = [];
    for (const slideId of elements(parseXml(presentationXml), "p:sldId")) {
      const target = relationships.get(attribute(slideId, "r:id") ?? "");
      if (target) {
        parts.push(target);
      }
    }
    if (parts.length > 0) {
      return parts;
    }
  }
  // Fall back to numeric slide order for packages without a usable slide list.
  return archive
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .toSorted((left, right) => {
      const leftIndex = Number(left.match(/(\d+)\.xml$/u)?.[1] ?? "0");
      const rightIndex = Number(right.match(/(\d+)\.xml$/u)?.[1] ?? "0");
      return leftIndex - rightIndex;
    });
}

function parsePptx(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  if (!archive.has("ppt/presentation.xml") && !archive.has("ppt/slides/slide1.xml")) {
    return null;
  }
  const budget = new CharacterBudget(OFFICE_PREVIEW_MAX_PRESENTATION_CHARS);
  const slides: SessionFileOfficeSlide[] = [];
  let truncated = false;
  for (const part of slideParts(archive)) {
    if (slides.length >= OFFICE_PREVIEW_MAX_SLIDES) {
      truncated = true;
      break;
    }
    const xml = archive.readText(part);
    if (!xml) {
      continue;
    }
    let slide: SessionFileOfficeSlide;
    try {
      slide = parseSlide(xml, slides.length + 1);
    } catch {
      truncated = true;
      continue;
    }
    slide.lines = slide.lines
      .map((line) => budget.take(line, OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS))
      .filter((line) => line.length > 0);
    slides.push(slide);
  }
  if (budget.exhausted) {
    truncated = true;
  }
  return { format: "pptx", slides, ...(truncated ? { truncated: true } : {}) };
}

/** Parses one validated OOXML buffer; returns null when the package is unusable. */
export function parseOfficePreviewBuffer(
  buffer: Buffer,
  format: SessionFileOfficeFormat,
): SessionFileOfficePreview | null {
  let archive: OfficeZipArchive;
  try {
    archive = new OfficeZipArchive(buffer);
  } catch {
    return null;
  }
  try {
    if (format === "xlsx") {
      return parseXlsx(archive);
    }
    if (format === "docx") {
      return parseDocx(archive);
    }
    return parsePptx(archive);
  } catch {
    return null;
  }
}
