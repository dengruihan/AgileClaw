/**
 * Slide text bodies for the PPTX reader.
 *
 * A slide paragraph resolves in four layers: the master level style, the
 * shape's `p:style/a:fontRef` (the tier PowerPoint places just above the
 * default chain), the paragraph's own `a:pPr`/`a:defRPr`, and each run's
 * `a:rPr`. Resolving every layer here means the payload carries the effective
 * size, weight, color, and face per run, plus the bullet label the renderer
 * shows.
 */
import type {
  SessionFileOfficeParagraph,
  SessionFileOfficeRun,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  alignmentFromAttribute,
  mergeTextLevel,
  type PptxTextLevel,
  type PptxTheme,
  pptxPoints,
  resolveDrawingColor,
  themeFontFace,
} from "./office-preview-pptx-master.js";
import {
  attribute,
  type CharacterBudget,
  childNamed,
  elementChildren,
  localName,
  truncate,
  type XmlElement,
} from "./office-preview-xml.js";

const MAX_PARAGRAPHS = 40;
const MAX_RUNS = 200;
const MAX_PARAGRAPH_CHARS = 8_000;
/** DrawingML text-box defaults: 0.1in horizontal and 0.05in vertical insets. */
const DEFAULT_INSET_X_PT = 7.2;
const DEFAULT_INSET_Y_PT = 3.6;

export type PptxTextBody = {
  paragraphs: SessionFileOfficeParagraph[];
  verticalAnchor?: "top" | "middle" | "bottom";
  wrapText?: boolean;
  insetTopPt: number;
  insetRightPt: number;
  insetBottomPt: number;
  insetLeftPt: number;
  textScalePct?: number;
};

/** One run-property layer; shape `p:style` font references use it as a base. */
export type PptxRunStyle = {
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fontName?: string;
};

type RunStyle = PptxRunStyle;

function runStyleFromProperties(properties: XmlElement | undefined, theme: PptxTheme): RunStyle {
  if (!properties) {
    return {};
  }
  const size = Number.parseFloat(attribute(properties, "sz") ?? "");
  const underline = attribute(properties, "u");
  const strike = attribute(properties, "strike");
  const color = resolveDrawingColor(childNamed(properties, "solidFill"), theme);
  const fontName = themeFontFace(attribute(childNamed(properties, "latin"), "typeface"), theme);
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
  };
}

function mergeStyle(...layers: RunStyle[]): RunStyle {
  const merged: RunStyle = {};
  for (const layer of layers) {
    for (const key of Object.keys(layer) as (keyof RunStyle)[]) {
      if (layer[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = layer[key];
      }
    }
  }
  return merged;
}

/** Only the run-level members of a master level style. */
function runStyleFromLevel(level: PptxTextLevel): RunStyle {
  return {
    ...(level.fontSizePt !== undefined ? { fontSizePt: level.fontSizePt } : {}),
    ...(level.bold ? { bold: true } : {}),
    ...(level.italic ? { italic: true } : {}),
    ...(level.underline ? { underline: true } : {}),
    ...(level.strike ? { strike: true } : {}),
    ...(level.color ? { color: level.color } : {}),
    ...(level.fontName ? { fontName: level.fontName } : {}),
  };
}

function roman(value: number, upper: boolean): string {
  const numerals: readonly [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let remaining = Math.max(1, Math.min(3_999, value));
  let text = "";
  for (const [amount, symbol] of numerals) {
    while (remaining >= amount) {
      text += symbol;
      remaining -= amount;
    }
  }
  return upper ? text.toUpperCase() : text;
}

function alpha(value: number, upper: boolean): string {
  const letter = String.fromCharCode(97 + ((Math.max(1, value) - 1) % 26));
  return upper ? letter.toUpperCase() : letter;
}

/** Formats one auto-number marker; unknown schemes fall back to `1.`. */
function autoNumberMarker(type: string, value: number): string {
  switch (type) {
    case "alphaLcPeriod":
      return `${alpha(value, false)}.`;
    case "alphaUcPeriod":
      return `${alpha(value, true)}.`;
    case "romanLcPeriod":
      return `${roman(value, false)}.`;
    case "romanUcPeriod":
      return `${roman(value, true)}.`;
    default:
      return `${value}.`;
  }
}

function bulletFor(
  level: PptxTextLevel,
  paragraph: XmlElement | undefined,
): { char?: string; autoNumber?: string } {
  const properties = childNamed(paragraph, "pPr");
  if (childNamed(properties, "buNone")) {
    return {};
  }
  const paragraphChar = attribute(childNamed(properties, "buChar"), "char");
  if (paragraphChar) {
    return { char: paragraphChar.slice(0, 8) };
  }
  const paragraphAuto = attribute(childNamed(properties, "buAutoNum"), "type");
  if (paragraphAuto) {
    return { autoNumber: paragraphAuto };
  }
  if (level.bulletNone) {
    return {};
  }
  return {
    ...(level.bulletChar ? { char: level.bulletChar } : {}),
    ...(level.autoNumber ? { autoNumber: level.autoNumber } : {}),
  };
}

function paragraphSpacing(
  level: PptxTextLevel,
  properties: XmlElement | undefined,
): {
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacingPt?: number;
  lineSpacingPct?: number;
} {
  const spacing = (name: "spcBef" | "spcAft"): number | undefined => {
    const points = Number.parseFloat(
      attribute(childNamed(childNamed(properties, name), "spcPts"), "val") ?? "",
    );
    if (Number.isFinite(points) && points >= 0) {
      return Math.min(1_000, Math.round((points / 100) * 10) / 10);
    }
    return name === "spcBef" ? level.spaceBeforePt : level.spaceAfterPt;
  };
  const lineSpacing = childNamed(properties, "lnSpc");
  const points = Number.parseFloat(attribute(childNamed(lineSpacing, "spcPts"), "val") ?? "");
  const percent = Number.parseFloat(attribute(childNamed(lineSpacing, "spcPct"), "val") ?? "");
  return {
    ...(spacing("spcBef") !== undefined ? { spaceBeforePt: spacing("spcBef") } : {}),
    ...(spacing("spcAft") !== undefined ? { spaceAfterPt: spacing("spcAft") } : {}),
    ...(Number.isFinite(points) && points > 0
      ? { lineSpacingPt: Math.min(1_000, Math.round((points / 100) * 10) / 10) }
      : Number.isFinite(percent) && percent > 0
        ? { lineSpacingPct: Math.round((percent / 100_000) * 1_000) / 1_000 }
        : level.lineSpacingPt !== undefined
          ? { lineSpacingPt: level.lineSpacingPt }
          : level.lineSpacingPct !== undefined
            ? { lineSpacingPct: level.lineSpacingPct }
            : {}),
  };
}

function paragraphLevel(properties: XmlElement | undefined): number {
  const value = Number.parseInt(attribute(properties, "lvl") ?? "0", 10);
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(8, value)) : 0;
}

function paragraphIndents(
  level: PptxTextLevel,
  properties: XmlElement | undefined,
): { indentLeftPt?: number; indentFirstLinePt?: number } {
  const margin = pptxPoints(attribute(properties, "marL"));
  const indent = pptxPoints(attribute(properties, "indent"));
  return {
    ...(margin !== undefined
      ? { indentLeftPt: Math.max(0, Math.min(2_000, margin)) }
      : level.indentLeftPt !== undefined
        ? { indentLeftPt: Math.max(0, Math.min(2_000, level.indentLeftPt)) }
        : {}),
    ...(indent !== undefined
      ? { indentFirstLinePt: Math.max(-2_000, Math.min(2_000, indent)) }
      : level.indentFirstLinePt !== undefined
        ? { indentFirstLinePt: Math.max(-2_000, Math.min(2_000, level.indentFirstLinePt)) }
        : {}),
  };
}

type ParagraphRun = { text: string; style: RunStyle };

function readParagraphRuns(
  paragraph: XmlElement,
  style: RunStyle,
  theme: PptxTheme,
  onEquations: (count: number) => void,
): ParagraphRun[] {
  const runs: ParagraphRun[] = [];
  const visitContainer = (container: XmlElement): void => {
    for (const child of elementChildren(container)) {
      const name = localName(child.nodeName);
      switch (name) {
        case "r": {
          const text = childNamed(child, "t")?.textContent ?? "";
          runs.push({
            text,
            style: mergeStyle(style, runStyleFromProperties(childNamed(child, "rPr"), theme)),
          });
          break;
        }
        case "fld": {
          // Slide-number and date fields carry their cached value in `a:t`.
          const text = childNamed(child, "t")?.textContent ?? "";
          runs.push({
            text,
            style: mergeStyle(style, runStyleFromProperties(childNamed(child, "rPr"), theme)),
          });
          break;
        }
        case "br":
          runs.push({ text: "\n", style });
          break;
        case "m":
          onEquations(1);
          break;
        case "AlternateContent": {
          const branch = childNamed(child, "Choice") ?? childNamed(child, "Fallback");
          if (branch) {
            visitContainer(branch);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  visitContainer(paragraph);
  return runs;
}

function bodyProperties(txBody: XmlElement): PptxTextBodyWithoutParagraphs {
  const properties = childNamed(txBody, "bodyPr");
  const anchor = attribute(properties, "anchor");
  const autoFit = childNamed(properties, "normAutofit");
  const fontScale = Number.parseFloat(attribute(autoFit, "fontScale") ?? "");
  const inset = (name: string, fallback: number): number =>
    Math.max(0, Math.min(100, pptxPoints(attribute(properties, name)) ?? fallback));
  return {
    ...(anchor === "ctr"
      ? { verticalAnchor: "middle" as const }
      : anchor === "b"
        ? { verticalAnchor: "bottom" as const }
        : anchor === "t"
          ? { verticalAnchor: "top" as const }
          : {}),
    ...(attribute(properties, "wrap") === "none" ? { wrapText: false } : {}),
    insetTopPt: inset("tIns", DEFAULT_INSET_Y_PT),
    insetRightPt: inset("rIns", DEFAULT_INSET_X_PT),
    insetBottomPt: inset("bIns", DEFAULT_INSET_Y_PT),
    insetLeftPt: inset("lIns", DEFAULT_INSET_X_PT),
    ...(Number.isFinite(fontScale) && fontScale > 0 && fontScale < 100_000
      ? { textScalePct: Math.max(10, Math.min(100, Math.round(fontScale / 1_000))) }
      : {}),
  };
}

type PptxTextBodyWithoutParagraphs = Omit<PptxTextBody, "paragraphs">;

function styledRun(run: ParagraphRun): SessionFileOfficeRun {
  return { ...run.style, text: truncate(run.text, MAX_PARAGRAPH_CHARS) };
}

/**
 * Reads one slide text body. Bullets, indents, and spacing resolve against the
 * master level style, and the character budget bounds the serialized text.
 */
export function readSlideTextBody(params: {
  txBody: XmlElement;
  levels: PptxTextLevel[];
  theme: PptxTheme;
  budget: CharacterBudget;
  /** `p:style/a:fontRef` layer: above the master level, below paragraph/run. */
  baseStyle?: PptxRunStyle;
  /** The shape's own `a:lstStyle`, the last level layer before runs. */
  ownLevels?: PptxTextLevel[];
  onEquations: (count: number) => void;
  onTruncated: () => void;
}): PptxTextBody {
  const { txBody, levels, theme, budget, baseStyle, ownLevels, onEquations, onTruncated } = params;
  const body = bodyProperties(txBody);
  const paragraphs: SessionFileOfficeParagraph[] = [];
  const levelCounters = Array.from({ length: 9 }, () => 0);

  for (const paragraph of elementChildren(txBody)) {
    if (localName(paragraph.nodeName) !== "p") {
      continue;
    }
    if (paragraphs.length >= MAX_PARAGRAPHS) {
      onTruncated();
      break;
    }
    const properties = childNamed(paragraph, "pPr");
    const levelIndex = paragraphLevel(properties);
    const inheritedLevel = levels[levelIndex] ?? {};
    const ownLevel = ownLevels?.[levelIndex] ?? {};
    const level = mergeTextLevel(inheritedLevel, ownLevel);
    // PowerPoint consults the shape's fontRef before the default chain: a bare
    // gallery-shape run on an accent fill is white (lt1), not the default tx1.
    // The shape's own list style still outranks the fontRef.
    const paragraphStyle = mergeStyle(
      runStyleFromLevel(inheritedLevel),
      baseStyle ?? {},
      runStyleFromLevel(ownLevel),
      runStyleFromProperties(childNamed(properties, "defRPr"), theme),
    );
    const runs = readParagraphRuns(paragraph, paragraphStyle, theme, onEquations);
    const rawText = runs
      .map((run) => run.text)
      .join("")
      .replace(/\r\n?/gu, "\n");
    const text = budget.take(rawText, MAX_PARAGRAPH_CHARS);
    if (!text.trim()) {
      continue;
    }
    const bullet = bulletFor(level, paragraph);
    let listMarker: string | undefined;
    if (bullet.autoNumber) {
      levelCounters[levelIndex] = (levelCounters[levelIndex] ?? 0) + 1;
      for (let index = levelIndex + 1; index < levelCounters.length; index += 1) {
        levelCounters[index] = 0;
      }
      listMarker = autoNumberMarker(bullet.autoNumber, levelCounters[levelIndex]!);
    } else if (bullet.char) {
      listMarker = bullet.char;
    }
    const alignment = alignmentFromAttribute(attribute(properties, "algn")) ?? level.alignment;
    const spacing = paragraphSpacing(level, properties);
    const indents = paragraphIndents(level, properties);
    const paragraphFontSize =
      runs.find((run) => run.style.fontSizePt !== undefined)?.style.fontSizePt ??
      level.fontSizePt ??
      18;
    const autofitScale =
      body.textScalePct !== undefined && body.textScalePct < 100 ? body.textScalePct / 100 : 1;
    const lineSpacingPt = Math.min(
      1_000,
      Math.round(
        (spacing.lineSpacingPt ??
          (spacing.lineSpacingPct === undefined ? 0 : paragraphFontSize * spacing.lineSpacingPct)) *
          autofitScale *
          10,
      ) / 10,
    );
    const styledRuns = runs.map(styledRun).filter((run) => run.text.length > 0);
    if (styledRuns.length > MAX_RUNS) {
      onTruncated();
    }
    const boundedRuns = styledRuns.slice(0, MAX_RUNS);
    const accessibleText = truncate(
      boundedRuns.map((run) => run.text).join(""),
      MAX_PARAGRAPH_CHARS,
    );
    if (accessibleText.length < rawText.length) {
      onTruncated();
    }
    paragraphs.push({
      kind: "paragraph",
      role: listMarker ? "listItem" : "body",
      ...(listMarker ? { listMarker } : {}),
      text: accessibleText,
      ...(alignment ? { alignment } : {}),
      ...(spacing.spaceBeforePt !== undefined ? { spaceBeforePt: spacing.spaceBeforePt } : {}),
      ...(spacing.spaceAfterPt !== undefined ? { spaceAfterPt: spacing.spaceAfterPt } : {}),
      ...(lineSpacingPt > 0 ? { lineSpacingPt } : {}),
      ...(indents.indentLeftPt !== undefined ? { indentLeftPt: indents.indentLeftPt } : {}),
      ...(indents.indentFirstLinePt !== undefined
        ? { indentFirstLinePt: indents.indentFirstLinePt }
        : {}),
      runs: boundedRuns,
    });
  }
  return { ...body, paragraphs };
}
