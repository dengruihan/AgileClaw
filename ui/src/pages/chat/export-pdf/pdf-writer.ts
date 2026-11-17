import {
  measurePdfText,
  pdfFontKey,
  pdfFontWidths,
  type PdfCjkFamily,
  type PdfFontKey,
  type PdfTextStyle,
} from "./pdf-text.ts";

export type PdfRgb = readonly [number, number, number];

export type PdfTextOp = {
  style: PdfTextStyle;
  size: number;
  /** Left edge in PDF points from the page's left edge. */
  x: number;
  /** Baseline measured from the page's top edge (top-down layout coordinates). */
  baseline: number;
  text: string;
  color: PdfRgb;
};

export type PdfBackdrop =
  | { kind: "rect"; color: PdfRgb; x: number; y: number; width: number; height: number }
  | {
      kind: "roundedRect";
      color: PdfRgb;
      x: number;
      y: number;
      width: number;
      height: number;
      radius: number;
    }
  | {
      kind: "line";
      color: PdfRgb;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
    };

export type PdfPageContent = { backdrops: PdfBackdrop[]; texts: PdfTextOp[] };

export const PDF_PAGE_WIDTH = 595.28;
export const PDF_PAGE_HEIGHT = 841.89;

/**
 * Object layout: catalog, page tree, one font resource per key, then one
 * descendant font and descriptor per predefined CJK ordering, one shared
 * resource dictionary, and one page plus content stream per rendered page.
 */
type CjkFontSpec = {
  key: Extract<PdfFontKey, "cjkGb" | "cjkJp" | "cjkKr">;
  family: PdfCjkFamily;
  /** Predefined ADBE font a viewer substitutes from its own font set. */
  baseFont: string;
  encoding: string;
  ordering: "GB1" | "Japan1" | "Korea1";
  supplement: number;
  /** Flags: 4 = symbolic, matching the predefined CID font's glyph set. */
  flags: number;
};

const CJK_FONTS: readonly CjkFontSpec[] = [
  {
    key: "cjkGb",
    family: "gb",
    baseFont: "STSong-Light",
    encoding: "UniGB-UCS2-H",
    ordering: "GB1",
    supplement: 4,
    flags: 4,
  },
  {
    key: "cjkJp",
    family: "jp",
    baseFont: "HeiseiMin-W3",
    encoding: "UniJIS-UCS2-H",
    ordering: "Japan1",
    supplement: 6,
    flags: 4,
  },
  {
    key: "cjkKr",
    family: "kr",
    baseFont: "HYSMyeongJo-Medium",
    encoding: "UniKS-UCS2-H",
    ordering: "Korea1",
    supplement: 3,
    flags: 4,
  },
];

const CJK_FONT_KEY_BY_FAMILY: Record<PdfCjkFamily, CjkFontSpec["key"]> = {
  gb: "cjkGb",
  jp: "cjkJp",
  kr: "cjkKr",
};

const FONT_NAMES: readonly { key: PdfFontKey; name: string }[] = [
  { key: "regular", name: "Helvetica" },
  { key: "bold", name: "Helvetica-Bold" },
  { key: "italic", name: "Helvetica-Oblique" },
  { key: "boldItalic", name: "Helvetica-BoldOblique" },
  { key: "code", name: "Courier" },
  { key: "codeBold", name: "Courier-Bold" },
  ...CJK_FONTS.map((font) => ({ key: font.key, name: font.baseFont })),
];

function isCjkFontKey(key: PdfFontKey): key is CjkFontSpec["key"] {
  return key.startsWith("cjk");
}

const FONT_RESOURCE_NAMES = new Map<PdfFontKey, string>(
  FONT_NAMES.map((font, index) => [font.key, `F${index + 1}`]),
);

function num(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function colorOps(color: PdfRgb, stroke = false): string {
  const [r, g, b] = color;
  return `${num(r)} ${num(g)} ${num(b)} ${stroke ? "RG" : "rg"}`;
}

/** Emits WinAnsi bytes as a PDF literal string; non-ASCII bytes use octal escapes. */
function literalString(codes: readonly number[]): string {
  let literal = "";
  for (const code of codes) {
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      literal += `\\${String.fromCharCode(code)}`;
    } else if (code >= 0x20 && code <= 0x7e) {
      literal += String.fromCharCode(code);
    } else {
      literal += `\\${code.toString(8).padStart(3, "0")}`;
    }
  }
  return `(${literal})`;
}

function hexString(text: string): string {
  let hex = "";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

function textOperator(op: PdfTextOp): string {
  const chars = measurePdfText(op.text, op.style, op.size);
  if (chars.length === 0) {
    return "";
  }
  const baseFont = pdfFontKey(op.style);
  // Color and line width are graphics state, so they stay outside the text object.
  const ops = [
    colorOps(op.color),
    ...(op.style.bold === true ? [`${num(Math.max(op.size * 0.035, 0.2))} w`] : []),
    "BT",
    `1 0 0 1 ${num(op.x)} ${num(PDF_PAGE_HEIGHT - op.baseline)} Tm`,
  ];
  let currentFont: PdfFontKey | null = null;
  let fakeBold = false;
  let runText = "";
  let runCodes: number[] = [];
  let runFamily: PdfCjkFamily | null = null;
  let runOpen = false;
  const flush = () => {
    if (runOpen) {
      const font: PdfFontKey = runFamily === null ? baseFont : CJK_FONT_KEY_BY_FAMILY[runFamily];
      if (font !== currentFont) {
        ops.push(`/${FONT_RESOURCE_NAMES.get(font)} ${num(op.size)} Tf`);
        currentFont = font;
      }
      // Fake bold keeps CJK text distinct without a second embedded font program.
      const boldCjk = isCjkFontKey(font) && op.style.bold === true;
      if (boldCjk !== fakeBold) {
        ops.push(boldCjk ? "2 Tr" : "0 Tr");
        fakeBold = boldCjk;
      }
      ops.push(runFamily === null ? `${literalString(runCodes)} Tj` : `${hexString(runText)} Tj`);
    }
    runText = "";
    runCodes = [];
    runOpen = false;
  };
  for (const char of chars) {
    if (runOpen && char.cjk !== runFamily) {
      flush();
    }
    runFamily = char.cjk;
    runOpen = true;
    if (char.cjk === null) {
      runCodes.push(char.code ?? 0x3f);
    } else {
      runText += char.text;
    }
  }
  flush();
  if (fakeBold) {
    ops.push("0 Tr");
  }
  ops.push("ET");
  return ops.join("\n");
}

function backdropOperator(backdrop: PdfBackdrop): string {
  if (backdrop.kind === "line") {
    return [
      colorOps(backdrop.color, true),
      `${num(backdrop.width)} w`,
      `${num(backdrop.x1)} ${num(PDF_PAGE_HEIGHT - backdrop.y1)} m`,
      `${num(backdrop.x2)} ${num(PDF_PAGE_HEIGHT - backdrop.y2)} l`,
      "S",
    ].join("\n");
  }
  const top = PDF_PAGE_HEIGHT - backdrop.y;
  const bottom = top - backdrop.height;
  if (backdrop.kind === "rect") {
    return [
      colorOps(backdrop.color),
      `${num(backdrop.x)} ${num(bottom)} ${num(backdrop.width)} ${num(backdrop.height)} re`,
      "f",
    ].join("\n");
  }
  const radius = Math.min(backdrop.radius, backdrop.width / 2, backdrop.height / 2);
  const left = backdrop.x;
  const right = left + backdrop.width;
  const kappa = 0.5523 * radius;
  const ops = [
    colorOps(backdrop.color),
    `${num(left + radius)} ${num(top)} m`,
    `${num(right - radius)} ${num(top)} l`,
    `${num(right - radius + kappa)} ${num(top)} ${num(right)} ${num(top - radius + kappa)} ${num(right)} ${num(top - radius)} c`,
    `${num(right)} ${num(bottom + radius)} l`,
    `${num(right)} ${num(bottom + radius - kappa)} ${num(right - radius + kappa)} ${num(bottom)} ${num(right - radius)} ${num(bottom)} c`,
    `${num(left + radius)} ${num(bottom)} l`,
    `${num(left + radius - kappa)} ${num(bottom)} ${num(left)} ${num(bottom + radius - kappa)} ${num(left)} ${num(bottom + radius)} c`,
    `${num(left)} ${num(top - radius)} l`,
    `${num(left)} ${num(top - radius + kappa)} ${num(left + radius - kappa)} ${num(top)} ${num(left + radius)} ${num(top)} c`,
    "f",
  ];
  return ops.join("\n");
}

function pageContentStream(page: PdfPageContent): string {
  const parts: string[] = [];
  for (const backdrop of page.backdrops) {
    parts.push(backdropOperator(backdrop));
  }
  for (const text of page.texts) {
    const operator = textOperator(text);
    if (operator) {
      parts.push(operator);
    }
  }
  return parts.join("\n");
}

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index] = code <= 0xff ? code : 0x3f;
  }
  return bytes;
}

function fontDictionary(font: (typeof FONT_NAMES)[number]): string {
  const widths = pdfFontWidths(font.key).join(" ");
  return `<< /Type /Font /Subtype /Type1 /BaseFont /${font.name} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 255 /Widths [${widths}] >>`;
}

/** Serializes pages into a PDF 1.4 file with one uncompressed content stream per page. */
export function serializePdf(pages: readonly PdfPageContent[]): Uint8Array {
  const objects: string[] = [];
  const reserve = () => {
    objects.push("");
    return objects.length;
  };
  const set = (id: number, body: string) => {
    objects[id - 1] = body;
  };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontIds = new Map<PdfFontKey, number>();
  for (const font of FONT_NAMES) {
    fontIds.set(font.key, reserve());
  }
  const cjkIds = new Map<CjkFontSpec["key"], { descendant: number; descriptor: number }>();
  for (const font of CJK_FONTS) {
    cjkIds.set(font.key, { descendant: reserve(), descriptor: reserve() });
  }
  const resourcesId = reserve();

  const pageIds = pages.map((page) => {
    const stream = pageContentStream(page);
    const contentId = reserve();
    set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageId = reserve();
    set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(PDF_PAGE_WIDTH)} ${num(PDF_PAGE_HEIGHT)}] /Resources ${resourcesId} 0 R /Contents ${contentId} 0 R >>`,
    );
    return pageId;
  });

  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  for (const font of FONT_NAMES) {
    const id = fontIds.get(font.key)!;
    if (!isCjkFontKey(font.key)) {
      set(id, fontDictionary(font));
      continue;
    }
    const spec = CJK_FONTS.find((candidate) => candidate.key === font.key)!;
    const ids = cjkIds.get(spec.key)!;
    set(
      id,
      `<< /Type /Font /Subtype /Type0 /BaseFont /${spec.baseFont} /Encoding /${spec.encoding} /DescendantFonts [${ids.descendant} 0 R] >>`,
    );
    set(
      ids.descriptor,
      `<< /Type /FontDescriptor /FontName /${spec.baseFont} /Flags ${spec.flags} /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>`,
    );
    set(
      ids.descendant,
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${spec.baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (${spec.ordering}) /Supplement ${spec.supplement} >> /FontDescriptor ${ids.descriptor} 0 R /DW 1000 >>`,
    );
  }
  set(
    resourcesId,
    `<< /Font << ${FONT_NAMES.map((font) => `/${FONT_RESOURCE_NAMES.get(font.key)} ${fontIds.get(font.key)} 0 R`).join(" ")} >> >>`,
  );

  const header = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const chunks: string[] = [header];
  const offsets: number[] = [];
  let offset = header.length;
  objects.forEach((body, index) => {
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const entry of offsets) {
    xref.push(`${String(entry).padStart(10, "0")} 00000 n `);
  }
  chunks.push(
    [
      xref.join("\n"),
      "trailer",
      `<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>`,
      "startxref",
      String(offset),
      "%%EOF",
      "",
    ].join("\n"),
  );
  return asciiBytes(chunks.join(""));
}
