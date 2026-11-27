/**
 * Theme, master, and layout context for the PPTX slide reader.
 *
 * Slides inherit almost everything visible: placeholder boxes come from the
 * slide layout (then the master), and paragraph typography comes from the
 * master's `p:txStyles` merged with the package theme. Resolving that here keeps
 * the wire payload to plain boxes, resolved colors, and concrete run styles, so
 * the renderer never re-implements OOXML inheritance.
 */
import type { SessionFileOfficeParagraph } from "../../../packages/gateway-protocol/src/index.js";
import { readOfficeTheme, type ThemeColorSlot } from "./office-preview-theme.js";
import {
  attribute,
  childNamed,
  childrenNamed,
  elements,
  resolvePackagePath,
  tryParseXml,
  type XmlDocumentBody,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

type PptxAlignment = NonNullable<SessionFileOfficeParagraph["alignment"]>;

/** One rectangle in slide points, already resolved to the slide canvas. */
export type PptxFrame = { xPt: number; yPt: number; widthPt: number; heightPt: number };

/** One resolved level of a master text style, already merged with the theme. */
export type PptxTextLevel = {
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fontName?: string;
  alignment?: PptxAlignment;
  bulletChar?: string;
  autoNumber?: string;
  bulletNone?: boolean;
  indentLeftPt?: number;
  indentFirstLinePt?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacingPt?: number;
  lineSpacingPct?: number;
};

export type PptxTextStyles = {
  title: PptxTextLevel[];
  body: PptxTextLevel[];
  other: PptxTextLevel[];
};

export type PptxTheme = {
  colors: Partial<Record<ThemeColorSlot, string>>;
  /** Master `p:clrMap`: scheme name such as `bg1` or `tx2` to theme slot. */
  clrMap: Record<string, ThemeColorSlot>;
  majorFont?: string;
  minorFont?: string;
};

const DEFAULT_CLR_MAP: Record<string, ThemeColorSlot> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

const THEME_SLOT_BY_NAME: Readonly<Record<string, ThemeColorSlot>> = {
  dk1: "dk1",
  lt1: "lt1",
  dk2: "dk2",
  lt2: "lt2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

/** 1 pt = 12,700 EMU; slide transforms store signed EMUs. */
export function pptxPoints(value: string | undefined): number | undefined {
  const emu = Number.parseFloat(value ?? "");
  return Number.isFinite(emu) ? Math.round((emu / 12_700) * 10) / 10 : undefined;
}

function boundedPoints(value: string | undefined, max: number): number | undefined {
  const points = pptxPoints(value);
  return points === undefined ? undefined : Math.max(0, Math.min(max, points));
}

/** Indents share the paragraph schema's +/-2,000pt bound (negative is hanging). */
function signedPoints(value: string | undefined): number | undefined {
  const points = pptxPoints(value);
  return points === undefined ? undefined : Math.max(-2_000, Math.min(2_000, points));
}

function hexChannels(color: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}

function toHex(channels: readonly number[]): string {
  return `#${channels
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** DrawingML color modifiers are percentages in 1000ths of a percent. */
function colorPercentage(element: XmlElement | undefined): number | undefined {
  const value = Number.parseFloat(attribute(element, "val") ?? "");
  return Number.isFinite(value) ? value / 100_000 : undefined;
}

/** Applies DrawingML shade/tint/lumMod/lumOff modifiers declared on a scheme color. */
function applyColorModifiers(color: string, scheme: XmlElement): string {
  let channels = hexChannels(color);
  const shade = colorPercentage(childNamed(scheme, "shade"));
  const tint = colorPercentage(childNamed(scheme, "tint"));
  const lumMod = colorPercentage(childNamed(scheme, "lumMod"));
  const lumOff = colorPercentage(childNamed(scheme, "lumOff"));
  if (shade !== undefined) {
    channels = channels.map((channel) => channel * shade);
  }
  if (tint !== undefined) {
    channels = channels.map((channel) => channel * tint + 255 * (1 - tint));
  }
  if (lumMod !== undefined || lumOff !== undefined) {
    channels = channels.map((channel) => channel * (lumMod ?? 1) + 255 * (lumOff ?? 0));
  }
  return toHex(channels);
}

function hexOrUndefined(value: string | undefined): string | undefined {
  return value && /^[0-9a-fA-F]{6}$/u.test(value) ? `#${value.toLowerCase()}` : undefined;
}

/**
 * Resolves one DrawingML color element (`a:srgbClr`, `a:schemeClr`, `a:prstClr`,
 * `a:sysClr`) to `#rrggbb`. Unknown names keep the caller's default so text
 * never turns invisible.
 */
export function resolveDrawingColor(
  element: XmlElement | undefined,
  theme: PptxTheme,
): string | undefined {
  if (!element) {
    return undefined;
  }
  const direct = hexOrUndefined(attribute(childNamed(element, "srgbClr"), "val"));
  if (direct) {
    return direct;
  }
  const scheme = childNamed(element, "schemeClr");
  const schemeName = attribute(scheme, "val");
  if (scheme && schemeName) {
    const slot = THEME_SLOT_BY_NAME[schemeName] ?? theme.clrMap[schemeName];
    const base = slot ? theme.colors[slot] : undefined;
    if (base) {
      return applyColorModifiers(base, scheme);
    }
  }
  return (
    hexOrUndefined(attribute(childNamed(element, "prstClr"), "val")) ??
    hexOrUndefined(attribute(childNamed(element, "sysClr"), "lastClr"))
  );
}

/** Gradient fills collapse to their first resolvable stop. */
export function gradientFirstStop(
  gradient: XmlElement | undefined,
  theme: PptxTheme,
): string | undefined {
  for (const stop of childrenNamed(childNamed(gradient, "gsLst"), "gs")) {
    const color = resolveDrawingColor(stop, theme);
    if (color) {
      return color;
    }
  }
  return undefined;
}

/** Solid fill of a shape/text property element, or `undefined` for no fill. */
export function solidFillColor(
  properties: XmlElement | undefined,
  theme: PptxTheme,
): string | undefined {
  return resolveDrawingColor(childNamed(properties, "solidFill"), theme);
}

/** Theme font references (`+mj-lt`, `+mn-lt`) resolve to the theme's faces. */
export function themeFontFace(typeface: string | undefined, theme: PptxTheme): string | undefined {
  if (!typeface) {
    return undefined;
  }
  const face =
    typeface === "+mj-lt"
      ? theme.majorFont
      : typeface === "+mn-lt"
        ? theme.minorFont
        : typeface.startsWith("+")
          ? undefined
          : typeface;
  return face ? face.slice(0, 64) : undefined;
}

/** Reads the theme part plus the master's `p:clrMap` into one resolver context. */
export function readPptxTheme(
  archive: OfficeZipArchive,
  themePath: string | undefined,
  master: XmlDocumentBody | undefined,
): PptxTheme {
  const base = themePath ? readOfficeTheme(archive, themePath) : { colors: {} };
  const theme: PptxTheme = {
    colors: base.colors,
    clrMap: { ...DEFAULT_CLR_MAP },
    majorFont: base.majorFont,
    minorFont: base.minorFont,
  };
  const clrMap = master ? elements(master, "p:clrMap")[0] : undefined;
  for (const key of Object.keys(DEFAULT_CLR_MAP)) {
    const slot = THEME_SLOT_BY_NAME[attribute(clrMap, key) ?? ""];
    if (slot) {
      theme.clrMap[key] = slot;
    }
  }
  return theme;
}

/** Placeholder box lookup: `i<idx>` first, normalized `t<type>` second. */
export type PptxPlaceholders = Map<string, PptxFrame>;

const PLACEHOLDER_TYPE_ALIASES: Readonly<Record<string, string>> = {
  ctrTitle: "title",
  title: "title",
  subTitle: "subtitle",
  body: "body",
  obj: "body",
};

/** Placeholder roles normalize so a `ctrTitle` slide matches a `title` layout box. */
function normalizePlaceholderType(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  return PLACEHOLDER_TYPE_ALIASES[type] ?? type;
}

function readFrame(xfrm: XmlElement | undefined): PptxFrame | undefined {
  if (!xfrm) {
    return undefined;
  }
  const off = childNamed(xfrm, "off");
  const ext = childNamed(xfrm, "ext");
  const xPt = boundedPoints(attribute(off, "x"), 4_000);
  const yPt = boundedPoints(attribute(off, "y"), 4_000);
  const widthPt = boundedPoints(attribute(ext, "cx"), 4_000);
  const heightPt = boundedPoints(attribute(ext, "cy"), 4_000);
  if (xPt === undefined || yPt === undefined || widthPt === undefined || heightPt === undefined) {
    return undefined;
  }
  return { xPt, yPt, widthPt, heightPt };
}

/** Reads one shape's own `a:xfrm` box, when it declares one. */
export function shapeXfrmFrame(shape: XmlElement): PptxFrame | undefined {
  const properties = elements(shape, "p:spPr")[0] ?? elements(shape, "p:grpSpPr")[0];
  return readFrame(properties ? elements(properties, "a:xfrm")[0] : undefined);
}

/** Placeholder boxes declared by one layout or master part. */
export function readPlaceholderFrames(doc: XmlDocumentBody | undefined): PptxPlaceholders {
  const frames: PptxPlaceholders = new Map();
  if (!doc) {
    return frames;
  }
  for (const shape of elements(doc, "p:sp")) {
    const placeholder = elements(shape, "p:ph")[0];
    if (!placeholder) {
      continue;
    }
    const frame = shapeXfrmFrame(shape);
    if (!frame) {
      continue;
    }
    const idx = attribute(placeholder, "idx");
    if (idx) {
      frames.set(`i${idx}`, frame);
    }
    const type = normalizePlaceholderType(attribute(placeholder, "type"));
    if (type && !frames.has(`t${type}`)) {
      frames.set(`t${type}`, frame);
    }
  }
  return frames;
}

/** Resolves one shape's placeholder box, preferring its own `idx`. */
export function placeholderFrame(
  placeholders: PptxPlaceholders,
  placeholder: XmlElement | undefined,
): PptxFrame | undefined {
  if (!placeholder) {
    return undefined;
  }
  const idx = attribute(placeholder, "idx");
  if (idx) {
    const byIndex = placeholders.get(`i${idx}`);
    if (byIndex) {
      return byIndex;
    }
  }
  const type = normalizePlaceholderType(attribute(placeholder, "type"));
  return type ? placeholders.get(`t${type}`) : undefined;
}

export function alignmentFromAttribute(value: string | undefined): PptxAlignment | undefined {
  switch (value) {
    case "l":
      return "left";
    case "ctr":
      return "center";
    case "r":
      return "right";
    case "just":
    case "dist":
      return "justify";
    default:
      return undefined;
  }
}

function spacingPoints(container: XmlElement | undefined): number | undefined {
  const points = Number.parseFloat(attribute(childNamed(container, "spcPts"), "val") ?? "");
  return Number.isFinite(points) && points >= 0
    ? Math.min(1_000, Math.round((points / 100) * 10) / 10)
    : undefined;
}

/** Reads one `a:lvlNpPr` level into concrete paragraph/run defaults. */
export function readTextLevel(level: XmlElement | undefined, theme: PptxTheme): PptxTextLevel {
  if (!level) {
    return {};
  }
  const properties = childNamed(level, "defRPr");
  const size = Number.parseFloat(attribute(properties, "sz") ?? "");
  const lineSpacing = childNamed(level, "lnSpc");
  const lineSpacingPoints = Number.parseFloat(
    attribute(childNamed(lineSpacing, "spcPts"), "val") ?? "",
  );
  const lineSpacingPercent = Number.parseFloat(
    attribute(childNamed(lineSpacing, "spcPct"), "val") ?? "",
  );
  const color = solidFillColor(properties, theme);
  const fontName = themeFontFace(attribute(childNamed(properties, "latin"), "typeface"), theme);
  const alignment = alignmentFromAttribute(attribute(level, "algn"));
  const bulletChar = attribute(childNamed(level, "buChar"), "char");
  const autoNumber = attribute(childNamed(level, "buAutoNum"), "type");
  const indentLeftPt = boundedPoints(attribute(level, "marL"), 2_000);
  const indentFirstLinePt = signedPoints(attribute(level, "indent"));
  const spaceBeforePt = spacingPoints(childNamed(level, "spcBef"));
  const spaceAfterPt = spacingPoints(childNamed(level, "spcAft"));
  const underline = attribute(properties, "u");
  const strike = attribute(properties, "strike");
  return {
    ...(Number.isFinite(size) && size > 0
      ? { fontSizePt: Math.min(400, Math.max(1, Math.round((size / 100) * 10) / 10)) }
      : {}),
    ...(attribute(properties, "b") === "1" ? { bold: true } : {}),
    ...(attribute(properties, "i") === "1" ? { italic: true } : {}),
    ...(underline && underline !== "none" ? { underline: true } : {}),
    ...(strike && strike !== "noStrike" ? { strike: true } : {}),
    ...(color ? { color } : {}),
    ...(fontName ? { fontName } : {}),
    ...(alignment ? { alignment } : {}),
    ...(bulletChar ? { bulletChar: bulletChar.slice(0, 8) } : {}),
    ...(autoNumber ? { autoNumber } : {}),
    ...(childNamed(level, "buNone") ? { bulletNone: true } : {}),
    ...(indentLeftPt !== undefined ? { indentLeftPt } : {}),
    ...(indentFirstLinePt !== undefined ? { indentFirstLinePt } : {}),
    ...(spaceBeforePt !== undefined ? { spaceBeforePt } : {}),
    ...(spaceAfterPt !== undefined ? { spaceAfterPt } : {}),
    ...(Number.isFinite(lineSpacingPoints) && lineSpacingPoints > 0
      ? { lineSpacingPt: Math.min(1_000, Math.round((lineSpacingPoints / 100) * 10) / 10) }
      : {}),
    ...(Number.isFinite(lineSpacingPercent) && lineSpacingPercent > 0
      ? { lineSpacingPct: Math.round((lineSpacingPercent / 100_000) * 1_000) / 1_000 }
      : {}),
  };
}

function readStyleLevels(style: XmlElement | undefined, theme: PptxTheme): PptxTextLevel[] {
  return Array.from({ length: 9 }, (_, index) =>
    readTextLevel(childNamed(style, `lvl${index + 1}pPr`), theme),
  );
}

export type PptxMasterStyles = { styles: PptxTextStyles };

/** Reads the master's `p:txStyles`; missing levels keep empty defaults. */
export function readMasterStyles(
  master: XmlDocumentBody | undefined,
  theme: PptxTheme,
): PptxMasterStyles {
  const txStyles = master ? elements(master, "p:txStyles")[0] : undefined;
  return {
    styles: {
      title: readStyleLevels(childNamed(txStyles, "titleStyle"), theme),
      body: readStyleLevels(childNamed(txStyles, "bodyStyle"), theme),
      other: readStyleLevels(childNamed(txStyles, "otherStyle"), theme),
    },
  };
}

/** Which master style a shape's placeholder uses. */
export function styleRoleForPlaceholder(placeholder: XmlElement | undefined): keyof PptxTextStyles {
  const type = normalizePlaceholderType(attribute(placeholder, "type"));
  if (type === "title") {
    return "title";
  }
  return type === "body" || type === "subtitle" ? "body" : "other";
}

/** Parses one package part; malformed or missing parts resolve nothing. */
export function parsePartXml(
  archive: OfficeZipArchive,
  path: string | undefined,
): XmlDocumentBody | undefined {
  const xml = path ? archive.readText(path) : undefined;
  return xml ? tryParseXml(xml) : undefined;
}

/** Internal relationship id -> part path and relationship-local type name. */
export type PptxRelationships = Map<string, { path: string; type: string }>;

/** Reads a part's relationships; external targets are never resolved. */
export function readTypedRelationships(
  archive: OfficeZipArchive,
  relsPath: string,
  baseDir: string,
): PptxRelationships {
  const relationships: PptxRelationships = new Map();
  const xml = archive.readText(relsPath);
  const doc = xml ? tryParseXml(xml) : undefined;
  if (!doc) {
    return relationships;
  }
  for (const relationship of elements(doc, "Relationship")) {
    const id = attribute(relationship, "Id");
    const target = attribute(relationship, "Target");
    if (!id || !target || attribute(relationship, "TargetMode") === "External") {
      continue;
    }
    const resolved = resolvePackagePath(baseDir, target);
    if (resolved) {
      relationships.set(id, {
        path: resolved,
        type: (attribute(relationship, "Type") ?? "").split("/").at(-1) ?? "",
      });
    }
  }
  return relationships;
}

/** Sibling relationships part for a package part (`ppt/slides/slide1.xml`). */
export function relationshipsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
}

/** First relationship of a given type (e.g. `slideLayout` or `theme`). */
export function firstRelationshipOfType(
  relationships: ReadonlyMap<string, { path: string; type: string }>,
  type: string,
): string | undefined {
  for (const entry of relationships.values()) {
    if (entry.type === type) {
      return entry.path;
    }
  }
  return undefined;
}
