/**
 * DOCX style resolution (`word/styles.xml`).
 *
 * Word documents rarely carry direct formatting on every run: visible emphasis,
 * fonts, alignment, spacing, and numbering usually come from the default style,
 * a paragraph style, and its `basedOn` chain. This module resolves those chains
 * (with a cycle cap) into typed run and paragraph facts and recognizes title and
 * heading roles from style names and outline levels.
 */
import type {
  SessionFileOfficeParagraph,
  SessionFileOfficeRun,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OfficeTheme } from "./office-preview-theme.js";
import { resolveWordColor, twipsToPoints } from "./office-preview-theme.js";
import {
  childNamed,
  childrenNamed,
  elements,
  localName,
  propertyChild,
  tryParseXml,
  valAttribute,
  type XmlElement,
  wordAttribute,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

const MAX_STYLE_CHAIN = 20;
const HEADING_NAME = /^heading\s*([1-6])$/iu;

type StyleRecord = {
  name?: string;
  basedOn?: string;
  pPr?: XmlElement;
  rPr?: XmlElement;
  tblPr?: XmlElement;
};

export type DocxStyleResolver = {
  theme: OfficeTheme;
  /** Default paragraph font size in points, used for `auto` line spacing. */
  defaultFontSizePt: number;
  /** Paragraph property chain: direct properties first, defaults last. */
  paragraphChain: (direct: XmlElement | undefined, styleId: string | undefined) => XmlElement[];
  /** Run property chain: direct properties first, defaults last. */
  runChain: (
    direct: XmlElement | undefined,
    paragraphStyleId: string | undefined,
    runStyleId: string | undefined,
  ) => XmlElement[];
  paragraphStyleName: (styleId: string | undefined) => string | undefined;
  /** Table property chain: direct table properties first, style defaults last. */
  tableChain: (direct: XmlElement | undefined, styleId: string | undefined) => XmlElement[];
};

const EMPTY_RESOLVER: DocxStyleResolver = {
  theme: { colors: {} },
  defaultFontSizePt: 11,
  paragraphChain: (direct) => (direct ? [direct] : []),
  runChain: (direct) => (direct ? [direct] : []),
  paragraphStyleName: () => undefined,
  tableChain: (direct) => (direct ? [direct] : []),
};

function readStyleRecord(style: XmlElement): StyleRecord {
  return {
    name: valAttribute(childNamed(style, "name")),
    basedOn: valAttribute(childNamed(style, "basedOn")),
    pPr: childNamed(style, "pPr"),
    rPr: childNamed(style, "rPr"),
    tblPr: childNamed(style, "tblPr"),
  };
}

/** Reads document styles; a missing or malformed part leaves direct formatting only. */
export function readDocxStyles(archive: OfficeZipArchive, theme: OfficeTheme): DocxStyleResolver {
  const xml = archive.readText("word/styles.xml");
  const doc = xml ? tryParseXml(xml) : undefined;
  if (!doc) {
    return { ...EMPTY_RESOLVER, theme };
  }
  const styles = new Map<string, StyleRecord>();
  const byType = new Map<string, Map<string, StyleRecord>>();
  let defaultCharacterStyleId: string | undefined;
  let defaultParagraphStyleId: string | undefined;
  for (const style of elements(doc, "w:style")) {
    const id = wordAttribute(style, "styleId");
    if (!id) {
      continue;
    }
    const record = readStyleRecord(style);
    styles.set(id, record);
    const type = wordAttribute(style, "type") ?? "paragraph";
    const typed = byType.get(type) ?? new Map<string, StyleRecord>();
    typed.set(id, record);
    byType.set(type, typed);
    if (wordAttribute(style, "default") === "1" && type === "character") {
      defaultCharacterStyleId = id;
    } else if (wordAttribute(style, "default") === "1" && type === "paragraph") {
      defaultParagraphStyleId = id;
    }
  }
  const paragraphStyles = byType.get("paragraph") ?? new Map<string, StyleRecord>();
  const characterStyles = byType.get("character") ?? new Map<string, StyleRecord>();
  const tableStyles = byType.get("table") ?? new Map<string, StyleRecord>();
  const docDefaults = elements(doc, "w:docDefaults")[0];
  const defaultParagraphPr = propertyChild(childNamed(docDefaults, "pPrDefault"), "pPr");
  const defaultRunPr = propertyChild(childNamed(docDefaults, "rPrDefault"), "rPr");
  const chain = (
    typed: Map<string, StyleRecord>,
    styleId: string | undefined,
    property: "pPr" | "rPr" | "tblPr",
    defaults: XmlElement | undefined,
  ): XmlElement[] => {
    const properties: XmlElement[] = [];
    const seen = new Set<string>();
    let current = styleId;
    while (current && !seen.has(current) && seen.size < MAX_STYLE_CHAIN) {
      seen.add(current);
      const record = typed.get(current);
      if (!record) {
        break;
      }
      const value = record[property];
      if (value) {
        properties.push(value);
      }
      current = record.basedOn;
    }
    if (defaults) {
      properties.push(defaults);
    }
    return properties;
  };

  const paragraphStyleName = (styleId: string | undefined): string | undefined =>
    styleId ? paragraphStyles.get(styleId)?.name : undefined;
  const defaultFontSizePt = readFontSize(
    chain(paragraphStyles, defaultParagraphStyleId, "rPr", defaultRunPr),
  );
  return {
    theme,
    defaultFontSizePt: defaultFontSizePt ?? 11,
    paragraphChain: (direct, styleId) => [
      ...(direct ? [direct] : []),
      ...chain(paragraphStyles, styleId ?? defaultParagraphStyleId, "pPr", defaultParagraphPr),
    ],
    runChain: (direct, paragraphStyleId, runStyleId) => [
      ...(direct ? [direct] : []),
      ...chain(characterStyles, runStyleId, "rPr", undefined),
      ...chain(characterStyles, defaultCharacterStyleId, "rPr", undefined),
      ...chain(paragraphStyles, paragraphStyleId ?? defaultParagraphStyleId, "rPr", undefined),
      ...(defaultRunPr ? [defaultRunPr] : []),
    ],
    paragraphStyleName,
    tableChain: (direct, styleId) => [
      ...(direct ? [direct] : []),
      ...chain(tableStyles, styleId, "tblPr", undefined),
    ],
  };
}

function findProperty(chain: readonly XmlElement[], name: string): XmlElement | undefined {
  for (const properties of chain) {
    const found = propertyChild(properties, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Reads Office's boolean property elements, where explicit `0` means off. */
function onOff(element: XmlElement): boolean {
  const value = valAttribute(element)?.toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

function readFontSize(chain: readonly XmlElement[]): number | undefined {
  const size = Number.parseFloat(valAttribute(findProperty(chain, "sz")) ?? "");
  return Number.isFinite(size) && size >= 2 && size <= 800 ? Math.round(size) / 2 : undefined;
}

function themeFontFor(rFonts: XmlElement | undefined, theme: OfficeTheme): string | undefined {
  const ascii = wordAttribute(rFonts, "ascii");
  if (ascii) {
    return ascii;
  }
  const themed =
    wordAttribute(rFonts, "asciiTheme")?.toLowerCase() ??
    wordAttribute(rFonts, "hAnsiTheme")?.toLowerCase();
  if (!themed) {
    return undefined;
  }
  return themed.startsWith("major") ? theme.majorFont : theme.minorFont;
}

/** Resolves typed run facts (everything except text) from one run property chain. */
export function resolveRunStyle(
  chain: readonly XmlElement[],
  resolver: DocxStyleResolver,
): Omit<SessionFileOfficeRun, "text"> {
  const style: Omit<SessionFileOfficeRun, "text"> = {};
  const bold = findProperty(chain, "b");
  const italic = findProperty(chain, "i");
  const underline = findProperty(chain, "u");
  const strike = findProperty(chain, "strike");
  if (bold && onOff(bold)) {
    style.bold = true;
  }
  if (italic && onOff(italic)) {
    style.italic = true;
  }
  if (underline && onOff(underline)) {
    style.underline = true;
  }
  if (strike && onOff(strike)) {
    style.strike = true;
  }
  const fontSizePt = readFontSize(chain);
  if (fontSizePt !== undefined) {
    style.fontSizePt = fontSizePt;
  }
  const fontName = themeFontFor(findProperty(chain, "rFonts"), resolver.theme);
  if (fontName) {
    style.fontName = fontName.slice(0, 64);
  }
  const color = resolveWordColor(findProperty(chain, "color"), resolver.theme);
  if (color) {
    style.color = color;
  }
  const vertAlign = valAttribute(findProperty(chain, "vertAlign"));
  if (vertAlign === "superscript" || vertAlign === "subscript") {
    style.verticalAlign = vertAlign;
  }
  return style;
}

type ParagraphLayout = {
  alignment?: NonNullable<SessionFileOfficeParagraph["alignment"]>;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacingPt?: number;
  indentLeftPt?: number;
  indentRightPt?: number;
  indentFirstLinePt?: number;
  numId?: number;
  ilvl?: number;
  outlineLevel?: number;
};

/** Resolves paragraph layout facts from the effective paragraph property chain. */
export function resolveParagraphLayout(
  chain: readonly XmlElement[],
  defaultFontSizePt: number,
): ParagraphLayout {
  const layout: ParagraphLayout = {};
  const jc = valAttribute(findProperty(chain, "jc"));
  if (jc === "left" || jc === "start") {
    layout.alignment = "left";
  } else if (jc === "center") {
    layout.alignment = "center";
  } else if (jc === "right" || jc === "end") {
    layout.alignment = "right";
  } else if (jc === "both" || jc === "distribute" || jc === "thaiDistribute") {
    layout.alignment = "justify";
  }
  const spacing = findProperty(chain, "spacing");
  if (spacing) {
    const before = twipsToPoints(wordAttribute(spacing, "before"));
    const after = twipsToPoints(wordAttribute(spacing, "after"));
    if (before !== undefined) {
      layout.spaceBeforePt = Math.min(1_000, before);
    }
    if (after !== undefined) {
      layout.spaceAfterPt = Math.min(1_000, after);
    }
    const line = Number.parseFloat(wordAttribute(spacing, "line") ?? "");
    const rule = wordAttribute(spacing, "lineRule");
    if (Number.isFinite(line) && line > 0) {
      // `auto` counts 240ths of a line; exact/atLeast counts twips.
      const points = rule === "auto" ? (line / 240) * defaultFontSizePt : line / 20;
      layout.lineSpacingPt = Math.min(1_000, Math.round(points * 10) / 10);
    }
  }
  const indent = findProperty(chain, "ind");
  if (indent) {
    const left = twipsToPoints(wordAttribute(indent, "left") ?? wordAttribute(indent, "start"));
    const right = twipsToPoints(wordAttribute(indent, "right") ?? wordAttribute(indent, "end"));
    const firstLine = twipsToPoints(wordAttribute(indent, "firstLine"));
    const hanging = twipsToPoints(wordAttribute(indent, "hanging"));
    if (left !== undefined) {
      layout.indentLeftPt = Math.min(2_000, left);
    }
    if (right !== undefined) {
      layout.indentRightPt = Math.min(2_000, right);
    }
    if (firstLine !== undefined) {
      layout.indentFirstLinePt = Math.min(2_000, firstLine);
    } else if (hanging !== undefined) {
      layout.indentFirstLinePt = -Math.min(2_000, hanging);
    }
  }
  const numPr = findProperty(chain, "numPr");
  if (numPr) {
    const numId = Number.parseInt(valAttribute(childNamed(numPr, "numId")) ?? "", 10);
    const ilvl = Number.parseInt(valAttribute(childNamed(numPr, "ilvl")) ?? "", 10);
    if (Number.isSafeInteger(numId) && numId >= 0) {
      layout.numId = numId;
    }
    if (Number.isSafeInteger(ilvl) && ilvl >= 0 && ilvl <= 8) {
      layout.ilvl = ilvl;
    }
  }
  const outlineLevel = Number.parseInt(valAttribute(findProperty(chain, "outlineLvl")) ?? "", 10);
  if (Number.isSafeInteger(outlineLevel) && outlineLevel >= 0 && outlineLevel <= 8) {
    layout.outlineLevel = outlineLevel;
  }
  return layout;
}

/** Resolves the semantic role Word itself uses for titles, headings, and lists. */
export function resolveParagraphRole(params: {
  styleId: string | undefined;
  styleName: string | undefined;
  outlineLevel: number | undefined;
  isList: boolean;
}): { role: NonNullable<SessionFileOfficeParagraph["role"]>; level?: number } {
  const styleName = params.styleName?.trim();
  const styleId = params.styleId?.trim();
  if (styleName?.toLowerCase() === "title" || styleId?.toLowerCase() === "title") {
    return { role: "title" };
  }
  const heading = styleName?.match(HEADING_NAME) ?? styleId?.match(HEADING_NAME);
  if (heading) {
    return {
      role: "heading",
      level: Math.max(1, Math.min(6, Number.parseInt(heading[1] ?? "1", 10))),
    };
  }
  if (params.outlineLevel !== undefined && params.outlineLevel <= 5) {
    return { role: "heading", level: params.outlineLevel + 1 };
  }
  return params.isList ? { role: "listItem" } : { role: "body" };
}

/** First `w:tblBorders` found in a table property chain. */
export function findTableBorders(chain: readonly XmlElement[]): XmlElement | undefined {
  return findProperty(chain, "tblBorders");
}

/** Reads the direct table style id from a table's properties. */
export function tableStyleId(tblPr: XmlElement | undefined): string | undefined {
  return valAttribute(propertyChild(tblPr, "tblStyle"));
}

/** Direct children of a table row, used by the table reader. */
export function tableCells(row: XmlElement): XmlElement[] {
  return childrenNamed(row, "tc");
}

export function localTagName(element: XmlElement): string {
  return localName(element.nodeName);
}
