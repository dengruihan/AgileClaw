/**
 * Font metrics and WinAnsi/UCS2 routing for the dependency-free PDF writer.
 *
 * The writer embeds no font programs: Latin text uses the PDF base-14 families
 * (every viewer ships their metrics) and CJK text uses the predefined ADBE CID
 * fonts for its script (Adobe-GB1, Adobe-Japan1, Adobe-Korea1), which viewers
 * substitute with a locally installed font.
 *
 * Only scripts those orderings actually carry are routed to them. Every other
 * code point — Arabic, Hebrew, Thai, Armenian, Devanagari, dingbats, and astral
 * characters — takes the visible marker so the export never silently rewrites a
 * character into an unrelated glyph.
 */

export type PdfTextStyle = { bold?: boolean; italic?: boolean; code?: boolean };

export type PdfCjkFamily = "gb" | "jp" | "kr";

export type PdfFontKey =
  | "regular"
  | "bold"
  | "italic"
  | "boldItalic"
  | "code"
  | "codeBold"
  | "cjkGb"
  | "cjkJp"
  | "cjkKr";

/** Visible replacement for characters the predefined CID fonts cannot carry. */
export const PDF_UNSUPPORTED_MARKER = "\u25A1";

/**
 * Non-WinAnsi BMP ranges the predefined orderings carry.
 *
 * Han characters, CJK punctuation, fullwidth forms, and the symbol rows that
 * GB2312 defines travel through Adobe-GB1; kana and the arrow/math/technical
 * symbol rows travel through Adobe-Japan1; Hangul travels through Adobe-Korea1.
 * Scripts outside this table would be mapped to unrelated glyphs, so they are
 * replaced instead. Ranges stay conservative on purpose: a rare symbol may fall
 * outside them, while a mis-mapped letter never can.
 */
const SUPPORTED_RANGES: readonly {
  start: number;
  end: number;
  family: PdfCjkFamily;
}[] = [
  // Script-specific blocks first: a kana or Hangul code point must never be
  // captured by a neighbouring symbol range.
  { start: 0x1100, end: 0x11ff, family: "kr" },
  { start: 0x3130, end: 0x318f, family: "kr" },
  { start: 0xac00, end: 0xd7af, family: "kr" },
  { start: 0xffa0, end: 0xffdc, family: "kr" },
  { start: 0x3040, end: 0x30ff, family: "jp" },
  { start: 0x31f0, end: 0x31ff, family: "jp" },
  { start: 0xff65, end: 0xff9f, family: "jp" },
  // Greek and Cyrillic letters carried by GB2312.
  { start: 0x0391, end: 0x03a9, family: "gb" },
  { start: 0x03b1, end: 0x03c9, family: "gb" },
  { start: 0x0401, end: 0x0401, family: "gb" },
  { start: 0x0410, end: 0x044f, family: "gb" },
  { start: 0x0451, end: 0x0451, family: "gb" },
  // Arrows, math, enclosed numbers, box drawing, and geometric rows: Japan1 maps
  // every code point here, while GB1 drops some (for example the double arrow),
  // so the text layer must not lose them.
  { start: 0x2190, end: 0x21ff, family: "jp" },
  { start: 0x2200, end: 0x22ff, family: "jp" },
  { start: 0x2460, end: 0x24ff, family: "jp" },
  { start: 0x2500, end: 0x257f, family: "jp" },
  { start: 0x25a0, end: 0x25ff, family: "jp" },
  // CJK punctuation, compatibility, symbol rows, and fullwidth forms.
  { start: 0x2010, end: 0x2027, family: "gb" },
  { start: 0x2030, end: 0x203b, family: "gb" },
  { start: 0x2103, end: 0x2103, family: "gb" },
  { start: 0x2116, end: 0x2116, family: "gb" },
  { start: 0x212b, end: 0x212b, family: "gb" },
  { start: 0x2160, end: 0x2179, family: "gb" },
  { start: 0x2600, end: 0x266f, family: "gb" },
  { start: 0x3000, end: 0x303f, family: "gb" },
  { start: 0x3105, end: 0x3129, family: "gb" },
  { start: 0x3200, end: 0x33ff, family: "gb" },
  { start: 0x3400, end: 0x4dbf, family: "gb" },
  { start: 0x4e00, end: 0x9fff, family: "gb" },
  { start: 0xf900, end: 0xfaff, family: "gb" },
  { start: 0xfe30, end: 0xfe4f, family: "gb" },
  { start: 0xff01, end: 0xff60, family: "gb" },
  { start: 0xffe0, end: 0xffe6, family: "gb" },
];

/** Predefined ordering that can carry a non-WinAnsi BMP code point, if any. */
export function pdfCjkFamilyForCodePoint(codePoint: number): PdfCjkFamily | null {
  for (const range of SUPPORTED_RANGES) {
    if (codePoint >= range.start && codePoint <= range.end) {
      return range.family;
    }
  }
  return null;
}

/**
 * Control characters are layout, not content. `\n` breaks the line, `\t` becomes
 * spaces, and every other C0 code or DEL is omitted — never drawn as a marker.
 * Rendering and counting both read this classification so the marker count and
 * the page can never disagree.
 */
function pdfControlKind(char: string): "break" | "tab" | "omitted" | null {
  if (char === "\n") {
    return "break";
  }
  if (char === "\t") {
    return "tab";
  }
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return "omitted";
  }
  return null;
}

function isUnsupportedCodePoint(char: string): boolean {
  if (pdfControlKind(char) !== null || winAnsiCode(char) !== null) {
    return false;
  }
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint > 0xffff || pdfCjkFamilyForCodePoint(codePoint) === null;
}

/** Counts characters the export cannot carry and therefore draws as the marker. */
export function countUnsupportedPdfChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (isUnsupportedCodePoint(char)) {
      count += 1;
    }
  }
  return count;
}

export type PdfChar = {
  /** Text written to the page; astral characters become the visible marker. */
  text: string;
  /** WinAnsi byte for base-14 text, null when the character needs a CID font. */
  code: number | null;
  /** CID font family for this character, null for base-14 text. */
  cjk: PdfCjkFamily | null;
  width: number;
};

const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** CP1252 codes for the punctuation that UTF-8 sources spell as U+0080..U+009F. */
const CP1252_EXTRA = new Map<string, number>([
  ["\u20AC", 0x80],
  ["\u201A", 0x82],
  ["\u0192", 0x83],
  ["\u201E", 0x84],
  ["\u2026", 0x85],
  ["\u2020", 0x86],
  ["\u2021", 0x87],
  ["\u02C6", 0x88],
  ["\u2030", 0x89],
  ["\u0160", 0x8a],
  ["\u2039", 0x8b],
  ["\u0152", 0x8c],
  ["\u017D", 0x8e],
  ["\u2018", 0x91],
  ["\u2019", 0x92],
  ["\u201C", 0x93],
  ["\u201D", 0x94],
  ["\u2022", 0x95],
  ["\u2013", 0x96],
  ["\u2014", 0x97],
  ["\u02DC", 0x98],
  ["\u2122", 0x99],
  ["\u0161", 0x9a],
  ["\u203A", 0x9b],
  ["\u0153", 0x9c],
  ["\u017E", 0x9e],
  ["\u0178", 0x9f],
]);

function winAnsiCode(char: string): number | null {
  const code = char.codePointAt(0);
  if (code === undefined) {
    return null;
  }
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
    return code;
  }
  return CP1252_EXTRA.get(char) ?? null;
}

function extendedWidth(code: number, bold: boolean): number {
  if (code === 0xa0) {
    return bold ? 278 : 278;
  }
  if (code >= 0xc0) {
    // Accented capitals and lowercase letters: near enough for line breaking.
    return bold ? 611 : 556;
  }
  return bold ? 556 : 556;
}

function buildWidthTable(ascii: readonly number[], bold: boolean): number[] {
  const table: number[] = [];
  for (let code = 32; code <= 255; code += 1) {
    if (code <= 126) {
      table.push(ascii[code - 32] ?? 556);
    } else {
      table.push(extendedWidth(code, bold));
    }
  }
  return table;
}

const WIDTHS = {
  regular: buildWidthTable(HELVETICA_ASCII, false),
  bold: buildWidthTable(HELVETICA_BOLD_ASCII, true),
};

export function pdfFontKey(style: PdfTextStyle): PdfFontKey {
  if (style.code) {
    return style.bold ? "codeBold" : "code";
  }
  if (style.bold) {
    return style.italic ? "boldItalic" : "bold";
  }
  return style.italic ? "italic" : "regular";
}

/** Uses the base-14 family whose widths match the requested style. */
function widthTableKey(font: PdfFontKey): "regular" | "bold" {
  return font === "bold" || font === "boldItalic" || font === "codeBold" ? "bold" : "regular";
}

export function measurePdfText(text: string, style: PdfTextStyle, size: number): PdfChar[] {
  const font = pdfFontKey(style);
  const table = font === "code" || font === "codeBold" ? null : WIDTHS[widthTableKey(font)];
  const spaceMetric = table ? (table[0x20 - 32] ?? 278) : 600;
  const chars: PdfChar[] = [];
  for (const char of text) {
    const control = pdfControlKind(char);
    if (control === "break") {
      // Forced line break inside a block: layout consumes it, no glyph is drawn.
      chars.push({ text: "\n", code: null, cjk: null, width: 0 });
      continue;
    }
    if (control === "omitted") {
      continue;
    }
    if (control === "tab") {
      chars.push({
        text: "    ",
        code: 0x20,
        cjk: null,
        width: (spaceMetric / 1000) * size * 4,
      });
      continue;
    }
    const code = winAnsiCode(char);
    if (code !== null) {
      const metric = table ? (table[code - 32] ?? 556) : 600;
      chars.push({ text: char, code, cjk: null, width: (metric / 1000) * size });
      continue;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    const family = codePoint > 0xffff ? null : pdfCjkFamilyForCodePoint(codePoint);
    if (!family) {
      // Unsupported BMP scripts and astral characters share one visible marker so
      // the export never rewrites a character into an unrelated glyph.
      chars.push({ text: PDF_UNSUPPORTED_MARKER, code: null, cjk: "gb", width: size });
      continue;
    }
    chars.push({ text: char, code: null, cjk: family, width: size });
  }
  return chars;
}

export function measurePdfWidth(text: string, style: PdfTextStyle, size: number): number {
  return measurePdfText(text, style, size).reduce((width, char) => width + char.width, 0);
}

/** Declared /Widths for WinAnsi codes 32..255, matching the metrics used for layout. */
export function pdfFontWidths(key: PdfFontKey): number[] {
  switch (key) {
    case "regular":
    case "italic":
      return WIDTHS.regular;
    case "bold":
    case "boldItalic":
      return WIDTHS.bold;
    default:
      // Courier is monospaced; the CID font declares /DW 1000 instead of widths.
      return Array.from({ length: 224 }, () => 600);
  }
}
