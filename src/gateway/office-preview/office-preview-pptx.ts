/**
 * Read-only PPTX slide outline parser.
 *
 * Presentations keep their existing outline contract: ordered slides with a
 * title and visible text lines. Geometry, themes, and media are intentionally
 * out of scope for the text outline; slide order follows `p:sldIdLst` and falls
 * back to numeric part order, and external relationships are never read.
 */
import type {
  SessionFileOfficePreview,
  SessionFileOfficeSlide,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  OFFICE_PREVIEW_MAX_PRESENTATION_CHARS,
  OFFICE_PREVIEW_MAX_SLIDE_LINES,
  OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS,
  OFFICE_PREVIEW_MAX_SLIDES,
} from "./office-preview-limits.js";
import {
  attribute,
  CharacterBudget,
  cleanText,
  elements,
  readRelationships,
  truncate,
  tryParseXml,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

type SlideText = { lines: string[]; truncated: boolean };

function shapeLines(shape: XmlElement): SlideText {
  const lines: string[] = [];
  let truncated = false;
  for (const paragraph of elements(shape, "a:p")) {
    const text = cleanText(
      elements(paragraph, "a:t")
        .map((node) => node.textContent ?? "")
        .join(""),
    ).trim();
    if (!text) {
      continue;
    }
    const line = truncate(text, OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS);
    truncated ||= line.length < text.length;
    lines.push(line);
  }
  return { lines, truncated };
}

function isTitleShape(shape: XmlElement): boolean {
  const placeholder = elements(shape, "p:ph")[0];
  const type = attribute(placeholder, "type");
  return type === "title" || type === "ctrTitle";
}

/** Every per-slide cut reports upward so the payload never hides truncation. */
function parseSlide(
  xml: string,
  index: number,
): { slide: SessionFileOfficeSlide; truncated: boolean } {
  const doc = tryParseXml(xml);
  if (!doc) {
    return { slide: { index, lines: [] }, truncated: true };
  }
  const lines: string[] = [];
  let title: string | undefined;
  let truncated = false;
  for (const shape of elements(doc, "p:sp")) {
    const shapeText = shapeLines(shape);
    truncated ||= shapeText.truncated;
    if (shapeText.lines.length === 0) {
      continue;
    }
    if (title === undefined && isTitleShape(shape)) {
      const rawTitle = shapeText.lines[0] ?? "";
      title = truncate(rawTitle, 512);
      truncated ||= title.length < rawTitle.length;
      lines.push(...shapeText.lines.slice(1));
      continue;
    }
    lines.push(...shapeText.lines);
  }
  const visibleLines = lines.filter((line) => line.length > 0);
  truncated ||= visibleLines.length > OFFICE_PREVIEW_MAX_SLIDE_LINES;
  return {
    slide: {
      index,
      ...(title ? { title } : {}),
      lines: visibleLines.slice(0, OFFICE_PREVIEW_MAX_SLIDE_LINES),
    },
    truncated,
  };
}

function slideParts(archive: OfficeZipArchive): string[] {
  const presentationXml = archive.readText("ppt/presentation.xml");
  if (presentationXml) {
    const doc = tryParseXml(presentationXml);
    if (doc) {
      const relationships = readRelationships(archive, "ppt/_rels/presentation.xml.rels", "ppt/");
      const parts: string[] = [];
      for (const slideId of elements(doc, "p:sldId")) {
        const target = relationships.get(attribute(slideId, "r:id") ?? "");
        if (target) {
          parts.push(target);
        }
      }
      if (parts.length > 0) {
        return parts;
      }
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

/** Reads one presentation package; null means the package is not a presentation. */
export function parsePresentation(archive: OfficeZipArchive): SessionFileOfficePreview | null {
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
    const parsed = parseSlide(xml, slides.length + 1);
    truncated ||= parsed.truncated;
    parsed.slide.lines = parsed.slide.lines
      .map((line) => budget.take(line, OFFICE_PREVIEW_MAX_SLIDE_LINE_CHARS))
      .filter((line) => line.length > 0);
    slides.push(parsed.slide);
  }
  if (budget.exhausted) {
    truncated = true;
  }
  return { format: "pptx", slides, ...(truncated ? { truncated: true } : {}) };
}
