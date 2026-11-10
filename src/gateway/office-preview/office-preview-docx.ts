/**
 * Read-only DOCX layout parser.
 *
 * The reader walks `w:body` structurally instead of collecting every `w:p`,
 * which would flatten real tables. It resolves style chains and numbering into
 * typed runs, keeps tables with their grid, spans, borders, and shading, inlines
 * bounded safe images, and splits approximate page cards at manual and
 * last-rendered page breaks.
 *
 * This is not the Microsoft Word layout engine: line breaking, floats, text
 * boxes, columns, charts, equations, and exact pagination are approximated or
 * reported through `omitted`, never silently dropped.
 */
import type {
  SessionFileOfficeBlock,
  SessionFileOfficeDocBlock,
  SessionFileOfficeImage,
  SessionFileOfficePage,
  SessionFileOfficeParagraph,
  SessionFileOfficePreview,
  SessionFileOfficeRun,
} from "../../../packages/gateway-protocol/src/index.js";
import type { DocxStyleResolver } from "./office-preview-docx-styles.js";
import {
  readDocxStyles,
  resolveParagraphLayout,
  resolveParagraphRole,
  resolveRunStyle,
} from "./office-preview-docx-styles.js";
import { buildDocxTable } from "./office-preview-docx-table.js";
import {
  OFFICE_PREVIEW_MAX_BLOCKS,
  OFFICE_PREVIEW_MAX_BLOCK_CHARS,
  OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS,
  OFFICE_PREVIEW_MAX_DOCX_PAGES,
  OFFICE_PREVIEW_MAX_DOCX_RUNS,
  OFFICE_PREVIEW_MAX_DOCUMENT_CHARS,
  OFFICE_PREVIEW_MAX_PAGE_BLOCKS,
} from "./office-preview-limits.js";
import type { DocxImageReader } from "./office-preview-media.js";
import { createDocxImageReader } from "./office-preview-media.js";
import { readDocxNumbering, type DocxNumbering } from "./office-preview-numbering.js";
import type { OmittedFeatureCounter } from "./office-preview-theme.js";
import {
  emuToPoints,
  OmittedFeatureCounter as OmittedCounter,
  readOfficeTheme,
  twipsToPoints,
} from "./office-preview-theme.js";
import {
  attribute,
  CharacterBudget,
  childNamed,
  childrenNamed,
  cleanText,
  elementChildren,
  elements,
  localName,
  propertyChild,
  readRelationships,
  truncate,
  tryParseXml,
  valAttribute,
  wordAttribute,
  type XmlElement,
} from "./office-preview-xml.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

type DocxState = {
  styles: DocxStyleResolver;
  numbering: DocxNumbering;
  media: DocxImageReader;
  budget: CharacterBudget;
  counter: OmittedFeatureCounter;
  runsUsed: number;
  tableCellsUsed: number;
  layoutBlocksUsed: number;
  legacyBlocksUsed: number;
  truncated: boolean;
};

type ParagraphContent = {
  paragraph: SessionFileOfficeParagraph;
  text: string;
  images: SessionFileOfficeImage[];
};

type ParagraphEvent =
  | { kind: "content"; content: ParagraphContent }
  | { kind: "pageBreak" }
  | { kind: "table"; table: SessionFileOfficeDocBlock };

function createRunAccumulator(state: DocxState) {
  const runs: SessionFileOfficeRun[] = [];
  let buffer = "";
  let styleKey = "";
  let style: Omit<SessionFileOfficeRun, "text"> = {};
  const flush = () => {
    if (!buffer) {
      return;
    }
    if (state.runsUsed >= OFFICE_PREVIEW_MAX_DOCX_RUNS) {
      state.truncated = true;
      buffer = "";
      return;
    }
    state.runsUsed += 1;
    if (runs.length >= 200) {
      // The paragraph run list is closed by the protocol; keep the remaining
      // text on the last run so accessibility text stays complete.
      state.truncated = true;
      const last = runs.at(-1);
      if (last) {
        last.text = truncate(`${last.text}${buffer}`, OFFICE_PREVIEW_MAX_BLOCK_CHARS);
      }
      buffer = "";
      return;
    }
    runs.push({ text: truncate(buffer, OFFICE_PREVIEW_MAX_BLOCK_CHARS), ...style });
    buffer = "";
  };
  return {
    append: (text: string, nextStyle: Omit<SessionFileOfficeRun, "text">) => {
      const key = JSON.stringify(nextStyle);
      if (key !== styleKey) {
        flush();
        style = nextStyle;
        styleKey = key;
      }
      buffer += state.budget.take(text, OFFICE_PREVIEW_MAX_BLOCK_CHARS);
    },
    take: () => {
      flush();
      return runs;
    },
  };
}

/** Flattens every visible text node of one paragraph, including nested content. */
function paragraphText(paragraph: XmlElement): string {
  const parts: string[] = [];
  const visit = (element: XmlElement): void => {
    if (element.nodeType !== 1) {
      return;
    }
    const name = localName(element.nodeName);
    switch (name) {
      case "t":
        parts.push(element.textContent ?? "");
        return;
      case "tab":
        parts.push("\t");
        return;
      case "br":
      case "cr":
        parts.push("\n");
        break;
      // Paragraph/run properties and field codes carry no visible body text.
      case "pPr":
      case "rPr":
      case "delText":
      case "instrText":
      case "del":
        return;
      case "AlternateContent": {
        const branch = childNamed(element, "Choice") ?? childNamed(element, "Fallback");
        if (branch) {
          visit(branch);
        }
        return;
      }
      default:
        for (const child of Array.from(element.childNodes)) {
          visit(child);
        }
    }
  };
  for (const child of Array.from(paragraph.childNodes)) {
    visit(child);
  }
  return cleanText(parts.join(""));
}

function readDrawingImages(drawing: XmlElement, state: DocxState): SessionFileOfficeImage[] {
  if (elements(drawing, "wp:anchor").length > 0) {
    // Floating/anchored placement is rendered inline; the approximation is explicit.
    state.counter.add("floatingObjects");
  }
  if (elements(drawing, "c:chart").length > 0) {
    state.counter.add("charts");
    return [];
  }
  if (elements(drawing, "dgm:relIds").length > 0) {
    state.counter.add("floatingObjects");
    return [];
  }
  const extent = elements(drawing, "wp:extent")[0] ?? elements(drawing, "a:ext")[0];
  const blip = elements(drawing, "a:blip")[0];
  const image = state.media.read({
    relationshipId: attribute(blip, "r:embed") ?? attribute(blip, "r:link"),
    alt: attribute(elements(drawing, "wp:docPr")[0], "descr"),
    widthPt: emuToPoints(attribute(extent, "cx")) ?? 0,
    heightPt: emuToPoints(attribute(extent, "cy")) ?? 0,
  });
  return image ? [image] : [];
}

function buildParagraphEvents(paragraph: XmlElement, state: DocxState): ParagraphEvent[] {
  const directProperties = propertyChild(paragraph, "pPr");
  const styleId = valAttribute(propertyChild(directProperties, "pStyle"));
  const chain = state.styles.paragraphChain(directProperties, styleId);
  const layout = resolveParagraphLayout(chain, state.styles.defaultFontSizePt);
  const styleName = state.styles.paragraphStyleName(styleId);
  const isList = layout.numId !== undefined;
  const role = resolveParagraphRole({
    styleId,
    styleName,
    outlineLevel: layout.outlineLevel,
    isList,
  });
  const baseParagraph: SessionFileOfficeParagraph = {
    kind: "paragraph",
    role: role.role,
    ...(role.level !== undefined ? { level: role.level } : {}),
    text: "",
    ...(layout.alignment ? { alignment: layout.alignment } : {}),
    ...(layout.spaceBeforePt !== undefined ? { spaceBeforePt: layout.spaceBeforePt } : {}),
    ...(layout.spaceAfterPt !== undefined ? { spaceAfterPt: layout.spaceAfterPt } : {}),
    ...(layout.lineSpacingPt !== undefined ? { lineSpacingPt: layout.lineSpacingPt } : {}),
    ...(layout.indentLeftPt !== undefined ? { indentLeftPt: layout.indentLeftPt } : {}),
    ...(layout.indentRightPt !== undefined ? { indentRightPt: layout.indentRightPt } : {}),
    ...(layout.indentFirstLinePt !== undefined
      ? { indentFirstLinePt: layout.indentFirstLinePt }
      : {}),
    runs: [],
  };

  const events: ParagraphEvent[] = [];
  const images: SessionFileOfficeImage[] = [];
  let accumulator = createRunAccumulator(state);
  let text = "";
  let markerPending =
    isList && layout.numId !== undefined
      ? state.numbering.nextMarker(
          layout.numId,
          Math.min(layout.ilvl ?? 0, OFFICE_PREVIEW_MAX_DOCX_LIST_LEVELS - 1),
        )
      : undefined;

  const flush = (): void => {
    const runs = accumulator.take();
    if (runs.length === 0 && !text && images.length === 0) {
      return;
    }
    events.push({
      kind: "content",
      content: {
        paragraph: {
          ...baseParagraph,
          ...(markerPending ? { listMarker: markerPending } : {}),
          text: truncate(cleanText(text), OFFICE_PREVIEW_MAX_BLOCK_CHARS),
          runs,
        },
        text,
        images: images.splice(0),
      },
    });
    markerPending = undefined;
    accumulator = createRunAccumulator(state);
    text = "";
  };

  const appendText = (
    value: string,
    runProperties: XmlElement | undefined,
    runStyleId: string | undefined,
  ): void => {
    if (!value) {
      return;
    }
    const style = resolveRunStyle(
      state.styles.runChain(runProperties, styleId, runStyleId),
      state.styles,
    );
    accumulator.append(value, style);
    text += value;
  };

  const visitRun = (run: XmlElement): void => {
    const runProperties = childNamed(run, "rPr");
    const runStyleId = valAttribute(propertyChild(runProperties, "rStyle"));
    for (const child of elementChildren(run)) {
      const name = localName(child.nodeName);
      switch (name) {
        case "t":
          appendText(child.textContent ?? "", runProperties, runStyleId);
          break;
        case "tab":
          appendText("\t", runProperties, runStyleId);
          break;
        case "br": {
          const type = wordAttribute(child, "type") ?? valAttribute(child);
          if (type === "page") {
            flush();
            events.push({ kind: "pageBreak" });
          } else {
            appendText("\n", runProperties, runStyleId);
          }
          break;
        }
        case "cr":
          appendText("\n", runProperties, runStyleId);
          break;
        case "lastRenderedPageBreak":
          flush();
          events.push({ kind: "pageBreak" });
          break;
        case "drawing":
          images.push(...readDrawingImages(child, state));
          break;
        case "pict":
          state.counter.add("images");
          break;
        case "object":
          state.counter.add("embeddedObjects");
          break;
        case "oMath":
        case "oMathPara":
          state.counter.add("equations");
          break;
        case "AlternateContent": {
          const branch = childNamed(child, "Choice") ?? childNamed(child, "Fallback");
          if (branch) {
            visitRun(branch);
          }
          break;
        }
        default:
          break;
      }
    }
  };

  const visitContainer = (container: XmlElement): void => {
    for (const child of elementChildren(container)) {
      const name = localName(child.nodeName);
      if (name === "r") {
        visitRun(child);
      } else if (name === "hyperlink" || name === "smartTag" || name === "ins" || name === "sdt") {
        visitContainer(name === "sdt" ? (childNamed(child, "sdtContent") ?? child) : child);
      } else if (name === "del") {
        continue;
      } else if (name === "oMath" || name === "oMathPara") {
        state.counter.add("equations");
      } else if (name === "drawing") {
        images.push(...readDrawingImages(child, state));
      } else if (name === "AlternateContent") {
        const branch = childNamed(child, "Choice") ?? childNamed(child, "Fallback");
        if (branch) {
          visitContainer(branch);
        }
      }
    }
  };

  visitContainer(paragraph);
  flush();
  return events;
}

/** Cell paragraphs drop page-break events and count unrenderable images. */
function cellParagraphs(paragraph: XmlElement, state: DocxState): SessionFileOfficeParagraph[] {
  const paragraphs: SessionFileOfficeParagraph[] = [];
  for (const event of buildParagraphEvents(paragraph, state)) {
    if (event.kind !== "content") {
      continue;
    }
    if (event.content.images.length > 0) {
      state.counter.add("images", event.content.images.length);
    }
    paragraphs.push(event.content.paragraph);
  }
  return paragraphs;
}

type PageGeometry = {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
};

const DEFAULT_PAGE: PageGeometry = {
  widthPt: 612,
  heightPt: 792,
  marginTopPt: 72,
  marginRightPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
};

function readPageGeometry(sectPr: XmlElement | undefined): PageGeometry {
  if (!sectPr) {
    return DEFAULT_PAGE;
  }
  const size = childNamed(sectPr, "pgSz");
  const margins = childNamed(sectPr, "pgMar");
  return {
    widthPt: Math.min(2_000, twipsToPoints(wordAttribute(size, "w")) ?? DEFAULT_PAGE.widthPt),
    heightPt: Math.min(2_000, twipsToPoints(wordAttribute(size, "h")) ?? DEFAULT_PAGE.heightPt),
    marginTopPt: Math.min(
      1_000,
      twipsToPoints(wordAttribute(margins, "top")) ?? DEFAULT_PAGE.marginTopPt,
    ),
    marginRightPt: Math.min(
      1_000,
      twipsToPoints(wordAttribute(margins, "right")) ?? DEFAULT_PAGE.marginRightPt,
    ),
    marginBottomPt: Math.min(
      1_000,
      twipsToPoints(wordAttribute(margins, "bottom")) ?? DEFAULT_PAGE.marginBottomPt,
    ),
    marginLeftPt: Math.min(
      1_000,
      twipsToPoints(wordAttribute(margins, "left")) ?? DEFAULT_PAGE.marginLeftPt,
    ),
  };
}

function headerFooterPartId(
  sectPr: XmlElement | undefined,
  tag: "headerReference" | "footerReference",
): string | undefined {
  const references = childrenNamed(sectPr, tag);
  const preferred =
    references.find((reference) => wordAttribute(reference, "type") === "default") ?? references[0];
  return attribute(preferred, "r:id");
}

function buildHeaderFooter(
  archive: OfficeZipArchive,
  relationships: ReadonlyMap<string, string>,
  sectPr: XmlElement | undefined,
  tag: "headerReference" | "footerReference",
  counter: OmittedFeatureCounter,
): SessionFileOfficeParagraph[] | undefined {
  const relationshipId = headerFooterPartId(sectPr, tag);
  const partPath = relationshipId ? relationships.get(relationshipId) : undefined;
  if (!partPath) {
    return undefined;
  }
  const xml = archive.readText(partPath);
  const doc = xml ? tryParseXml(xml) : undefined;
  if (!doc) {
    return undefined;
  }
  const paragraphs: SessionFileOfficeParagraph[] = [];
  for (const paragraph of elements(doc, "w:p")) {
    if (paragraphs.length >= 20) {
      break;
    }
    const drawings = elements(paragraph, "w:drawing").length + elements(paragraph, "w:pict").length;
    if (drawings > 0) {
      // Header/footer images are not represented in the page payload.
      counter.add("images", drawings);
    }
    const text = truncate(paragraphText(paragraph).trim(), 2_000);
    if (!text) {
      continue;
    }
    paragraphs.push({ kind: "paragraph", role: "body", text, runs: [{ text }] });
  }
  return paragraphs.length > 0 ? paragraphs : undefined;
}

function legacyBlockFor(content: ParagraphContent): SessionFileOfficeBlock | undefined {
  const text = content.text.trim();
  if (!text) {
    return undefined;
  }
  const bounded = truncate(text, OFFICE_PREVIEW_MAX_BLOCK_CHARS);
  if (content.paragraph.role === "heading" || content.paragraph.role === "title") {
    return {
      kind: "heading",
      level: Math.max(1, Math.min(6, content.paragraph.level ?? 1)),
      text: bounded,
    };
  }
  if (content.paragraph.role === "listItem") {
    return { kind: "listItem", text: bounded };
  }
  return { kind: "paragraph", text: bounded };
}

/** Reads one word-processing package; null means the package has no document part. */
export function parseDocument(archive: OfficeZipArchive): SessionFileOfficePreview | null {
  const documentXml = archive.readText("word/document.xml");
  if (!documentXml) {
    return null;
  }
  const doc = tryParseXml(documentXml);
  if (!doc) {
    return null;
  }
  const body = elements(doc, "w:body")[0];
  if (!body) {
    return null;
  }
  const relationships = readRelationships(archive, "word/_rels/document.xml.rels", "word/");
  const theme = readOfficeTheme(archive, "word/theme/theme1.xml");
  const counter = new OmittedCounter();
  const state: DocxState = {
    styles: readDocxStyles(archive, theme),
    numbering: readDocxNumbering(archive),
    media: createDocxImageReader(archive, relationships, counter),
    budget: new CharacterBudget(OFFICE_PREVIEW_MAX_DOCUMENT_CHARS),
    counter,
    runsUsed: 0,
    tableCellsUsed: 0,
    layoutBlocksUsed: 0,
    legacyBlocksUsed: 0,
    truncated: false,
  };
  const sectionProperties = elements(doc, "w:sectPr");
  const geometry = readPageGeometry(sectionProperties.at(-1));
  if (sectionProperties.length > 1) {
    counter.add("multipleSections", sectionProperties.length - 1);
  }
  counter.add("exactPagination", 0);
  const header = buildHeaderFooter(
    archive,
    relationships,
    sectionProperties.at(-1),
    "headerReference",
    counter,
  );
  const footer = buildHeaderFooter(
    archive,
    relationships,
    sectionProperties.at(-1),
    "footerReference",
    counter,
  );

  const events: ParagraphEvent[] = [];
  const collect = (container: XmlElement): void => {
    for (const child of elementChildren(container)) {
      const name = localName(child.nodeName);
      if (name === "p") {
        events.push(...buildParagraphEvents(child, state));
      } else if (name === "tbl") {
        events.push({
          kind: "table",
          table: buildDocxTable(child, {
            styles: state.styles,
            counter: state.counter,
            state,
            buildParagraphs: (paragraph) => cellParagraphs(paragraph, state),
          }),
        });
      } else if (name === "sdt") {
        collect(childNamed(child, "sdtContent") ?? child);
      } else if (name === "AlternateContent") {
        const branch = childNamed(child, "Choice") ?? childNamed(child, "Fallback");
        if (branch) {
          collect(branch);
        }
      }
    }
  };
  collect(body);

  const legacyBlocks: SessionFileOfficeBlock[] = [];
  const pages: SessionFileOfficePage[] = [];
  let blocks: SessionFileOfficeDocBlock[] = [];
  let pageStarted = false;

  const pushPage = (): void => {
    if (!pageStarted && pages.length === 0) {
      return;
    }
    pages.push({
      ...geometry,
      ...(header ? { header } : {}),
      ...(footer ? { footer } : {}),
      blocks,
    });
    blocks = [];
    pageStarted = false;
  };

  const addBlock = (block: SessionFileOfficeDocBlock): void => {
    if (pages.length >= OFFICE_PREVIEW_MAX_DOCX_PAGES) {
      state.truncated = true;
      return;
    }
    if (blocks.length >= OFFICE_PREVIEW_MAX_PAGE_BLOCKS) {
      state.truncated = true;
      return;
    }
    if (state.layoutBlocksUsed >= OFFICE_PREVIEW_MAX_BLOCKS) {
      state.truncated = true;
      return;
    }
    blocks.push(block);
    state.layoutBlocksUsed += 1;
    pageStarted = true;
  };

  for (const event of events) {
    if (event.kind === "pageBreak") {
      // Leading breaks and repeated breaks do not create empty pages.
      if (pageStarted) {
        pushPage();
      }
      continue;
    }
    if (event.kind === "table") {
      addBlock(event.table);
      continue;
    }
    const { content } = event;
    const legacy = legacyBlockFor(content);
    if (legacy) {
      if (state.legacyBlocksUsed < OFFICE_PREVIEW_MAX_BLOCKS) {
        legacyBlocks.push(legacy);
        state.legacyBlocksUsed += 1;
      } else {
        state.truncated = true;
      }
    }
    if (content.paragraph.runs.length > 0 || content.paragraph.listMarker) {
      addBlock(content.paragraph);
    }
    for (const image of content.images) {
      addBlock(image);
    }
  }
  if (pageStarted) {
    pushPage();
  }
  if (state.budget.exhausted) {
    state.truncated = true;
  }
  return {
    format: "docx",
    blocks: legacyBlocks,
    pages,
    ...(state.truncated ? { truncated: true } : {}),
    omitted: counter.list(),
  };
}
