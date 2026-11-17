/**
 * Font metrics and WinAnsi/UCS2 routing for the dependency-free PDF writer.
 *
 * The writer embeds no font programs: Latin text uses the PDF base-14 families
 * (every viewer ships their metrics) and non-Latin text uses the predefined
 * Adobe-GB1 CID font, which viewers substitute with a locally installed CJK
 * font. Both keep the PDF text extractable and searchable.
 */

export type PdfTextStyle = { bold?: boolean; italic?: boolean; code?: boolean };

export type PdfFontKey = "regular" | "bold" | "italic" | "boldItalic" | "code" | "codeBold" | "cjk";

/** Visible replacement for characters the predefined CID font cannot encode. */
export const PDF_UNSUPPORTED_MARKER = "\u25A1";

/** Counts astral characters that the PDF font range cannot carry. */
export function countUnsupportedPdfChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0xffff) {
      count += 1;
    }
  }
  return count;
}

export type PdfChar = {
  /** Text written to the page; astral and unencodable characters become "?". */
  text: string;
  /** WinAnsi byte for base-14 text, null when the character needs the CID font. */
  code: number | null;
  /** Full-width advance flag (CID font). */
  wide: boolean;
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
    if (char === "\t") {
      chars.push({ text: "    ", code: 0x20, wide: false, width: (spaceMetric / 1000) * size * 4 });
      continue;
    }
    const code = winAnsiCode(char);
    if (code !== null) {
      const metric = table ? (table[code - 32] ?? 556) : 600;
      chars.push({ text: char, code, wide: false, width: (metric / 1000) * size });
      continue;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > 0xffff) {
      // The CID font's UCS2 encoding cannot address astral characters (emoji
      // and similar), so they become a visible marker the export explains.
      chars.push({ text: PDF_UNSUPPORTED_MARKER, code: null, wide: true, width: size });
      continue;
    }
    chars.push({ text: char, code: null, wide: true, width: size });
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
