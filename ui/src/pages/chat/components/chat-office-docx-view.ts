import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type {
  SessionFileOfficeDocBlock,
  SessionFileOfficeParagraph,
  SessionFileOfficePreview,
  SessionFileOfficeTable,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
import type { OfficeDocxPageLayout } from "./chat-office-docx-pagination.ts";
import {
  officeBorderStyle,
  officeColor,
  officeParagraphStyle,
  officePointsToPx,
  officeRunStyle,
} from "./chat-office-layout-style.ts";

type DocxPage = NonNullable<SessionFileOfficePreview["pages"]>[number];
type DocxImage = Extract<SessionFileOfficeDocBlock, { kind: "image" }>;
type DocxTableCell = SessionFileOfficeTable["rows"][number]["cells"][number];
type DocxTableRows = readonly [number, number];

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
/** A4 fallback when a document carries no page geometry. */
const DEFAULT_PAGE_WIDTH_PT = 595.3;
const DEFAULT_PAGE_HEIGHT_PT = 841.9;

function paragraphClass(paragraph: SessionFileOfficeParagraph): string {
  const classes = ["sidebar-office-docx__paragraph"];
  classes.push(`sidebar-office-docx__paragraph--${paragraph.role}`);
  if (paragraph.listMarker) {
    classes.push("sidebar-office-docx__paragraph--list");
  }
  return classes.join(" ");
}

function paragraphHeadingLevel(paragraph: SessionFileOfficeParagraph): number | typeof nothing {
  if (paragraph.role === "title") {
    return 1;
  }
  if (paragraph.role === "heading") {
    return Math.min(6, Math.max(1, paragraph.level ?? 1));
  }
  return nothing;
}

function renderParagraph(
  paragraph: SessionFileOfficeParagraph,
  extraClass?: string,
): TemplateResult {
  const classes = [paragraphClass(paragraph), extraClass].filter(Boolean).join(" ");
  const runs =
    paragraph.runs.length > 0
      ? paragraph.runs.map(
          (run) =>
            html`<span class="sidebar-office-docx__run" style=${styleMap(officeRunStyle(run))}
              >${run.text}</span
            >`,
        )
      : paragraph.text;
  return html`<div
    class=${classes}
    data-role=${paragraph.role}
    data-level=${paragraph.level ?? nothing}
    style=${styleMap(officeParagraphStyle(paragraph))}
    role=${paragraphHeadingLevel(paragraph) === nothing ? nothing : "heading"}
    aria-level=${paragraphHeadingLevel(paragraph)}
  >
    ${
      paragraph.listMarker
        ? html`<span class="sidebar-office-docx__list-marker" aria-hidden="true"
            >${paragraph.listMarker}</span
          >`
        : nothing
    }
    <span class="sidebar-office-docx__text">${runs}</span>
  </div>`;
}

function tableCellStyle(cell: DocxTableCell) {
  return {
    backgroundColor: cell.shading ? officeColor(cell.shading, "transparent") : undefined,
    ...officeBorderStyle(cell.border),
  };
}

function renderTableCell(cell: DocxTableCell): TemplateResult {
  return html`<td
    class="sidebar-office-docx__table-cell"
    colspan=${cell.columnSpan && cell.columnSpan > 1 ? cell.columnSpan : nothing}
    rowspan=${cell.rowSpan && cell.rowSpan > 1 ? cell.rowSpan : nothing}
    style=${styleMap(tableCellStyle(cell))}
  >
    ${
      cell.paragraphs.length > 0
        ? cell.paragraphs.map((paragraph) => renderParagraph(paragraph))
        : html`<div class="sidebar-office-docx__paragraph" aria-hidden="true"></div>`
    }
  </td>`;
}

function renderTable(table: SessionFileOfficeTable, rows?: DocxTableRows): TemplateResult {
  const widths = table.columnWidthsPt;
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  const visible = rows ? table.rows.slice(rows[0], rows[1]) : table.rows;
  return html`<table
    class="sidebar-office-docx__table"
    data-row-start=${rows ? rows[0] : nothing}
    style=${styleMap(officeBorderStyle(table.border))}
  >
    ${
      widths.length > 0
        ? html`<colgroup>
            ${widths.map(
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
      ${visible.map(
        (row) =>
          html`<tr>
            ${row.cells.map((cell) => renderTableCell(cell))}
          </tr>`,
      )}
    </tbody>
  </table>`;
}

function renderImage(image: DocxImage, preview: SessionFileOfficePreview): TemplateResult {
  const media = preview.media?.[image.media]?.dataUrl;
  if (!media || !SAFE_IMAGE_DATA_URL.test(media)) {
    return html`<div class="sidebar-office-docx__image-unavailable" role="status">
      ${t("chat.officePreview.imageUnavailable")}
    </div>`;
  }
  const width = officePointsToPx(image.widthPt);
  const ratio =
    image.widthPt > 0 && image.heightPt > 0 ? `${image.widthPt} / ${image.heightPt}` : undefined;
  return html`<figure class="sidebar-office-docx__figure">
    <img
      class="sidebar-office-docx__image"
      src=${media}
      alt=${image.alt ?? ""}
      style=${styleMap({
        width: width && width > 0 ? `${Math.min(2_000, Math.round(width))}px` : undefined,
        maxWidth: "100%",
        // Reserve the declared box before the bytes decode, so the measuring
        // stage and the final page agree on the block height.
        aspectRatio: ratio,
        height: "auto",
      })}
    />
  </figure>`;
}

function renderBlock(
  block: SessionFileOfficeDocBlock,
  preview: SessionFileOfficePreview,
  rows?: DocxTableRows,
): TemplateResult {
  switch (block.kind) {
    case "table":
      return renderTable(block, rows);
    case "image":
      return renderImage(block, preview);
    default:
      return renderParagraph(block);
  }
}

/** Declared canvas size of one page in CSS pixels. */
function pageCanvas(page: DocxPage): { width: number; height: number; widthPt: number } {
  const widthPt = page.widthPt > 0 ? page.widthPt : DEFAULT_PAGE_WIDTH_PT;
  const heightPt = page.heightPt > 0 ? page.heightPt : DEFAULT_PAGE_HEIGHT_PT;
  return {
    widthPt,
    width: Math.round(officePointsToPx(widthPt) ?? (DEFAULT_PAGE_WIDTH_PT * 4) / 3),
    height: Math.round(officePointsToPx(heightPt) ?? (DEFAULT_PAGE_HEIGHT_PT * 4) / 3),
  };
}

/**
 * Declared canvas size of one fixed page. The element that reserves the page's
 * on-screen box declares these, so a scaled Letter or landscape page reserves
 * its own size instead of the A4 fallback; the page box inherits them.
 */
function pageCanvasStyle(page: DocxPage, canvasHeight: number) {
  const { width, height } = pageCanvas(page);
  return {
    "--office-doc-page-width": `${width}px`,
    "--office-doc-page-height": `${Math.max(height, canvasHeight)}px`,
  };
}

/**
 * Resolved page margins in pixels. A percentage padding resolves against the
 * containing block, which would let a zoomed page shrink its own text column
 * and rewrap the document.
 */
function pageMarginStyle(page: DocxPage) {
  const { widthPt, width } = pageCanvas(page);
  const margin = (points: number) =>
    `${Math.max(0, Math.round((width * Math.max(0, points)) / widthPt))}px`;
  return {
    paddingTop: margin(page.marginTopPt),
    paddingRight: margin(page.marginRightPt),
    paddingBottom: margin(page.marginBottomPt),
    paddingLeft: margin(page.marginLeftPt),
  };
}

/** Widest declared page width in CSS pixels; fit width keys on it. */
export function officeDocxCanvasWidth(
  pages: NonNullable<SessionFileOfficePreview["pages"]>,
): number {
  return pages.reduce((widest, page) => Math.max(widest, pageCanvas(page).width), 0);
}

/** Declared pagination, used until the fixed canvas has been measured. */
export function fallbackOfficeDocxLayout(
  preview: SessionFileOfficePreview,
): OfficeDocxPageLayout[] {
  const pages = preview.pages ?? [];
  return pages.map((page, source) => ({
    source,
    height: pageCanvas(page).height,
    slices: page.blocks.map((_, index) => ({ block: index, rows: null, height: 0 })),
  }));
}

function renderPageHeader(preview: SessionFileOfficePreview): TemplateResult | typeof nothing {
  const header = preview.header ?? [];
  return header.length > 0
    ? html`<header
        class="sidebar-office-docx__page-header"
        aria-label=${t("chat.officePreview.header")}
      >
        ${header.map((paragraph) =>
          renderParagraph(paragraph, "sidebar-office-docx__paragraph--header"),
        )}
      </header>`
    : nothing;
}

function renderPageFooter(preview: SessionFileOfficePreview): TemplateResult | typeof nothing {
  const footer = preview.footer ?? [];
  return footer.length > 0
    ? html`<footer
        class="sidebar-office-docx__page-footer"
        aria-label=${t("chat.officePreview.footer")}
      >
        ${footer.map((paragraph) =>
          renderParagraph(paragraph, "sidebar-office-docx__paragraph--footer"),
        )}
      </footer>`
    : nothing;
}

/**
 * Fixed-canvas Word pages: every card is laid out at the document's own page
 * size and only scaled by the reader, so panel width never rewraps its text.
 * The measuring stage below renders the same blocks once at that size; the
 * pagination owner turns its measurements into continuation cards.
 */
export function renderDocumentPages(
  preview: SessionFileOfficePreview,
  layout: readonly OfficeDocxPageLayout[],
): TemplateResult {
  const pages = preview.pages ?? [];
  return html`${layout.map((card, index) => {
    const page = pages[card.source];
    if (!page) {
      return nothing;
    }
    const label = t("chat.officePreview.pageOf", {
      index: String(index + 1),
      count: String(layout.length),
    });
    const first = card.slices[0];
    const continued = first !== undefined && (first.block > 0 || (first.rows?.[0] ?? 0) > 0);
    return html`<div
      class="sidebar-office-docx__page-wrap"
      data-page-index=${index + 1}
      data-page-source=${card.source + 1}
    >
      <div class="sidebar-office-docx__page-label">${label}</div>
      <div
        class="sidebar-office-docx__page-scaler"
        style=${styleMap(pageCanvasStyle(page, card.height))}
      >
        <article
          class="sidebar-office-docx__page"
          role="group"
          aria-label=${label}
          data-page-continued=${continued ? "true" : nothing}
          style=${styleMap(pageMarginStyle(page))}
        >
          ${renderPageHeader(preview)}
          <div class="sidebar-office-docx__page-body">
            ${card.slices.map((slice) =>
              renderBlock(page.blocks[slice.block]!, preview, slice.rows ?? undefined),
            )}
          </div>
          ${renderPageFooter(preview)}
        </article>
      </div>
    </div>`;
  })}`;
}

/**
 * Hidden measuring stage: the declared pages, unpaginated, at their real
 * canvas size. It exists only until the pagination owner and the fonts settle.
 */
export function renderDocumentMeasure(preview: SessionFileOfficePreview): TemplateResult {
  const pages = preview.pages ?? [];
  return html`<div class="sidebar-office-docx__measure" aria-hidden="true">
    ${pages.map(
      (page) => html`<article
        class="sidebar-office-docx__measure-page"
        data-office-docx-measure
        style=${styleMap({
          ...pageCanvasStyle(page, pageCanvas(page).height),
          ...pageMarginStyle(page),
        })}
      >
        ${renderPageHeader(preview)}
        <div class="sidebar-office-docx__page-body">
          ${page.blocks.map((block) => renderBlock(block, preview))}
        </div>
        ${renderPageFooter(preview)}
      </article>`,
    )}
  </div>`;
}
