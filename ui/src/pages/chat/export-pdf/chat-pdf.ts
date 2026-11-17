import { markdownToPdfBlocks, type PdfBlock, type PdfSpan } from "./chat-markdown-blocks.ts";
import { measurePdfText, measurePdfWidth, type PdfTextStyle } from "./pdf-text.ts";
import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  serializePdf,
  type PdfBackdrop,
  type PdfPageContent,
  type PdfRgb,
  type PdfTextOp,
} from "./pdf-writer.ts";

export type ChatPdfEntry = {
  speaker: string;
  /** Grouped chat role; only "user" and "assistant" bodies are exported. */
  role: string;
  timestampIso: string | null;
  body: string;
  attachments: number;
};

export type ChatPdfLabels = {
  meta: string;
  attachmentsOmitted: string;
  continued: string;
  pageOf: (page: number, count: number) => string;
  /** Explains the visible replacement marker used for characters the fonts cannot carry. */
  unsupportedGlyphs: (count: number) => string;
};

export type ChatPdfInput = {
  title: string;
  exportedAt: number;
  entries: readonly ChatPdfEntry[];
  labels: ChatPdfLabels;
  /** Characters outside the PDF font range that the document renders as a marker. */
  unsupportedCharacters?: number;
};

export class ChatPdfTooLargeError extends Error {
  constructor() {
    super("chat-pdf-too-large");
    this.name = "ChatPdfTooLargeError";
  }
}

const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 58;
const CONTENT_WIDTH = PDF_PAGE_WIDTH - MARGIN_X * 2;
const PANEL_PAD_X = 12;
const PANEL_PAD_Y = 9;
const BODY_LEFT = MARGIN_X + PANEL_PAD_X;
const BODY_WIDTH = CONTENT_WIDTH - PANEL_PAD_X * 2;
const ENTRY_GAP = 10;
const PAGE_BODY_HEIGHT = PDF_PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

const INK: PdfRgb = [0.11, 0.13, 0.17];
const DIM: PdfRgb = [0.42, 0.45, 0.5];
const RULE: PdfRgb = [0.84, 0.86, 0.9];
const PANEL: PdfRgb = [0.965, 0.972, 0.98];
const CODE_BG: PdfRgb = [0.937, 0.945, 0.957];
const QUOTE_BAR: PdfRgb = [0.78, 0.83, 0.9];
const USER_NAME: PdfRgb = [0.13, 0.33, 0.78];
const ASSISTANT_NAME: PdfRgb = [0.05, 0.42, 0.4];

const BODY_SIZE = 10.5;
const BODY_LEADING = 15.5;
const CODE_SIZE = 9;
const CODE_LEADING = 12.5;
const HEADING_SIZE: Record<number, number> = { 1: 15, 2: 13.5, 3: 12, 4: 11, 5: 10.5, 6: 10.5 };

const MAX_PAGES = 400;

type Unit = {
  style: PdfTextStyle;
  size: number;
  text: string;
  width: number;
  space: boolean;
  color?: PdfRgb;
};

type Run = {
  text: string;
  style: PdfTextStyle;
  size: number;
  x: number;
  width: number;
  color?: PdfRgb;
};

type LaidLine = {
  height: number;
  ascent: number;
  indent: number;
  runs: Run[];
  spaceBefore: number;
  spaceAfter: number;
  background?: boolean;
  quoteBar?: boolean;
  horizontalRule?: boolean;
};

/** Splits spans into breakable units: words stay whole, CJK characters break freely. */
function buildUnits(spans: readonly PdfSpan[], size: number, maxWidth: number): Unit[] {
  const units: Unit[] = [];
  for (const span of spans) {
    const spanSize = span.size ?? (span.style.code ? size * 0.92 : size);
    const color = span.color;
    const chars = measurePdfText(span.text, span.style, spanSize);
    const push = (unit: Omit<Unit, "color">) => {
      units.push(color ? { ...unit, color } : unit);
    };
    let word = "";
    let wordWidth = 0;
    const flushWord = () => {
      if (!word) {
        return;
      }
      if (wordWidth > maxWidth) {
        for (const char of measurePdfText(word, span.style, spanSize)) {
          push({
            style: span.style,
            size: spanSize,
            text: char.text,
            width: char.width,
            space: false,
          });
        }
      } else {
        push({
          style: span.style,
          size: spanSize,
          text: word,
          width: wordWidth,
          space: false,
        });
      }
      word = "";
      wordWidth = 0;
    };
    for (const char of chars) {
      if (char.text === "\n") {
        flushWord();
        push({ style: span.style, size: spanSize, text: "\n", width: 0, space: false });
        continue;
      }
      if (char.text === " ") {
        flushWord();
        push({
          style: span.style,
          size: spanSize,
          text: " ",
          width: char.width,
          space: true,
        });
        continue;
      }
      word += char.text;
      wordWidth += char.width;
      // CJK characters are their own break opportunity.
      if (char.cjk !== null) {
        flushWord();
      }
    }
    flushWord();
  }
  return units;
}

function wrapUnits(units: readonly Unit[], maxWidth: number): Unit[][] {
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let width = 0;
  const flush = (allowEmpty: boolean) => {
    while (line.length > 0 && line.at(-1)!.space) {
      width -= line.pop()!.width;
    }
    if (line.length > 0 || allowEmpty) {
      lines.push(line);
    }
    line = [];
    width = 0;
  };
  for (const unit of units) {
    if (unit.text === "\n") {
      flush(true);
      continue;
    }
    if (width + unit.width > maxWidth && line.length > 0 && !unit.space) {
      flush(false);
    }
    if (unit.space && line.length === 0) {
      continue;
    }
    line.push(unit);
    width += unit.width;
  }
  flush(false);
  return lines;
}

function runsForLine(units: readonly Unit[]): Run[] {
  const runs: Run[] = [];
  let x = 0;
  for (const unit of units) {
    const last = runs.at(-1);
    if (
      last &&
      last.style.bold === unit.style.bold &&
      last.style.code === unit.style.code &&
      last.style.italic === unit.style.italic &&
      last.size === unit.size &&
      last.color === unit.color
    ) {
      last.text += unit.text;
      last.width += unit.width;
    } else {
      runs.push({
        text: unit.text,
        style: unit.style,
        size: unit.size,
        x,
        width: unit.width,
        ...(unit.color ? { color: unit.color } : {}),
      });
    }
    x += unit.width;
  }
  return runs;
}

function withRun(run: Run, patch: { style?: PdfTextStyle; x?: number; color?: PdfRgb }): Run {
  const color = patch.color ?? run.color;
  return {
    text: run.text,
    style: patch.style ?? run.style,
    size: run.size,
    x: patch.x ?? run.x,
    width: run.width,
    ...(color ? { color } : {}),
  };
}

function withRuns(line: LaidLine, patch: { runs: Run[]; indent?: number }): LaidLine {
  return {
    height: line.height,
    ascent: line.ascent,
    indent: patch.indent ?? line.indent,
    runs: patch.runs,
    spaceBefore: line.spaceBefore,
    spaceAfter: line.spaceAfter,
    ...(line.background ? { background: true } : {}),
    ...(line.quoteBar ? { quoteBar: true } : {}),
    ...(line.horizontalRule ? { horizontalRule: true } : {}),
  };
}

function textLine(
  spans: readonly PdfSpan[],
  params: {
    size: number;
    leading: number;
    width: number;
    indent: number;
    spaceBefore?: number;
    spaceAfter?: number;
    background?: boolean;
    quoteBar?: boolean;
  },
): LaidLine[] {
  const units = buildUnits(spans, params.size, params.width);
  const wrapped = wrapUnits(units, params.width);
  return wrapped.map((lineUnits, index) => ({
    height: params.leading,
    ascent: params.size,
    indent: params.indent,
    runs: runsForLine(lineUnits),
    spaceBefore: index === 0 ? (params.spaceBefore ?? 0) : 0,
    spaceAfter: index === wrapped.length - 1 ? (params.spaceAfter ?? 0) : 0,
    background: params.background,
    quoteBar: params.quoteBar,
  }));
}

function layoutBlock(block: PdfBlock): LaidLine[] {
  switch (block.kind) {
    case "heading": {
      const size = HEADING_SIZE[block.level] ?? BODY_SIZE;
      return textLine(block.spans, {
        size,
        leading: size * 1.38,
        width: BODY_WIDTH,
        indent: 0,
        spaceBefore: block.level <= 2 ? 9 : 7,
        spaceAfter: 3,
      }).map((line) =>
        withRuns(line, {
          runs: line.runs.map((run) => withRun(run, { style: { ...run.style, bold: true } })),
        }),
      );
    }
    case "paragraph":
      return textLine(block.spans, {
        size: BODY_SIZE,
        leading: BODY_LEADING,
        width: BODY_WIDTH - block.indent,
        indent: block.indent,
        spaceBefore: 3,
        spaceAfter: 2,
        quoteBar: block.quote,
      });
    case "listItem": {
      const marker = block.marker ? `${block.marker} ` : "";
      const markerWidth = block.marker
        ? measurePdfWidth(marker, { bold: true }, BODY_SIZE)
        : measurePdfWidth("   ", {}, BODY_SIZE);
      const hang = markerWidth;
      const hangingWidth = BODY_WIDTH - block.indent - hang;
      const units = buildUnits(block.spans, BODY_SIZE, hangingWidth);
      const wrapped = wrapUnits(units, hangingWidth);
      return wrapped.map((lineUnits, index) => ({
        height: BODY_LEADING,
        ascent: BODY_SIZE,
        indent: block.indent,
        runs: [
          ...(index === 0 && block.marker
            ? [{ text: marker, style: { bold: true }, size: BODY_SIZE, x: 0, width: markerWidth }]
            : []),
          ...runsForLine(lineUnits).map((run) => withRun(run, { x: run.x + hang })),
        ],
        spaceBefore: index === 0 ? 2 : 0,
        spaceAfter: index === wrapped.length - 1 ? 2 : 0,
      }));
    }
    case "code": {
      const lines: LaidLine[] = [];
      const innerWidth = BODY_WIDTH - 16;
      for (const raw of block.text.split("\n")) {
        // Leading indentation stays literal: wrapping must not treat it as leading space to drop.
        const source = raw.replace(/^ +/u, (spaces) => "\u00A0".repeat(spaces.length));
        const units = buildUnits(
          [{ text: source || " ", style: { code: true } }],
          CODE_SIZE,
          innerWidth,
        );
        const wrapped = wrapUnits(units, innerWidth);
        for (const lineUnits of wrapped) {
          lines.push({
            height: CODE_LEADING,
            ascent: CODE_SIZE,
            indent: 6,
            runs: runsForLine(lineUnits).map((run) => withRun(run, { x: run.x + 5 })),
            spaceBefore: 0,
            spaceAfter: 0,
            background: true,
          });
        }
      }
      if (lines.length > 0) {
        lines[0]!.spaceBefore = 5;
        lines.at(-1)!.spaceAfter = 5;
      }
      return lines;
    }
    case "rule":
      return [
        {
          height: 14,
          ascent: 8,
          indent: 0,
          runs: [],
          spaceBefore: 4,
          spaceAfter: 4,
          horizontalRule: true,
        },
      ];
    default:
      return [];
  }
}

function layoutEntry(entry: ChatPdfEntry, labels: ChatPdfLabels): LaidLine[] {
  const accent = entry.role === "user" ? USER_NAME : ASSISTANT_NAME;
  // Speaker and timestamp share the wrapped body width, so a long name never
  // pushes the timestamp past the page margin.
  const headerSpans = [
    { text: entry.speaker, style: { bold: true }, size: 9.5, color: accent },
    ...(entry.timestampIso
      ? [{ text: `  ${entry.timestampIso}`, style: {}, size: 8, color: DIM }]
      : []),
  ];
  const lines: LaidLine[] = textLine(headerSpans, {
    size: 9.5,
    leading: 15,
    width: BODY_WIDTH,
    indent: 0,
    spaceBefore: 2,
    spaceAfter: 3,
  });
  for (const block of markdownToPdfBlocks(entry.body)) {
    lines.push(...layoutBlock(block));
  }
  if (entry.attachments > 0) {
    lines.push(
      ...textLine([{ text: labels.attachmentsOmitted, style: { italic: true } }], {
        size: 9,
        leading: 13,
        width: BODY_WIDTH,
        indent: 0,
        spaceBefore: 3,
      }).map((line) =>
        withRuns(line, { runs: line.runs.map((run) => withRun(run, { color: DIM })) }),
      ),
    );
  }
  return lines;
}

function titleLines(input: ChatPdfInput): LaidLine[] {
  // The heading gutter matches the panel edge, so it sits left of the message text.
  const heading = textLine([{ text: input.title, style: { bold: true } }], {
    size: 17,
    leading: 23,
    width: CONTENT_WIDTH,
    indent: -PANEL_PAD_X,
  });
  return [
    ...heading,
    {
      height: 16,
      ascent: 11,
      indent: -PANEL_PAD_X,
      runs: [
        {
          text: input.labels.meta,
          style: {},
          size: 8.5,
          x: 0,
          width: measurePdfWidth(input.labels.meta, {}, 8.5),
          color: DIM,
        },
      ],
      spaceBefore: 2,
      spaceAfter: 0,
    },
    ...(input.unsupportedCharacters && input.unsupportedCharacters > 0
      ? [
          {
            height: 14,
            ascent: 10,
            indent: -PANEL_PAD_X,
            runs: [
              {
                text: input.labels.unsupportedGlyphs(input.unsupportedCharacters),
                style: { italic: true },
                size: 8,
                x: 0,
                width: measurePdfWidth(
                  input.labels.unsupportedGlyphs(input.unsupportedCharacters),
                  {},
                  8,
                ),
                color: DIM,
              },
            ],
            spaceBefore: 0,
            spaceAfter: 0,
          },
        ]
      : []),
    {
      height: 14,
      ascent: 10,
      indent: -PANEL_PAD_X,
      runs: [],
      spaceBefore: 2,
      spaceAfter: 2,
      horizontalRule: true,
    },
  ];
}

class PdfComposer {
  readonly pages: PdfPageContent[] = [{ backdrops: [], texts: [] }];
  cursor = MARGIN_TOP;

  get remaining(): number {
    return PDF_PAGE_HEIGHT - MARGIN_BOTTOM - this.cursor;
  }

  get atPageTop(): boolean {
    return this.cursor <= MARGIN_TOP + 0.001;
  }

  get pageIndex(): number {
    return this.pages.length - 1;
  }

  newPage(): void {
    if (this.pages.length >= MAX_PAGES) {
      throw new ChatPdfTooLargeError();
    }
    this.pages.push({ backdrops: [], texts: [] });
    this.cursor = MARGIN_TOP;
  }

  addBackdrop(pageIndex: number, backdrop: PdfBackdrop): void {
    this.pages[pageIndex]!.backdrops.push(backdrop);
  }

  addText(text: PdfTextOp): void {
    this.pages[this.pageIndex]!.texts.push(text);
  }
}

function drawLine(composer: PdfComposer, line: LaidLine, pageIndex: number): void {
  const top = composer.cursor;
  if (line.horizontalRule) {
    composer.addBackdrop(pageIndex, {
      kind: "line",
      color: RULE,
      x1: BODY_LEFT + line.indent,
      y1: top + line.height - 4,
      x2: MARGIN_X + CONTENT_WIDTH,
      y2: top + line.height - 4,
      width: 0.8,
    });
    composer.cursor += line.height;
    return;
  }
  if (line.background) {
    composer.addBackdrop(pageIndex, {
      kind: "rect",
      color: CODE_BG,
      x: BODY_LEFT + line.indent - 6,
      y: top,
      width: BODY_WIDTH - line.indent + 12,
      height: line.height,
    });
  }
  if (line.quoteBar) {
    composer.addBackdrop(pageIndex, {
      kind: "line",
      color: QUOTE_BAR,
      x1: BODY_LEFT + line.indent - 8,
      y1: top,
      x2: BODY_LEFT + line.indent - 8,
      y2: top + line.height,
      width: 2,
    });
  }
  const baseline = top + line.ascent;
  for (const run of line.runs) {
    if (!run.text) {
      continue;
    }
    composer.pages[pageIndex]!.texts.push({
      style: run.style,
      size: run.size,
      x: BODY_LEFT + line.indent + run.x,
      baseline,
      text: run.text,
      color: run.color ?? INK,
    });
  }
  composer.cursor += line.height;
}

/** Renders the chat transcript into a light-background A4 PDF. */
export function buildChatPdf(input: ChatPdfInput): Uint8Array {
  const composer = new PdfComposer();
  for (const line of titleLines(input)) {
    if (composer.remaining < line.spaceBefore + line.height && !composer.atPageTop) {
      composer.newPage();
    }
    composer.cursor += line.spaceBefore;
    drawLine(composer, line, composer.pageIndex);
    composer.cursor += line.spaceAfter;
  }

  for (const entry of input.entries) {
    const lines = layoutEntry(entry, input.labels);
    const bodyHeight = lines.reduce(
      (height, line) => height + line.spaceBefore + line.height + line.spaceAfter,
      0,
    );
    const panelHeight = bodyHeight + PANEL_PAD_Y * 2;
    if (!composer.atPageTop) {
      // Keep short bubbles whole; only a message taller than a page may split.
      if (panelHeight <= PAGE_BODY_HEIGHT && composer.remaining < panelHeight + ENTRY_GAP) {
        composer.newPage();
      } else {
        composer.cursor += ENTRY_GAP;
      }
    }
    const segments: { page: number; top: number }[] = [];
    const openSegment = () => {
      segments.push({ page: composer.pageIndex, top: composer.cursor });
      composer.cursor += PANEL_PAD_Y;
    };
    const closeSegment = () => {
      const segment = segments.at(-1);
      if (!segment) {
        return;
      }
      const height = composer.cursor - segment.top;
      if (height <= 0) {
        return;
      }
      composer.addBackdrop(segment.page, {
        kind: "roundedRect",
        color: PANEL,
        x: MARGIN_X,
        y: segment.top,
        width: CONTENT_WIDTH,
        height,
        radius: 8,
      });
    };
    openSegment();
    for (const line of lines) {
      const needed = line.spaceBefore + line.height + line.spaceAfter;
      if (composer.remaining < needed && !composer.atPageTop) {
        closeSegment();
        composer.newPage();
        openSegment();
      }
      composer.cursor += line.spaceBefore;
      drawLine(composer, line, composer.pageIndex);
      composer.cursor += line.spaceAfter;
    }
    composer.cursor += PANEL_PAD_Y;
    closeSegment();
    for (const segment of segments.slice(1)) {
      composer.pages[segment.page]!.texts.push({
        style: { italic: true },
        size: 7.5,
        x:
          MARGIN_X + CONTENT_WIDTH - PANEL_PAD_X - measurePdfWidth(input.labels.continued, {}, 7.5),
        baseline: segment.top + 7,
        text: input.labels.continued,
        color: DIM,
      });
    }
  }

  addFooters(composer, input.labels);
  return serializePdf(composer.pages);
}

function addFooters(composer: PdfComposer, labels: ChatPdfLabels): void {
  const count = composer.pages.length;
  composer.pages.forEach((page, index) => {
    const label = labels.pageOf(index + 1, count);
    page.texts.push({
      style: {},
      size: 7.5,
      x: (PDF_PAGE_WIDTH - measurePdfWidth(label, {}, 7.5)) / 2,
      baseline: PDF_PAGE_HEIGHT - MARGIN_BOTTOM + 24,
      text: label,
      color: DIM,
    });
  });
}
