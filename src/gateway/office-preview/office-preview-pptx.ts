/**
 * Read-only PPTX reader: slide outlines plus fixed slide geometry.
 *
 * Presentations keep their ordered outline (title and visible text lines) for
 * text readers, and additionally carry the declared slide canvas, background,
 * and absolutely placed shapes so the Control UI can render the slide layout
 * once and only scale it. OOXML places almost everything outside the slide part
 * itself, so the reader resolves the slide layout and master placeholders, the
 * master text styles, and the package theme before reading `p:spTree`.
 *
 * This is not PowerPoint's layout engine: charts, SmartArt, embedded objects,
 * audio/video, and shapes without a resolvable box are reported through
 * `omitted`, never silently dropped or reflowed into a text outline.
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
  firstRelationshipOfType,
  gradientFirstStop,
  parsePartXml,
  pptxPoints,
  readMasterStyles,
  readPlaceholderFrames,
  readPptxTheme,
  readTypedRelationships,
  relationshipsPathFor,
  resolveDrawingColor,
  type PptxMasterStyles,
  type PptxPlaceholders,
  type PptxTheme,
} from "./office-preview-pptx-master.js";
import { createSlideImageReader } from "./office-preview-pptx-media.js";
import { readSlideShapes, type SlideShape } from "./office-preview-pptx-shapes.js";
import { readSlideTextBody } from "./office-preview-pptx-text.js";
import { OmittedFeatureCounter } from "./office-preview-theme.js";
import {
  attribute,
  CharacterBudget,
  childNamed,
  cleanText,
  elements,
  truncate,
  tryParseXml,
  type XmlDocumentBody,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

type SlideText = { lines: string[]; truncated: boolean };

/** PowerPoint's default canvas when a package declares no `p:sldSz`. */
const DEFAULT_SLIDE_WIDTH_PT = 720;
const DEFAULT_SLIDE_HEIGHT_PT = 540;

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
): { slide: SessionFileOfficeSlide; truncated: boolean; doc?: XmlDocumentBody } {
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
    doc,
  };
}

function slideParts(archive: OfficeZipArchive): string[] {
  const presentationXml = archive.readText("ppt/presentation.xml");
  if (presentationXml) {
    const doc = tryParseXml(presentationXml);
    if (doc) {
      const relationships = readSlideRelationshipTargets(
        archive,
        "ppt/_rels/presentation.xml.rels",
        "ppt/",
      );
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

/** Id -> in-package path for the presentation part's slide relationships. */
function readSlideRelationshipTargets(
  archive: OfficeZipArchive,
  relsPath: string,
  baseDir: string,
): Map<string, string> {
  return new Map(
    [...readTypedRelationships(archive, relsPath, baseDir)].map(([id, entry]) => [id, entry.path]),
  );
}

/** Declared canvas from `p:sldSz`, defaulting to PowerPoint's 4:3 page. */
function readSlideSize(presentation: XmlDocumentBody | undefined): {
  widthPt: number;
  heightPt: number;
} {
  const size = presentation ? elements(presentation, "p:sldSz")[0] : undefined;
  const width = pptxPoints(attribute(size, "cx"));
  const height = pptxPoints(attribute(size, "cy"));
  return {
    widthPt:
      width && width > 0 ? Math.min(4_000, Math.round(width * 10) / 10) : DEFAULT_SLIDE_WIDTH_PT,
    heightPt:
      height && height > 0
        ? Math.min(4_000, Math.round(height * 10) / 10)
        : DEFAULT_SLIDE_HEIGHT_PT,
  };
}

type PartBackground = {
  color?: string;
  /** A declared background this reader cannot draw; reported, never silent. */
  unsupported?: boolean;
};

/**
 * Reads one part's `p:bg`. Slides inherit their background from the slide
 * layout and then the master, so every part resolves the same way: solid fill,
 * gradient first stop, or a `p:bgRef` theme fill.
 */
function readBackground(doc: XmlDocumentBody | undefined, theme: PptxTheme): PartBackground {
  const background = doc ? elements(doc, "p:bg")[0] : undefined;
  if (!background) {
    return {};
  }
  const properties = childNamed(background, "bgPr");
  if (properties) {
    const solid = resolveDrawingColor(childNamed(properties, "solidFill"), theme);
    if (solid) {
      return { color: solid };
    }
    const gradient = childNamed(properties, "gradFill");
    if (gradient) {
      const color = gradientFirstStop(gradient, theme);
      return color ? { color } : { unsupported: true };
    }
    // Pattern, texture, and group fills are not drawable on the canvas.
    return { unsupported: true };
  }
  if (childNamed(background, "bgRef")) {
    const color = resolveDrawingColor(childNamed(background, "bgRef"), theme);
    return color ? { color } : { unsupported: true };
  }
  return {};
}

/** Resolved per-slide inheritance context, cached by package part. */
class SlideInheritance {
  private readonly themes = new Map<string, PptxTheme>();
  private readonly masters = new Map<
    string,
    { styles: PptxMasterStyles; placeholders: PptxPlaceholders; background: PartBackground }
  >();
  private readonly layouts = new Map<
    string,
    { placeholders: PptxPlaceholders; background: PartBackground }
  >();
  private readonly presentationMaster: string | undefined;

  constructor(
    private readonly archive: OfficeZipArchive,
    presentationRels: ReadonlyMap<string, { path: string; type: string }>,
  ) {
    this.presentationMaster = firstRelationshipOfType(presentationRels, "slideMaster");
  }

  /** Layout placeholder boxes plus master styles and theme for one slide part. */
  resolve(slidePart: string): {
    layoutPlaceholders: PptxPlaceholders;
    masterPlaceholders: PptxPlaceholders;
    theme: PptxTheme;
    masterStyles: PptxMasterStyles;
    relationships: Map<string, string>;
    /** Slide layout background, then master background (first `p:bg` wins). */
    layoutBackground: PartBackground;
    masterBackground: PartBackground;
    /** Parts whose declared background cannot be drawn; counted once each. */
    unsupportedBackgroundKeys: string[];
  } {
    const slideRelationships = readTypedRelationships(
      this.archive,
      relationshipsPathFor(slidePart),
      baseDirOf(slidePart),
    );
    const layoutPath = firstRelationshipOfType(slideRelationships, "slideLayout");
    const layoutRelationships = layoutPath
      ? readTypedRelationships(
          this.archive,
          relationshipsPathFor(layoutPath),
          baseDirOf(layoutPath),
        )
      : new Map<string, { path: string; type: string }>();
    const masterPath =
      firstRelationshipOfType(layoutRelationships, "slideMaster") ?? this.presentationMaster;
    const masterRelationships = masterPath
      ? readTypedRelationships(
          this.archive,
          relationshipsPathFor(masterPath),
          baseDirOf(masterPath),
        )
      : new Map<string, { path: string; type: string }>();
    const themePath =
      firstRelationshipOfType(masterRelationships, "theme") ?? "ppt/theme/theme1.xml";
    const masterDoc = parsePartXml(this.archive, masterPath);
    const masterKey = masterPath ?? "";
    const themeKey = `${themePath}|${masterKey}`;
    let theme = this.themes.get(themeKey);
    if (!theme) {
      theme = readPptxTheme(this.archive, themePath, masterDoc);
      this.themes.set(themeKey, theme);
    }
    let master = this.masters.get(masterKey);
    if (!master) {
      master = {
        styles: readMasterStyles(masterDoc, theme),
        placeholders: readPlaceholderFrames(masterDoc),
        background: readBackground(masterDoc, theme),
      };
      this.masters.set(masterKey, master);
    }
    let layout = layoutPath ? this.layouts.get(layoutPath) : undefined;
    if (layoutPath && !layout) {
      const layoutDoc = parsePartXml(this.archive, layoutPath);
      layout = {
        placeholders: readPlaceholderFrames(layoutDoc),
        background: readBackground(layoutDoc, theme),
      };
      this.layouts.set(layoutPath, layout);
    }
    return {
      layoutPlaceholders: layout?.placeholders ?? new Map(),
      masterPlaceholders: master.placeholders,
      theme,
      masterStyles: master.styles,
      relationships: new Map([...slideRelationships].map(([id, entry]) => [id, entry.path])),
      layoutBackground: layout?.background ?? {},
      masterBackground: master.background,
      unsupportedBackgroundKeys: [
        ...(layout?.background.unsupported && layoutPath ? [layoutPath] : []),
        ...(master.background.unsupported ? [`master:${masterKey}`] : []),
      ],
    };
  }
}

function baseDirOf(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  return slash < 0 ? "" : partPath.slice(0, slash + 1);
}

/** Reads one presentation package; null means the package is not a presentation. */
export function parsePresentation(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  if (!archive.has("ppt/presentation.xml") && !archive.has("ppt/slides/slide1.xml")) {
    return null;
  }
  const presentation = parsePartXml(archive, "ppt/presentation.xml");
  const slideSize = readSlideSize(presentation);
  const presentationRelationships = readTypedRelationships(
    archive,
    "ppt/_rels/presentation.xml.rels",
    "ppt/",
  );
  const inheritance = new SlideInheritance(archive, presentationRelationships);
  const counter = new OmittedFeatureCounter();
  const media = createSlideImageReader(archive, counter);
  const budget = new CharacterBudget(OFFICE_PREVIEW_MAX_PRESENTATION_CHARS);
  const slides: SessionFileOfficeSlide[] = [];
  const countedBackgroundParts = new Set<string>();
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
    if (parsed.doc) {
      const context = inheritance.resolve(part);
      const slideBackground = readBackground(parsed.doc, context.theme);
      if (slideBackground.unsupported) {
        counter.add("drawings");
      }
      // Backgrounds inherit slide -> layout -> master; the first declared `p:bg`
      // wins, and an undrawable one is reported once per owning part.
      const background =
        slideBackground.color ?? context.layoutBackground.color ?? context.masterBackground.color;
      if (background) {
        parsed.slide.background = background;
      }
      for (const key of context.unsupportedBackgroundKeys) {
        if (!countedBackgroundParts.has(key)) {
          countedBackgroundParts.add(key);
          counter.add("drawings");
        }
      }
      const shapes: SlideShape[] = readSlideShapes(elements(parsed.doc, "p:spTree")[0], {
        theme: context.theme,
        masterStyles: context.masterStyles,
        layoutPlaceholders: context.layoutPlaceholders,
        masterPlaceholders: context.masterPlaceholders,
        relationships: context.relationships,
        media,
        counter,
        onTruncated: () => {
          truncated = true;
        },
        onEquations: (count: number) => counter.add("equations", count),
        readText: (txBody, levels, baseStyle) =>
          readSlideTextBody({
            txBody,
            levels,
            baseStyle,
            theme: context.theme,
            budget,
            onEquations: (count) => counter.add("equations", count),
            onTruncated: () => {
              truncated = true;
            },
          }),
      });
      if (shapes.length > 0) {
        parsed.slide.shapes = shapes;
      }
    }
    slides.push(parsed.slide);
  }
  if (budget.exhausted) {
    truncated = true;
  }
  return {
    format: "pptx",
    slides,
    slideSize,
    ...(media.media.length > 0 ? { media: media.media } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(counter.list().length > 0 ? { omitted: counter.list() } : {}),
  };
}
