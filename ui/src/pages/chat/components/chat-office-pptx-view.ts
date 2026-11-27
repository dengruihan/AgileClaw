import { html, nothing, type TemplateResult } from "lit";
import { styleMap, type StyleInfo } from "lit/directives/style-map.js";
import type {
  SessionFileOfficeParagraph,
  SessionFileOfficePreview,
  SessionFileOfficeRun,
  SessionFileOfficeTable,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
import {
  officeBorderStyle,
  officeParagraphStyle,
  officePointsToPx,
  officeRunStyle,
} from "./chat-office-layout-style.ts";

type Slide = NonNullable<SessionFileOfficePreview["slides"]>[number];
type SlideShape = NonNullable<Slide["shapes"]>[number];
type SlideTableCell = SessionFileOfficeTable["rows"][number]["cells"][number];

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
/** PowerPoint's default canvas when the payload declares no slide size. */
const DEFAULT_SLIDE_WIDTH_PT = 720;
const DEFAULT_SLIDE_HEIGHT_PT = 540;
/** Unstyled slide text falls back to PowerPoint's 18pt body size. */
const DEFAULT_SLIDE_FONT_PT = 18;

function px(points: number | undefined): string | undefined {
  const value = officePointsToPx(points);
  return value === undefined ? undefined : `${Math.round(value * 10) / 10}px`;
}

/** Declared canvas of every slide in CSS pixels plus the points-to-px factor. */
function slideCanvas(preview: SessionFileOfficePreview): { width: number; height: number } {
  const widthPt = preview.slideSize?.widthPt ?? DEFAULT_SLIDE_WIDTH_PT;
  const heightPt = preview.slideSize?.heightPt ?? DEFAULT_SLIDE_HEIGHT_PT;
  return {
    width: Math.max(1, Math.round(officePointsToPx(widthPt) ?? 0)),
    height: Math.max(1, Math.round(officePointsToPx(heightPt) ?? 0)),
  };
}

/** Widest declared slide canvas in CSS pixels; fit width keys on it. */
export function officePptxCanvasWidth(preview: SessionFileOfficePreview | null): number {
  return preview?.format === "pptx" ? slideCanvas(preview).width : 0;
}

/** Slides render on their fixed canvas only when the payload carries geometry. */
export function hasFixedSlideLayout(preview: SessionFileOfficePreview): boolean {
  return (
    preview.format === "pptx" &&
    preview.slideSize !== undefined &&
    (preview.slides ?? []).some((slide) => (slide.shapes?.length ?? 0) > 0)
  );
}

/**
 * Declared auto-shrink (`a:normAutofit`) scales every run, so it is applied to
 * the resolved point size instead of the whole shape: the box keeps its authored
 * geometry and only the text gets smaller, exactly like PowerPoint does.
 */
function scaledRun(run: SessionFileOfficeRun, scalePct: number | undefined): SessionFileOfficeRun {
  if (scalePct === undefined || scalePct >= 100) {
    return run;
  }
  const base = run.fontSizePt ?? DEFAULT_SLIDE_FONT_PT;
  return { ...run, fontSizePt: Math.max(1, Math.round(base * scalePct) / 100) };
}

function renderParagraph(
  paragraph: SessionFileOfficeParagraph,
  scalePct: number | undefined,
): TemplateResult {
  const runs = paragraph.runs.map((run) => scaledRun(run, scalePct));
  const content =
    runs.length > 0
      ? runs.map(
          (run) =>
            html`<span class="sidebar-office-pptx__run" style=${styleMap(officeRunStyle(run))}
              >${run.text}</span
            >`,
        )
      : paragraph.text;
  const marker = paragraph.listMarker
    ? html`<span class="sidebar-office-pptx__bullet" aria-hidden="true"
        >${paragraph.listMarker}</span
      >`
    : nothing;
  // Inherited whitespace inside `pre-wrap` would render the template's own
  // indentation as blank lines, so the preserved space belongs to the run and
  // text spans that hold authored content only.
  return html`<div
    class="sidebar-office-pptx__paragraph${paragraph.listMarker ? " sidebar-office-pptx__paragraph--list" : ""}"
    data-role=${paragraph.role}
    style=${styleMap(officeParagraphStyle(paragraph))}
  >
    ${marker}<span class="sidebar-office-pptx__paragraph-text">${content}</span>
  </div>`;
}

function renderTable(table: SessionFileOfficeTable): TemplateResult {
  const total = table.columnWidthsPt.reduce((sum, width) => sum + Math.max(0, width), 0);
  return html`<table
    class="sidebar-office-pptx__table"
    style=${styleMap(officeBorderStyle(table.border))}
  >
    ${
      table.columnWidthsPt.length > 0
        ? html`<colgroup>
            ${table.columnWidthsPt.map(
              (width) =>
                html`<col
                  style=${styleMap({
                    width: total > 0 ? `${(Math.max(0, width) / total) * 100}%` : undefined,
                  })}
                />`,
            )}
          </colgroup>`
        : nothing
    }
    <tbody>
      ${table.rows.map(
        (row) =>
          html`<tr>
            ${row.cells.map((cell) => renderTableCell(cell))}
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function renderTableCell(cell: SlideTableCell): TemplateResult {
  return html`<td
    class="sidebar-office-pptx__table-cell"
    colspan=${cell.columnSpan && cell.columnSpan > 1 ? cell.columnSpan : nothing}
    rowspan=${cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : nothing}
    style=${styleMap({
      backgroundColor: cell.shading,
      ...officeBorderStyle(cell.border),
    })}
  >
    ${cell.paragraphs.map((paragraph) => renderParagraph(paragraph, undefined))}
  </td>`;
}

function anchorJustification(anchor: SlideShape["verticalAnchor"]): string {
  switch (anchor) {
    case "middle":
      return "center";
    case "bottom":
      return "flex-end";
    default:
      return "flex-start";
  }
}

/** Shapes keep their authored preset look for the boxes Office renders most. */
function shapeRadius(shape: SlideShape, widthPx: number, heightPx: number): string | undefined {
  if (shape.preset === "ellipse") {
    return "50%";
  }
  if (shape.preset === "roundRect") {
    return `${Math.round(Math.min(widthPx, heightPx) * 0.16)}px`;
  }
  return undefined;
}

function transforms(shape: SlideShape): string | undefined {
  const parts: string[] = [];
  if (shape.rotationDeg) {
    parts.push(`rotate(${shape.rotationDeg}deg)`);
  }
  if (shape.flipHorizontal || shape.flipVertical) {
    parts.push(`scale(${shape.flipHorizontal ? -1 : 1}, ${shape.flipVertical ? -1 : 1})`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function renderImage(shape: SlideShape, preview: SessionFileOfficePreview): TemplateResult {
  const media = shape.media === undefined ? undefined : preview.media?.[shape.media]?.dataUrl;
  if (!media || !SAFE_IMAGE_DATA_URL.test(media)) {
    return html`<div class="sidebar-office-pptx__image-unavailable" role="status">
      ${t("chat.officePreview.imageUnavailable")}
    </div>`;
  }
  return html`<img
    class="sidebar-office-pptx__image"
    src=${media}
    alt=${shape.alt ?? ""}
    draggable="false"
  />`;
}

/** Thin connector shapes render as a rule instead of a stroked rectangle. */
function renderConnector(shape: SlideShape): TemplateResult {
  const width = Math.max(0, officePointsToPx(shape.widthPt) ?? 0);
  const height = Math.max(0, officePointsToPx(shape.heightPt) ?? 0);
  const thickness = Math.max(1, Math.round(officePointsToPx(shape.lineWidthPt ?? 1) ?? 1));
  const vertical = height > width;
  const style: StyleInfo = {
    left: px(shape.xPt),
    top: px(shape.yPt),
    width: vertical ? undefined : px(shape.widthPt),
    height: vertical ? px(shape.heightPt) : undefined,
    borderLeft: vertical
      ? `${thickness}px ${shape.lineStyle ?? "solid"} ${shape.lineColor ?? "currentcolor"}`
      : undefined,
    borderTop: vertical
      ? undefined
      : `${thickness}px ${shape.lineStyle ?? "solid"} ${shape.lineColor ?? "currentcolor"}`,
    transform: transforms(shape),
  };
  return html`<div
    class="sidebar-office-pptx__connector"
    aria-hidden="true"
    style=${styleMap(style)}
  ></div>`;
}

function renderShape(shape: SlideShape, preview: SessionFileOfficePreview): TemplateResult {
  if (shape.kind === "image") {
    return html`<div class="sidebar-office-pptx__shape" style=${styleMap(baseFrameStyle(shape))}>
      ${renderImage(shape, preview)}
    </div>`;
  }
  if (shape.kind === "table") {
    return html`<div class="sidebar-office-pptx__shape" style=${styleMap(baseFrameStyle(shape))}>
      ${shape.table ? renderTable(shape.table) : nothing}
    </div>`;
  }
  if (shape.preset === "line") {
    return renderConnector(shape);
  }
  const widthPx = officePointsToPx(shape.widthPt) ?? 0;
  const heightPx = officePointsToPx(shape.heightPt) ?? 0;
  const paragraphs = shape.paragraphs ?? [];
  return html`<div
    class="sidebar-office-pptx__shape"
    style=${styleMap(shapeFrameStyle(shape, widthPx, heightPx))}
  >
    ${
      paragraphs.length > 0
        ? html`<div
            class="sidebar-office-pptx__text${shape.wrapText === false ? " sidebar-office-pptx__text--nowrap" : ""}"
            style=${styleMap({
              paddingTop: px(shape.insetTopPt),
              paddingRight: px(shape.insetRightPt),
              paddingBottom: px(shape.insetBottomPt),
              paddingLeft: px(shape.insetLeftPt),
              justifyContent: anchorJustification(shape.verticalAnchor),
            })}
          >
            ${paragraphs.map((paragraph) => renderParagraph(paragraph, shape.textScalePct))}
          </div>`
        : nothing
    }
  </div>`;
}

function baseFrameStyle(shape: SlideShape): StyleInfo {
  return {
    left: px(shape.xPt),
    top: px(shape.yPt),
    width: px(shape.widthPt),
    height: px(shape.heightPt),
    transform: transforms(shape),
  };
}

function shapeFrameStyle(shape: SlideShape, widthPx: number, heightPx: number): StyleInfo {
  return {
    ...baseFrameStyle(shape),
    backgroundColor: shape.fill,
    borderRadius: shapeRadius(shape, widthPx, heightPx),
    ...(shape.lineColor
      ? {
          border: `${Math.max(1, Math.round(officePointsToPx(shape.lineWidthPt ?? 1) ?? 1))}px ${
            shape.lineStyle ?? "solid"
          } ${shape.lineColor}`,
        }
      : {}),
  };
}

function renderSlide(
  slide: Slide,
  index: number,
  count: number,
  preview: SessionFileOfficePreview,
  canvas: { width: number; height: number },
): TemplateResult {
  const label = t("chat.officePreview.slideOf", {
    index: String(index + 1),
    count: String(count),
  });
  return html`<div class="sidebar-office-pptx__slide-wrap" data-slide-index=${slide.index}>
    <div class="sidebar-office-pptx__slide-label">${label}</div>
    <div
      class="sidebar-office-pptx__slide-scaler"
      style=${styleMap({
        "--office-slide-width": `${canvas.width}px`,
        "--office-slide-height": `${canvas.height}px`,
      })}
    >
      <article
        class="sidebar-office-pptx__slide"
        role="group"
        aria-label=${label}
        style=${styleMap({ backgroundColor: slide.background })}
      >
        ${(slide.shapes ?? []).map((shape) => renderShape(shape, preview))}
      </article>
    </div>
  </div>`;
}

/**
 * Fixed slide canvases: every slide is laid out once at its declared size and
 * only scaled by the reader, so panel width changes zoom the deck instead of
 * moving or rewrapping its shapes.
 */
export function renderPresentationSlides(preview: SessionFileOfficePreview): TemplateResult {
  const canvas = slideCanvas(preview);
  const slides = preview.slides ?? [];
  return html`${slides.map((slide, index) =>
    renderSlide(slide, index, slides.length, preview, canvas),
  )}`;
}
