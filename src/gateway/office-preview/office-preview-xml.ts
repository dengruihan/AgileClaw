/**
 * Shared read-only XML helpers for the OOXML preview readers.
 *
 * Every helper treats package content as untrusted text: namespaces are
 * compared by local name, text is stripped of control characters, and
 * relationship targets are resolved inside the package only. Nothing here
 * fetches external resources or executes document content.
 */
import { DOMParser } from "linkedom";
import type { OfficeZipArchive } from "./office-preview-zip.js";

/**
 * Minimal element surface these readers use. The parsers run outside a DOM lib
 * (Gateway core), and linkedom satisfies these members structurally.
 */
export type XmlElement = {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<XmlElement>;
  readonly children: ArrayLike<XmlElement>;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

export type XmlDocumentBody = {
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
};

// Untrusted Office text may embed control characters that break rendering.
// eslint-disable-next-line no-control-regex -- control characters are stripped from display text
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const DEFAULT_NS = /^[a-z0-9]+:/iu;

export function parseXml(xml: string): XmlDocumentBody {
  return new DOMParser().parseFromString(xml, "text/xml");
}

/** Parses XML and reports malformed parts instead of failing the whole preview. */
export function tryParseXml(xml: string): XmlDocumentBody | undefined {
  try {
    return parseXml(xml);
  } catch {
    return undefined;
  }
}

/** Keeps only characters a text preview can render safely. */
export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/gu, "\n").replace(CONTROL_CHARACTERS, "");
}

/** Truncates without splitting a surrogate pair. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const codePoint = value.charCodeAt(maxChars - 1);
  return value.slice(0, codePoint >= 0xd800 && codePoint <= 0xdbff ? maxChars - 1 : maxChars);
}

export function elements(root: XmlDocumentBody | XmlElement, tagName: string): XmlElement[] {
  return Array.from(root.getElementsByTagName(tagName));
}

export function localName(nodeName: string): string {
  return nodeName.replace(DEFAULT_NS, "");
}

export function elementChildren(element: XmlElement): XmlElement[] {
  return Array.from(element.children);
}

export function childNamed(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element
    ? elementChildren(element).find((child) => localName(child.nodeName) === name)
    : undefined;
}

export function childrenNamed(element: XmlElement | undefined, name: string): XmlElement[] {
  return element
    ? elementChildren(element).filter((child) => localName(child.nodeName) === name)
    : [];
}

/** Reads a direct child property element by local name (e.g. `pPr`, `tblPr`). */
export function propertyChild(
  properties: XmlElement | undefined,
  name: string,
): XmlElement | undefined {
  return childNamed(properties, name);
}

export function attribute(element: XmlElement | undefined, name: string): string | undefined {
  const value = element?.getAttribute(name)?.trim();
  return value ? value : undefined;
}

/** WordprocessingML stores its attributes in the `w:` namespace. */
export function wordAttribute(element: XmlElement | undefined, name: string): string | undefined {
  return attribute(element, name) ?? attribute(element, `w:${name}`);
}

/** WordprocessingML property value attribute. */
export function valAttribute(element: XmlElement | undefined): string | undefined {
  return wordAttribute(element, "val");
}

/** Reads the first direct text child of a run-like element. */
export function textOf(element: XmlElement | undefined): string {
  return element?.textContent ?? "";
}

/** Resolves one relationship target inside the package; escapes are rejected. */
export function resolvePackagePath(baseDir: string, target: string): string | undefined {
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

/** Internal relationship id -> in-package part path. External targets stay excluded. */
export function readRelationships(
  archive: OfficeZipArchive,
  relsPath: string,
  baseDir: string,
): Map<string, string> {
  const relationships = new Map<string, string>();
  const xml = archive.readText(relsPath);
  if (!xml) {
    return relationships;
  }
  const doc = tryParseXml(xml);
  if (!doc) {
    return relationships;
  }
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
  return relationships;
}

/** Character budget shared by one part so a single huge cell cannot starve the rest. */
export class CharacterBudget {
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

/**
 * Excel's last column is XFD (16,384). Longer references are malformed input,
 * and accumulating unbounded letters would overflow into Infinity and break the
 * closed protocol payload, so they resolve to no column.
 */
export const MAX_SPREADSHEET_COLUMNS = 16_384;
export const MAX_COLUMN_REFERENCE_LETTERS = 4;

export function columnIndexFromReference(reference: string | undefined): number | undefined {
  const letters = reference?.match(/^[A-Za-z]+/u)?.[0];
  if (!letters || letters.length > MAX_COLUMN_REFERENCE_LETTERS) {
    return undefined;
  }
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
    if (index > MAX_SPREADSHEET_COLUMNS) {
      return undefined;
    }
  }
  return index - 1;
}

/** Renders a 0-based column index as its spreadsheet letters. */
export function columnReference(index: number): string {
  let remaining = index + 1;
  let letters = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/** Splits an `A1:C3` range into 0-based column and 1-based row bounds. */
export function parseCellRange(
  reference: string | undefined,
): { startColumn: number; startRow: number; endColumn: number; endRow: number } | undefined {
  const match = reference?.trim().match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/u);
  if (!match) {
    return undefined;
  }
  const startColumn = columnIndexFromReference(match[1]);
  const startRow = Number.parseInt(match[2] ?? "", 10);
  const endColumn = match[3] ? columnIndexFromReference(match[3]) : startColumn;
  const endRow = match[4] ? Number.parseInt(match[4], 10) : startRow;
  if (
    startColumn === undefined ||
    endColumn === undefined ||
    !Number.isSafeInteger(startRow) ||
    !Number.isSafeInteger(endRow)
  ) {
    return undefined;
  }
  return { startColumn, startRow, endColumn, endRow };
}
