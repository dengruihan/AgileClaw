import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type {
  SessionFileOfficeDocBlock,
  SessionFileOfficeParagraph,
  SessionFileOfficePreview,
  SessionFileOfficeTable,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
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

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

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

function renderTable(table: SessionFileOfficeTable): TemplateResult {
  const widths = table.columnWidthsPt;
  const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
  return html`<table
    class="sidebar-office-docx__table"
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
      ${table.rows.map(
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
  return html`<figure class="sidebar-office-docx__figure">
    <img
      class="sidebar-office-docx__image"
      src=${media}
      alt=${image.alt ?? ""}
      style=${styleMap({
        width: width && width > 0 ? `${Math.min(2_000, Math.round(width))}px` : undefined,
        maxWidth: "100%",
        height: "auto",
      })}
    />
  </figure>`;
}

function renderBlock(
  block: SessionFileOfficeDocBlock,
  preview: SessionFileOfficePreview,
): TemplateResult {
  switch (block.kind) {
    case "table":
      return renderTable(block);
    case "image":
      return renderImage(block, preview);
    default:
      return renderParagraph(block);
  }
}

function pageStyle(page: DocxPage) {
  const width = page.widthPt > 0 ? page.widthPt : 595.3;
  const percent = (points: number) => `${Math.max(0, (points / width) * 100).toFixed(3)}%`;
  return {
    "--office-doc-page-width": `${Math.round(officePointsToPx(width) ?? 794)}px`,
    "--office-doc-page-ratio": `${Math.max(1, page.heightPt) / width}`,
    paddingTop: percent(page.marginTopPt),
    paddingRight: percent(page.marginRightPt),
    paddingBottom: percent(page.marginBottomPt),
    paddingLeft: percent(page.marginLeftPt),
  };
}

/** Approximate Word pages: fitted paper cards with the resolved page margins. */
export function renderDocumentPages(preview: SessionFileOfficePreview): TemplateResult {
  const pages = preview.pages ?? [];
  const header = preview.header ?? [];
  const footer = preview.footer ?? [];
  return html`<div class="sidebar-office-docx">
    ${pages.map(
      (page, index) => html`<div
        class="sidebar-office-docx__page-wrap"
        data-page-index=${index + 1}
      >
        <div class="sidebar-office-docx__page-label">
          ${t("chat.officePreview.pageOf", {
            index: String(index + 1),
            count: String(pages.length),
          })}
        </div>
        <article
          class="sidebar-office-docx__page"
          role="group"
          aria-label=${t("chat.officePreview.pageOf", {
            index: String(index + 1),
            count: String(pages.length),
          })}
          style=${styleMap(pageStyle(page))}
        >
          ${
            header.length > 0
              ? html`<header
                  class="sidebar-office-docx__page-header"
                  aria-label=${t("chat.officePreview.header")}
                >
                  ${header.map((paragraph) =>
                    renderParagraph(paragraph, "sidebar-office-docx__paragraph--header"),
                  )}
                </header>`
              : nothing
          }
          <div class="sidebar-office-docx__page-body">
            ${page.blocks.map((block) => renderBlock(block, preview))}
          </div>
          ${
            footer.length > 0
              ? html`<footer
                  class="sidebar-office-docx__page-footer"
                  aria-label=${t("chat.officePreview.footer")}
                >
                  ${footer.map((paragraph) =>
                    renderParagraph(paragraph, "sidebar-office-docx__paragraph--footer"),
                  )}
                </footer>`
              : nothing
          }
        </article>
      </div>`,
    )}
  </div>`;
}
