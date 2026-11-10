/**
 * Theme, indexed-palette, and unit helpers shared by the DOCX and XLSX readers.
 *
 * Documents store most visible colors as theme slots, tints, or legacy indexed
 * palette entries. Resolving them here keeps the wire payload to plain
 * `#rrggbb` values and prevents the renderer from knowing OOXML color rules.
 */
import type { SessionFileOfficePreview } from "../../../packages/gateway-protocol/src/index.js";
import {
  attribute,
  childNamed,
  elementChildren,
  elements,
  localName,
  tryParseXml,
  wordAttribute,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

/** Canonical theme color slots from `a:clrScheme`. */
export type OfficeTheme = {
  colors: Partial<Record<ThemeColorSlot, string>>;
  majorFont?: string;
  minorFont?: string;
};

export type ThemeColorSlot =
  | "dk1"
  | "lt1"
  | "dk2"
  | "lt2"
  | "accent1"
  | "accent2"
  | "accent3"
  | "accent4"
  | "accent5"
  | "accent6"
  | "hlink"
  | "folHlink";

const THEME_SLOT_NAMES: ReadonlySet<string> = new Set([
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
]);

/** Excel addresses theme slots as `theme="0..11"` in this order. */
const EXCEL_THEME_ORDER: readonly ThemeColorSlot[] = [
  "lt1",
  "dk1",
  "lt2",
  "dk2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];

/** WordprocessingML theme names and their scheme slots. */
const WORD_THEME_NAMES: Record<string, ThemeColorSlot> = {
  dark1: "dk1",
  light1: "lt1",
  dark2: "dk2",
  light2: "lt2",
  text1: "dk1",
  background1: "lt1",
  text2: "dk2",
  background2: "lt2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hyperlink: "hlink",
  followedHyperlink: "folHlink",
};

const EXCEL_INDEXED_COLORS = [
  "000000",
  "ffffff",
  "ff0000",
  "00ff00",
  "0000ff",
  "ffff00",
  "ff00ff",
  "00ffff",
  "000000",
  "ffffff",
  "ff0000",
  "00ff00",
  "0000ff",
  "ffff00",
  "ff00ff",
  "00ffff",
  "800000",
  "008000",
  "000080",
  "808000",
  "800080",
  "008080",
  "c0c0c0",
  "808080",
  "9999ff",
  "993366",
  "ffffcc",
  "ccffff",
  "660066",
  "ff8080",
  "0066cc",
  "ccccff",
  "000080",
  "ff00ff",
  "ffff00",
  "00ffff",
  "800080",
  "800000",
  "008080",
  "0000ff",
  "00ccff",
  "ccffff",
  "ccffcc",
  "ffff99",
  "99ccff",
  "ff99cc",
  "cc99ff",
  "ffcc99",
  "3366ff",
  "33cccc",
  "99cc00",
  "ffcc00",
  "ff9900",
  "ff6600",
  "666699",
  "969696",
  "003366",
  "339966",
  "003300",
  "333300",
  "993300",
  "993366",
  "333399",
  "333333",
] as const;

/** Normalizes `RRGGBB`, `AARRGGBB`, and `#rrggbb` values to lowercase hex. */
export function normalizeHexColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const digits = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const hex = digits.length === 8 ? digits.slice(2) : digits;
  return /^[0-9a-fA-F]{6}$/u.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

function themeColorFromScheme(element: XmlElement): string | undefined {
  const srgb = childNamed(element, "srgbClr");
  const fromSrgb = normalizeHexColor(attribute(srgb, "val"));
  if (fromSrgb) {
    return fromSrgb;
  }
  return normalizeHexColor(attribute(childNamed(element, "sysClr"), "lastClr"));
}

/** Reads the theme part; missing or malformed themes resolve no colors. */
export function readOfficeTheme(archive: OfficeZipArchive, themePath: string): OfficeTheme {
  const xml = archive.readText(themePath);
  const doc = xml ? tryParseXml(xml) : undefined;
  const theme: OfficeTheme = { colors: {} };
  if (!doc) {
    return theme;
  }
  const scheme = elements(doc, "a:clrScheme")[0];
  if (scheme) {
    for (const child of elementChildren(scheme)) {
      const slot = localName(child.nodeName);
      if (!THEME_SLOT_NAMES.has(slot)) {
        continue;
      }
      const color = themeColorFromScheme(child);
      if (color && isThemeColorSlot(slot)) {
        theme.colors[slot] = color;
      }
    }
  }
  const majorFont = elements(doc, "a:majorFont")[0];
  const minorFont = elements(doc, "a:minorFont")[0];
  theme.majorFont = attribute(childNamed(majorFont, "latin"), "typeface");
  theme.minorFont = attribute(childNamed(minorFont, "latin"), "typeface");
  return theme;
}

/** Applies an Excel tint (-1..1) to one hex color. */
export function applyExcelTint(color: string, tint: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const bounded = Math.max(-1, Math.min(1, tint));
  return `#${channels
    .map((channel) =>
      Math.round(
        Math.max(
          0,
          Math.min(
            255,
            bounded < 0 ? channel * (1 + bounded) : channel + (255 - channel) * bounded,
          ),
        ),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Applies Word's byte tint (lighten) and shade (darken) attributes. */
export function applyWordTintShade(
  color: string,
  tint: string | undefined,
  shade: string | undefined,
): string {
  const tintValue = tint ? Number.parseInt(tint, 16) / 255 : 0;
  const shadeValue = shade ? Number.parseInt(shade, 16) / 255 : 1;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  return `#${channels
    .map((channel) => {
      const lightened = Number.isFinite(tintValue)
        ? channel + (255 - channel) * Math.max(0, Math.min(1, tintValue))
        : channel;
      const darkened = Number.isFinite(shadeValue) ? lightened * shadeValue : lightened;
      return Math.round(Math.max(0, Math.min(255, darkened)))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/**
 * Resolves an Excel color element (`rgb`/`theme`+`tint`/`indexed`).
 * System colors and invalid values resolve to undefined so renderers inherit.
 */
export function resolveExcelColor(
  element: XmlElement | undefined,
  theme: OfficeTheme,
): string | undefined {
  if (!element) {
    return undefined;
  }
  if (attribute(element, "auto") === "1") {
    return undefined;
  }
  const direct = normalizeHexColor(attribute(element, "rgb"));
  if (direct) {
    return direct;
  }
  const themeIndex = Number.parseInt(attribute(element, "theme") ?? "", 10);
  const slot = Number.isSafeInteger(themeIndex) ? EXCEL_THEME_ORDER[themeIndex] : undefined;
  const themeColor = slot ? theme.colors[slot] : undefined;
  if (themeColor) {
    const tint = Number.parseFloat(attribute(element, "tint") ?? "");
    return Number.isFinite(tint) ? applyExcelTint(themeColor, tint) : themeColor;
  }
  const indexed = Number.parseInt(attribute(element, "indexed") ?? "", 10);
  if (Number.isSafeInteger(indexed) && indexed >= 0 && indexed < EXCEL_INDEXED_COLORS.length) {
    return `#${EXCEL_INDEXED_COLORS[indexed]}`;
  }
  return undefined;
}

/** Resolves a WordprocessingML `w:color` element. */
export function resolveWordColor(
  element: XmlElement | undefined,
  theme: OfficeTheme,
): string | undefined {
  if (!element) {
    return undefined;
  }
  const direct = normalizeHexColor(wordAttribute(element, "val"));
  if (direct) {
    return direct;
  }
  const slot = WORD_THEME_NAMES[(wordAttribute(element, "themeColor") ?? "").toLowerCase()];
  const themeColor = slot ? theme.colors[slot] : undefined;
  if (!themeColor) {
    return undefined;
  }
  return applyWordTintShade(
    themeColor,
    wordAttribute(element, "themeTint"),
    wordAttribute(element, "themeShade"),
  );
}

/** Excel column widths and Word lengths are stored in twips (1/20 pt). */
export function twipsToPoints(value: string | undefined): number | undefined {
  const twips = Number.parseFloat(value ?? "");
  return Number.isFinite(twips) && twips >= 0 ? Math.round((twips / 20) * 10) / 10 : undefined;
}

/** DrawingML extents are EMUs; 1 pt = 12,700 EMU. */
export function emuToPoints(value: string | undefined): number | undefined {
  const emu = Number.parseFloat(value ?? "");
  return Number.isFinite(emu) && emu >= 0 ? Math.round((emu / 12_700) * 10) / 10 : undefined;
}

/** Normalizes a WordprocessingML shading fill (`D9E2F3` or `auto`). */
export function wordShadingFill(element: XmlElement | undefined): string | undefined {
  const fill = wordAttribute(element, "fill");
  return fill && fill.toLowerCase() !== "auto" ? normalizeHexColor(fill) : undefined;
}

function isThemeColorSlot(value: string): value is ThemeColorSlot {
  return THEME_SLOT_NAMES.has(value);
}

/** Parses one bounded numeric attribute. */
export function numericAttribute(
  element: XmlElement | undefined,
  name: string,
  bounds?: { min?: number; max?: number },
): number | undefined {
  const value = Number.parseFloat(attribute(element, name) ?? "");
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds?.max ?? Number.POSITIVE_INFINITY;
  return value >= min && value <= max ? value : undefined;
}

/** Collects omitted-feature notices without unbounded growth. */
export class OmittedFeatureCounter {
  private readonly counts = new Map<SessionFileOfficeOmitted["feature"], number>();

  add(feature: SessionFileOfficeOmitted["feature"], count = 1): void {
    if (count < 0) {
      return;
    }
    // A zero count records an approximation notice such as exact pagination.
    this.counts.set(feature, Math.min(100_000, (this.counts.get(feature) ?? 0) + count));
  }

  /** True when the feature has been reported at least once. */
  has(feature: SessionFileOfficeOmitted["feature"]): boolean {
    return this.counts.has(feature);
  }

  list(): SessionFileOfficeOmitted[] {
    return [...this.counts.entries()].slice(0, 20).map(([feature, count]) => ({
      feature,
      count: Math.min(count, 100_000),
    }));
  }
}

type SessionFileOfficeOmitted = NonNullable<SessionFileOfficePreview["omitted"]>[number];
