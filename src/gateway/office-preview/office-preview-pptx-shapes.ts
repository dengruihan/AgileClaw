/**
 * Slide shape walker for the PPTX reader.
 *
 * `p:spTree` is walked in document order so the payload keeps the slide's
 * z-order. Each shape resolves its own transform (or its layout/master
 * placeholder box), group transforms compose into their children, and every
 * shape the reader cannot place or draw is counted through the shared omission
 * counter instead of vanishing.
 */
import type { SessionFileOfficeSlide } from "../../../packages/gateway-protocol/src/index.js";
import {
  pptxPoints,
  placeholderFrame,
  resolveDrawingColor,
  solidFillColor,
  styleRoleForPlaceholder,
  themeFontFace,
  type PptxFrame,
  type PptxMasterStyles,
  type PptxPlaceholders,
  type PptxTextLevel,
  type PptxTheme,
} from "./office-preview-pptx-master.js";
import type { SlideImageReader } from "./office-preview-pptx-media.js";
import type { PptxRunStyle, PptxTextBody } from "./office-preview-pptx-text.js";
import type { OmittedFeatureCounter } from "./office-preview-theme.js";
import {
  attribute,
  childNamed,
  childrenNamed,
  elementChildren,
  localName,
  type XmlElement,
} from "./office-preview-xml.js";

export type SlideShape = NonNullable<SessionFileOfficeSlide["shapes"]>[number];

/** One composed group transform: parent points plus child scale factors. */
type GroupTransform = { offsetX: number; offsetY: number; scaleX: number; scaleY: number };

const IDENTITY: GroupTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
const MAX_GROUP_DEPTH = 4;
const MAX_SHAPES_PER_SLIDE = 200;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 64;
const MAX_TABLE_COLUMNS = 64;

export type PptxShapeContext = {
  theme: PptxTheme;
  masterStyles: PptxMasterStyles;
  layoutPlaceholders: PptxPlaceholders;
  masterPlaceholders: PptxPlaceholders;
  relationships: ReadonlyMap<string, string>;
  media: SlideImageReader;
  counter: OmittedFeatureCounter;
  onTruncated: () => void;
  onEquations: (count: number) => void;
  readText: (txBody: XmlElement, levels: PptxTextLevel[], baseStyle?: PptxRunStyle) => PptxTextBody;
};

function frameFromXfrm(xfrm: XmlElement | undefined): PptxFrame | undefined {
  if (!xfrm) {
    return undefined;
  }
  const off = childNamed(xfrm, "off");
  const ext = childNamed(xfrm, "ext");
  const xPt = pptxPoints(attribute(off, "x"));
  const yPt = pptxPoints(attribute(off, "y"));
  const widthPt = pptxPoints(attribute(ext, "cx"));
  const heightPt = pptxPoints(attribute(ext, "cy"));
  if (xPt === undefined || yPt === undefined || widthPt === undefined || heightPt === undefined) {
    return undefined;
  }
  return {
    xPt,
    yPt,
    widthPt: Math.max(0, widthPt),
    heightPt: Math.max(0, heightPt),
  };
}

/** Own `a:xfrm` box; graphic frames carry their transform as `p:xfrm`. */
function ownFrame(element: XmlElement): PptxFrame | undefined {
  const direct = childNamed(element, "xfrm");
  if (direct) {
    return frameFromXfrm(direct);
  }
  const properties = childNamed(element, "spPr") ?? childNamed(element, "grpSpPr");
  return frameFromXfrm(childNamed(properties, "xfrm"));
}

function placeholderOf(element: XmlElement): XmlElement | undefined {
  return elementChildren(element)
    .map((child) => childNamed(child, "nvPr"))
    .map((properties) => childNamed(properties, "ph"))
    .find((placeholder) => placeholder !== undefined);
}

function transformFrame(frame: PptxFrame, transform: GroupTransform): PptxFrame {
  const xPt = Math.round((transform.offsetX + frame.xPt * transform.scaleX) * 10) / 10;
  const yPt = Math.round((transform.offsetY + frame.yPt * transform.scaleY) * 10) / 10;
  const widthPt = Math.round(frame.widthPt * transform.scaleX * 10) / 10;
  const heightPt = Math.round(frame.heightPt * transform.scaleY * 10) / 10;
  return {
    xPt: Math.max(-4_000, Math.min(4_000, xPt)),
    yPt: Math.max(-4_000, Math.min(4_000, yPt)),
    widthPt: Math.max(0, Math.min(8_000, widthPt)),
    heightPt: Math.max(0, Math.min(8_000, heightPt)),
  };
}

function rotationOf(element: XmlElement): Pick<SlideShape, "rotationDeg"> {
  const xfrm = childNamed(element, "xfrm") ?? childNamed(childNamed(element, "spPr"), "xfrm");
  const rotation = Number.parseFloat(attribute(xfrm, "rot") ?? "");
  if (!Number.isFinite(rotation) || rotation === 0) {
    return {};
  }
  const degrees = Math.round((rotation / 60_000) * 10) / 10;
  return { rotationDeg: Math.max(-360, Math.min(360, degrees)) };
}

function flipsOf(element: XmlElement): Pick<SlideShape, "flipHorizontal" | "flipVertical"> {
  const xfrm = childNamed(element, "xfrm") ?? childNamed(childNamed(element, "spPr"), "xfrm");
  return {
    ...(attribute(xfrm, "flipH") === "1" ? { flipHorizontal: true } : {}),
    ...(attribute(xfrm, "flipV") === "1" ? { flipVertical: true } : {}),
  };
}

type ShapePaint = {
  fill?: string;
  /** Fill kinds the reader cannot draw; counted instead of silently dropping. */
  unsupportedFill?: "drawings" | "images";
  lineColor?: string;
  lineWidthPt?: number;
  lineStyle?: SlideShape["lineStyle"];
  /** `p:style/a:fontRef` defaults, the lowest-priority run layer. */
  textStyle?: PptxRunStyle;
};

function styleReference(
  style: XmlElement | undefined,
  name: "fillRef" | "lnRef" | "fontRef",
): XmlElement | undefined {
  return childNamed(style, name);
}

function referenceIndex(reference: XmlElement | undefined): number | undefined {
  const index = Number.parseInt(attribute(reference, "idx") ?? "", 10);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

/** Gradient fills collapse to their first resolvable stop. */
function gradientFirstStop(gradient: XmlElement | undefined, theme: PptxTheme): string | undefined {
  for (const stop of childrenNamed(childNamed(gradient, "gsLst"), "gs")) {
    const color = resolveDrawingColor(stop, theme);
    if (color) {
      return color;
    }
  }
  return undefined;
}

/** Theme line-style references map to the Office widths of 0.5/1/1.5pt. */
function lineRefWidth(index: number): number {
  return index <= 1 ? 0.5 : index === 2 ? 1 : 1.5;
}

/**
 * Shape paint resolves the explicit `p:spPr` fill/line first and falls back to
 * `p:style` references, which is how every shape inserted from PowerPoint's
 * shape gallery is styled. Unsupported paint kinds are reported, never dropped.
 */
function readShapePaint(
  properties: XmlElement | undefined,
  style: XmlElement | undefined,
  theme: PptxTheme,
): ShapePaint {
  const paint: ShapePaint = {};
  const solid = resolveDrawingColor(childNamed(properties, "solidFill"), theme);
  const gradient = childNamed(properties, "gradFill");
  if (solid) {
    paint.fill = solid;
  } else if (gradient) {
    paint.fill = gradientFirstStop(gradient, theme);
    if (!paint.fill) {
      paint.unsupportedFill = "drawings";
    }
  } else if (childNamed(properties, "noFill")) {
    // An explicit `a:noFill` outranks any style reference.
  } else if (childNamed(properties, "pattFill") || childNamed(properties, "grpFill")) {
    paint.unsupportedFill = "drawings";
  } else if (childNamed(properties, "blipFill")) {
    paint.unsupportedFill = "images";
  } else {
    const reference = styleReference(style, "fillRef");
    const index = referenceIndex(reference);
    if (index !== undefined && index > 0) {
      paint.fill = resolveDrawingColor(reference, theme);
      if (!paint.fill) {
        paint.unsupportedFill = "drawings";
      }
    }
  }

  const line = childNamed(properties, "ln");
  if (line) {
    if (!childNamed(line, "noFill")) {
      const color = resolveDrawingColor(childNamed(line, "solidFill"), theme);
      if (color) {
        const width = pptxPoints(attribute(line, "w"));
        const dash = attribute(childNamed(line, "prstDash"), "val");
        paint.lineColor = color;
        paint.lineWidthPt = Math.max(
          0,
          Math.min(100, Math.round((width !== undefined && width >= 0 ? width : 1) * 10) / 10),
        );
        if (dash === "dot" || dash === "sysDot") {
          paint.lineStyle = "dotted";
        } else if (dash && dash !== "solid") {
          paint.lineStyle = "dashed";
        }
      }
    }
  } else {
    const reference = styleReference(style, "lnRef");
    const index = referenceIndex(reference);
    if (index !== undefined && index > 0) {
      const color = resolveDrawingColor(reference, theme);
      if (color) {
        paint.lineColor = color;
        paint.lineWidthPt = lineRefWidth(index);
      }
    }
  }

  const fontReference = styleReference(style, "fontRef");
  if (fontReference) {
    const index = attribute(fontReference, "idx");
    const color = resolveDrawingColor(fontReference, theme);
    const fontName = themeFontFace(
      index === "major" ? "+mj-lt" : index === "minor" ? "+mn-lt" : undefined,
      theme,
    );
    if (color || fontName) {
      paint.textStyle = {
        ...(color ? { color } : {}),
        ...(fontName ? { fontName } : {}),
      };
    }
  }
  return paint;
}

function presetOf(properties: XmlElement | undefined): string | undefined {
  const preset = attribute(childNamed(properties, "prstGeom"), "prst");
  return preset ? preset.slice(0, 32) : undefined;
}

function levelsFor(placeholder: XmlElement | undefined, styles: PptxMasterStyles): PptxTextLevel[] {
  const role = styleRoleForPlaceholder(placeholder);
  return styles.styles[role] ?? styles.styles.other;
}

function textOfShape(
  element: XmlElement,
  context: PptxShapeContext,
  placeholder: XmlElement | undefined,
  baseStyle: PptxRunStyle | undefined,
): PptxTextBody | undefined {
  const txBody = childNamed(element, "txBody");
  if (!txBody) {
    return undefined;
  }
  return context.readText(txBody, levelsFor(placeholder, context.masterStyles), baseStyle);
}

function tableOf(
  table: XmlElement,
  context: PptxShapeContext,
): NonNullable<SlideShape["table"]> | undefined {
  const grid = childNamed(table, "tblGrid");
  const widths = (grid ? elementChildren(grid) : [])
    .filter((column) => localName(column.nodeName) === "gridCol")
    .slice(0, MAX_TABLE_COLUMNS)
    .map((column) => Math.max(0, Math.min(2_000, pptxPoints(attribute(column, "w")) ?? 0)));
  const rows: NonNullable<SlideShape["table"]>["rows"] = [];
  for (const row of elementChildren(table)) {
    if (localName(row.nodeName) !== "tr") {
      continue;
    }
    if (rows.length >= MAX_TABLE_ROWS) {
      context.onTruncated();
      break;
    }
    const cells: NonNullable<SlideShape["table"]>["rows"][number]["cells"][number][] = [];
    for (const cell of elementChildren(row)) {
      if (localName(cell.nodeName) !== "tc") {
        continue;
      }
      // Continuation cells of a merged span render through their origin cell.
      if (attribute(cell, "hMerge") === "1" || attribute(cell, "vMerge") === "1") {
        continue;
      }
      if (cells.length >= MAX_TABLE_CELLS) {
        context.onTruncated();
        break;
      }
      const properties = childNamed(cell, "tcPr");
      const span = Number.parseInt(attribute(cell, "gridSpan") ?? "1", 10);
      const rowSpan = Number.parseInt(attribute(cell, "rowSpan") ?? "1", 10);
      const textBody = childNamed(cell, "txBody");
      cells.push({
        ...(Number.isSafeInteger(span) && span > 1
          ? { columnSpan: Math.max(1, Math.min(63, span)) }
          : {}),
        ...(Number.isSafeInteger(rowSpan) && rowSpan > 1
          ? { rowSpan: Math.max(1, Math.min(255, rowSpan)) }
          : {}),
        ...(solidFillColor(properties, context.theme)
          ? { shading: solidFillColor(properties, context.theme)! }
          : {}),
        ...borderOfCell(properties, context.theme),
        paragraphs: textBody
          ? context.readText(textBody, context.masterStyles.styles.other).paragraphs
          : [],
      });
    }
    if (cells.length > 0) {
      rows.push({ cells });
    }
  }
  return rows.length > 0 ? { kind: "table", columnWidthsPt: widths, rows } : undefined;
}

function cellBorderSide(
  line: XmlElement | undefined,
  theme: PptxTheme,
): NonNullable<NonNullable<SlideShape["table"]>["rows"][number]["cells"][number]["border"]>["top"] {
  if (!line || childNamed(line, "noFill")) {
    return undefined;
  }
  const color = resolveDrawingColor(childNamed(line, "solidFill"), theme);
  if (!color) {
    return undefined;
  }
  const width = pptxPoints(attribute(line, "w")) ?? 0;
  const dash = attribute(childNamed(line, "prstDash"), "val");
  const style: "thin" | "medium" | "thick" | "dashed" | "dotted" =
    dash === "dot" || dash === "sysDot"
      ? "dotted"
      : dash && dash !== "solid"
        ? "dashed"
        : width <= 1.2
          ? "thin"
          : width <= 2.5
            ? "medium"
            : "thick";
  return { style, color };
}

function borderOfCell(
  properties: XmlElement | undefined,
  theme: PptxTheme,
): Pick<NonNullable<SlideShape["table"]>["rows"][number]["cells"][number], "border"> {
  const top = cellBorderSide(childNamed(properties, "lnT"), theme);
  const right = cellBorderSide(childNamed(properties, "lnR"), theme);
  const bottom = cellBorderSide(childNamed(properties, "lnB"), theme);
  const left = cellBorderSide(childNamed(properties, "lnL"), theme);
  if (!top && !right && !bottom && !left) {
    return {};
  }
  return {
    border: {
      ...(top ? { top } : {}),
      ...(right ? { right } : {}),
      ...(bottom ? { bottom } : {}),
      ...(left ? { left } : {}),
    },
  };
}

function addShape(
  element: XmlElement,
  transform: GroupTransform,
  out: SlideShape[],
  context: PptxShapeContext,
): void {
  const placeholder = placeholderOf(element);
  const local =
    ownFrame(element) ??
    placeholderFrame(context.layoutPlaceholders, placeholder) ??
    placeholderFrame(context.masterPlaceholders, placeholder);
  if (!local) {
    // A shape without a transform and without a resolvable placeholder box
    // cannot be placed; the slide reports it instead of stacking it at 0,0.
    context.counter.add("floatingObjects");
    return;
  }
  const frame = transformFrame(local, transform);
  const properties = childNamed(element, "spPr");
  const paint = readShapePaint(properties, childNamed(element, "style"), context.theme);
  if (paint.unsupportedFill) {
    context.counter.add(paint.unsupportedFill);
  }
  const preset = presetOf(properties);
  const text = textOfShape(element, context, placeholder, paint.textStyle);
  const paragraphs = text?.paragraphs ?? [];
  const visibleText = paragraphs.some((paragraph) => paragraph.text.trim().length > 0);
  if (!paint.fill && !paint.lineColor && !visibleText && !preset) {
    // Nothing would paint; a custom geometry we cannot draw still gets a notice.
    if (childNamed(properties, "custGeom")) {
      context.counter.add("drawings");
    }
    return;
  }
  if (out.length >= MAX_SHAPES_PER_SLIDE) {
    context.onTruncated();
    return;
  }
  out.push({
    kind: "shape",
    ...frame,
    ...rotationOf(element),
    ...flipsOf(element),
    ...(preset ? { preset } : {}),
    ...(paint.fill ? { fill: paint.fill } : {}),
    ...(paint.lineColor
      ? {
          lineColor: paint.lineColor,
          ...(paint.lineWidthPt !== undefined ? { lineWidthPt: paint.lineWidthPt } : {}),
          ...(paint.lineStyle ? { lineStyle: paint.lineStyle } : {}),
        }
      : {}),
    ...(text
      ? {
          paragraphs,
          ...(text.verticalAnchor ? { verticalAnchor: text.verticalAnchor } : {}),
          insetTopPt: text.insetTopPt,
          insetRightPt: text.insetRightPt,
          insetBottomPt: text.insetBottomPt,
          insetLeftPt: text.insetLeftPt,
          ...(text.wrapText === false ? { wrapText: false } : {}),
          ...(text.textScalePct !== undefined ? { textScalePct: text.textScalePct } : {}),
        }
      : {}),
  });
}

function addPicture(
  element: XmlElement,
  transform: GroupTransform,
  out: SlideShape[],
  context: PptxShapeContext,
): void {
  const local = ownFrame(element);
  if (!local) {
    context.counter.add("floatingObjects");
    return;
  }
  if (
    elementsOfPicture(element, "videoFile").length > 0 ||
    elementsOfPicture(element, "audioFile").length > 0
  ) {
    // Media plays in an editor; a static preview reports it as omitted.
    context.counter.add("media");
    return;
  }
  const frame = transformFrame(local, transform);
  const blip = childNamed(childNamed(element, "blipFill"), "blip");
  const relationshipId = attribute(blip, "r:embed") ?? attribute(blip, "r:link");
  const image = context.media.read({
    target: relationshipId ? context.relationships.get(relationshipId) : undefined,
    alt: attribute(childNamed(childNamed(element, "nvPicPr"), "cNvPr"), "descr"),
    widthPt: frame.widthPt,
    heightPt: frame.heightPt,
  });
  if (!image) {
    return;
  }
  if (out.length >= MAX_SHAPES_PER_SLIDE) {
    context.onTruncated();
    return;
  }
  out.push({
    kind: "image",
    ...frame,
    ...rotationOf(element),
    ...flipsOf(element),
    media: image.media,
    ...(image.alt ? { alt: image.alt } : {}),
  });
}

function elementsOfPicture(element: XmlElement, name: string): XmlElement[] {
  const matches: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of elementChildren(node)) {
      if (localName(child.nodeName) === name) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(element);
  return matches;
}

function addGraphicFrame(
  element: XmlElement,
  transform: GroupTransform,
  out: SlideShape[],
  context: PptxShapeContext,
): void {
  const graphicData = childNamed(childNamed(element, "graphic"), "graphicData");
  const uri = attribute(graphicData, "uri") ?? "";
  const table = childNamed(graphicData, "tbl");
  if (table) {
    const local = ownFrame(element);
    if (!local) {
      context.counter.add("floatingObjects");
      return;
    }
    const parsed = tableOf(table, context);
    if (!parsed) {
      return;
    }
    if (out.length >= MAX_SHAPES_PER_SLIDE) {
      context.onTruncated();
      return;
    }
    out.push({
      kind: "table",
      ...transformFrame(local, transform),
      ...rotationOf(element),
      ...flipsOf(element),
      table: parsed,
    });
    return;
  }
  if (childNamed(graphicData, "oleObj")) {
    context.counter.add("embeddedObjects");
    return;
  }
  if (uri.endsWith("/chart")) {
    context.counter.add("charts");
    return;
  }
  if (uri.endsWith("/diagram") || childNamed(graphicData, "relIds")) {
    context.counter.add("diagrams");
    return;
  }
  // SmartArt, OLE previews, and other graphics the slide payload cannot draw.
  context.counter.add("drawings");
}

function addGroup(
  element: XmlElement,
  transform: GroupTransform,
  out: SlideShape[],
  context: PptxShapeContext,
  depth: number,
): void {
  const local = ownFrame(element);
  if (!local || depth >= MAX_GROUP_DEPTH) {
    context.counter.add("floatingObjects");
    return;
  }
  const frame = transformFrame(local, transform);
  const xfrm = childNamed(childNamed(element, "grpSpPr"), "xfrm");
  const childOff = childNamed(xfrm, "chOff");
  const childExt = childNamed(xfrm, "chExt");
  const childOffsetX = pptxPoints(attribute(childOff, "x")) ?? 0;
  const childOffsetY = pptxPoints(attribute(childOff, "y")) ?? 0;
  const childWidth = pptxPoints(attribute(childExt, "cx")) ?? frame.widthPt;
  const childHeight = pptxPoints(attribute(childExt, "cy")) ?? frame.heightPt;
  // The child space maps onto the group's slide-space box, so a group nested in
  // a scaled parent inherits that parent's scale.
  const scaleX =
    childWidth > 0 && frame.widthPt > 0 ? frame.widthPt / childWidth : transform.scaleX;
  const scaleY =
    childHeight > 0 && frame.heightPt > 0 ? frame.heightPt / childHeight : transform.scaleY;
  walkContainer(
    element,
    {
      offsetX: frame.xPt - childOffsetX * scaleX,
      offsetY: frame.yPt - childOffsetY * scaleY,
      scaleX,
      scaleY,
    },
    out,
    context,
    depth + 1,
  );
}

function walkContainer(
  container: XmlElement,
  transform: GroupTransform,
  out: SlideShape[],
  context: PptxShapeContext,
  depth: number,
): void {
  for (const child of elementChildren(container)) {
    switch (localName(child.nodeName)) {
      case "sp":
      case "cxnSp":
        addShape(child, transform, out, context);
        break;
      case "pic":
        addPicture(child, transform, out, context);
        break;
      case "graphicFrame":
        addGraphicFrame(child, transform, out, context);
        break;
      case "grpSp":
        addGroup(child, transform, out, context, depth);
        break;
      case "AlternateContent": {
        const branch = childNamed(child, "Choice") ?? childNamed(child, "Fallback");
        if (branch) {
          walkContainer(branch, transform, out, context, depth);
        }
        break;
      }
      case "oleObj":
      case "contentPart":
        context.counter.add("embeddedObjects");
        break;
      default:
        break;
    }
  }
}

/** Reads one slide's `p:spTree` into placed shapes in document order. */
export function readSlideShapes(
  spTree: XmlElement | undefined,
  context: PptxShapeContext,
): SlideShape[] {
  const shapes: SlideShape[] = [];
  if (spTree) {
    walkContainer(spTree, IDENTITY, shapes, context, 0);
  }
  return shapes;
}
