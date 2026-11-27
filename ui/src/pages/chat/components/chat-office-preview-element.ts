import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionFileOfficeBlock,
  SessionFileOfficeOmitted,
  SessionFileOfficePreview,
  SessionFileOfficeSlide,
} from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  measureOfficeDocxPages,
  type OfficeDocxPageLayout,
} from "./chat-office-docx-pagination.ts";
import {
  fallbackOfficeDocxLayout,
  renderDocumentMeasure,
  renderDocumentPages,
} from "./chat-office-docx-view.ts";
import { OfficeFixedCanvasController } from "./chat-office-fixed-canvas.ts";
import { OfficeSheetGeometryController } from "./chat-office-sheet-geometry.ts";
import { renderWorkbook } from "./chat-office-sheet-view.ts";

registerFilePreviewEnglish();

function renderNotice(preview: SessionFileOfficePreview): TemplateResult | typeof nothing {
  return preview.truncated
    ? html`<div class="sidebar-office-preview__notice" role="status">
        ${t("chat.officePreview.truncated")}
      </div>`
    : nothing;
}

function omittedLabel(entry: SessionFileOfficeOmitted): string {
  return t(`chat.officePreview.omittedFeature.${entry.feature}`);
}

function renderOmitted(preview: SessionFileOfficePreview): TemplateResult | typeof nothing {
  const counted = (preview.omitted ?? []).filter(
    (entry) => entry.count > 0 && entry.feature !== "exactPagination",
  );
  if (counted.length === 0) {
    return nothing;
  }
  const features = counted
    .map((entry) => `${omittedLabel(entry)} (${entry.count.toLocaleString()})`)
    .join(", ");
  return html`<div class="sidebar-office-preview__omitted" role="status">
    ${t("chat.officePreview.omittedFeatures", { features })}
  </div>`;
}

function renderEmpty(): TemplateResult {
  return html`<div class="sidebar-office-preview__empty">${t("chat.officePreview.empty")}</div>`;
}

/** Groups consecutive list items so the document outline keeps its semantics. */
function renderDocumentBlocks(blocks: readonly SessionFileOfficeBlock[]): TemplateResult[] {
  const rendered: TemplateResult[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length > 0) {
      rendered.push(
        html`<ul class="sidebar-office-preview__list">
          ${listItems.map((text) => html`<li>${text}</li>`)}
        </ul>`,
      );
      listItems = [];
    }
  };
  for (const block of blocks) {
    if (block.kind === "listItem") {
      listItems.push(block.text);
      continue;
    }
    flushList();
    if (block.kind === "heading") {
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      rendered.push(html`<div
        class="sidebar-office-preview__heading"
        role="heading"
        aria-level=${level}
        data-level=${level}
      >
        ${block.text}
      </div>`);
    } else {
      rendered.push(html`<p class="sidebar-office-preview__paragraph">${block.text}</p>`);
    }
  }
  flushList();
  return rendered;
}

function renderSlide(slide: SessionFileOfficeSlide): TemplateResult {
  return html`
    <li class="sidebar-office-preview__slide" data-slide-index=${slide.index}>
      <h5 class="sidebar-office-preview__slide-title">
        ${slide.title ?? t("chat.officePreview.slideLabel", { index: String(slide.index) })}
      </h5>
      ${
        slide.lines.length > 0
          ? html`<ul class="sidebar-office-preview__list">
              ${slide.lines.map((line) => html`<li>${line}</li>`)}
            </ul>`
          : nothing
      }
    </li>
  `;
}

/** Read-only renderer for the structured Office payload the Gateway returns. */
class ChatOfficePreview extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) preview: SessionFileOfficePreview | null = null;
  @property() label = "";

  @state() private selectedSheet = 0;
  @state() private docxLayout: OfficeDocxPageLayout[] | null = null;
  /** Keeps the measuring stage mounted until web fonts finished loading. */
  @state() private docxFontsSettled = false;
  private readonly sheetGeometry = new OfficeSheetGeometryController(this);
  private readonly canvas = new OfficeFixedCanvasController(() => this.requestUpdate());
  private docxLayoutSignature = "";
  /** Guards the measuring cycle so a stale settle cannot unmount a newer stage. */
  private docxMeasureToken = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.sheetGeometry.sync();
    void this.settleDocumentFonts();
  }

  override disconnectedCallback(): void {
    this.sheetGeometry.disconnect();
    this.canvas.disconnect();
    super.disconnectedCallback();
  }

  override updated(): void {
    this.sheetGeometry.sync();
    this.syncDocumentCanvas();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const sheetCount = (this.preview?.sheets ?? []).filter((entry) => entry.hidden !== true).length;
    if (changed.has("preview") && this.selectedSheet >= sheetCount) {
      this.selectedSheet = 0;
    }
    if (changed.has("preview")) {
      // A new payload owns new page geometry; remeasure it on this element.
      this.docxLayout = null;
      this.docxLayoutSignature = "";
      this.docxFontsSettled = false;
      void this.settleDocumentFonts();
    }
  }

  /**
   * Owns the measuring stage for the current preview: web fonts can change the
   * measured block heights, so the final measurement runs after they settle and
   * only then does the stage unmount. Assigning a new preview restarts it.
   */
  private async settleDocumentFonts(): Promise<void> {
    const token = ++this.docxMeasureToken;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (fonts) {
      await fonts.ready;
    }
    // The stage is only measurable once the current preview has rendered.
    await this.updateComplete;
    if (token !== this.docxMeasureToken || !this.isConnected) {
      return;
    }
    this.measureDocumentLayout();
    this.docxFontsSettled = true;
  }

  private documentPages() {
    return this.preview?.format === "docx" ? (this.preview.pages ?? []) : [];
  }

  /**
   * Fit width serves the widest page: one scale drives every card, so keying it
   * on the first page would leave a landscape page wider than the reader.
   */
  private documentCanvasWidth(): number {
    return this.documentPages().reduce((widest, page) => {
      const widthPt = page.widthPt > 0 ? page.widthPt : 595.3;
      return Math.max(widest, Math.round((widthPt * 4) / 3));
    }, 0);
  }

  /** Rebind the fixed canvas and turn the latest measurement into page cards. */
  private syncDocumentCanvas(): void {
    const scroll = this.querySelector<HTMLElement>(".sidebar-office-docx__scroll");
    this.canvas.sync(scroll, this.documentCanvasWidth());
    this.measureDocumentLayout();
  }

  /** Read the hidden measuring stage; a no-op while none is mounted. */
  private measureDocumentLayout(): void {
    const measure = this.querySelector<HTMLElement>(".sidebar-office-docx__measure");
    if (!measure) {
      return;
    }
    const layout = measureOfficeDocxPages(measure);
    if (!layout) {
      return;
    }
    const signature = JSON.stringify(layout);
    if (signature === this.docxLayoutSignature) {
      return;
    }
    this.docxLayoutSignature = signature;
    this.docxLayout = layout;
  }

  private zoom(action: "in" | "out" | "fit" | "actual"): void {
    switch (action) {
      case "in":
        this.canvas.zoomIn();
        break;
      case "out":
        this.canvas.zoomOut();
        break;
      case "fit":
        this.canvas.fitToWidth();
        break;
      default:
        this.canvas.actualSize();
        break;
    }
  }

  private renderZoomTools(): TemplateResult {
    const canvas = this.canvas;
    return html`<div
      class="sidebar-office-docx__tools"
      role="toolbar"
      aria-label=${t("chat.officePreview.zoom")}
    >
      <button
        type="button"
        class="sidebar-office-docx__zoom"
        data-office-zoom="out"
        aria-label=${t("chat.officePreview.zoomOut")}
        title=${t("chat.officePreview.zoomOut")}
        ?disabled=${!canvas.canZoomOut}
        @click=${() => this.zoom("out")}
      >
        −
      </button>
      <span class="sidebar-office-docx__zoom-level" data-office-zoom-level
        >${t("chat.officePreview.zoomLevel", { percent: String(canvas.percent) })}</span
      >
      <button
        type="button"
        class="sidebar-office-docx__zoom"
        data-office-zoom="in"
        aria-label=${t("chat.officePreview.zoomIn")}
        title=${t("chat.officePreview.zoomIn")}
        ?disabled=${!canvas.canZoomIn}
        @click=${() => this.zoom("in")}
      >
        +
      </button>
      <button
        type="button"
        class="sidebar-office-docx__zoom sidebar-office-docx__zoom--mode"
        data-office-zoom="fit"
        aria-pressed=${canvas.fitWidth ? "true" : "false"}
        @click=${() => this.zoom("fit")}
      >
        ${t("chat.officePreview.zoomFitWidth")}
      </button>
      <button
        type="button"
        class="sidebar-office-docx__zoom sidebar-office-docx__zoom--mode"
        data-office-zoom="actual"
        aria-pressed=${!canvas.fitWidth && canvas.percent === 100 ? "true" : "false"}
        @click=${() => this.zoom("actual")}
      >
        ${t("chat.officePreview.zoomActual")}
      </button>
    </div>`;
  }

  private renderWorkbookView(preview: SessionFileOfficePreview): TemplateResult {
    const selectSheet = (index: number) => {
      this.selectedSheet = index;
    };
    return html`
      <div class="sidebar-office-preview" data-office-format="xlsx" aria-label=${this.label}>
        ${renderNotice(preview)} ${renderOmitted(preview)}
        ${renderWorkbook(preview, this.selectedSheet, selectSheet)}
      </div>
    `;
  }

  private renderDocumentCanvas(preview: SessionFileOfficePreview): TemplateResult {
    return html`
      <div class="sidebar-office-docx">
        ${this.renderZoomTools()}
        <div class="sidebar-office-docx__scroll">
          ${renderDocumentPages(preview, this.docxLayout ?? fallbackOfficeDocxLayout(preview))}
          ${this.docxFontsSettled ? nothing : renderDocumentMeasure(preview)}
        </div>
      </div>
    `;
  }

  private renderDocument(preview: SessionFileOfficePreview): TemplateResult {
    const pages = preview.pages ?? [];
    const blocks = preview.blocks ?? [];
    return html`
      <div class="sidebar-office-preview" data-office-format="docx" aria-label=${this.label}>
        ${renderNotice(preview)} ${renderOmitted(preview)}
        ${
          pages.length > 0
            ? html`<div class="sidebar-office-preview__approximation" role="note">
                  ${t("chat.officePreview.approximatePages")}
                </div>
                ${this.renderDocumentCanvas(preview)}`
            : blocks.length === 0
              ? renderEmpty()
              : html`<article class="sidebar-office-preview__document">
                  ${renderDocumentBlocks(blocks)}
                </article>`
        }
      </div>
    `;
  }

  private renderPresentation(preview: SessionFileOfficePreview): TemplateResult {
    const slides = preview.slides ?? [];
    return html`
      <div class="sidebar-office-preview" data-office-format="pptx" aria-label=${this.label}>
        ${renderNotice(preview)} ${renderOmitted(preview)}
        ${
          slides.length === 0
            ? renderEmpty()
            : html`<ol class="sidebar-office-preview__slides">
                ${slides.map((slide) => renderSlide(slide))}
              </ol>`
        }
      </div>
    `;
  }

  override render() {
    const preview = this.preview;
    if (!preview) {
      return nothing;
    }
    if (preview.format === "xlsx") {
      return this.renderWorkbookView(preview);
    }
    if (preview.format === "docx") {
      return this.renderDocument(preview);
    }
    return this.renderPresentation(preview);
  }
}

if (!customElements.get("openclaw-chat-office-preview")) {
  customElements.define("openclaw-chat-office-preview", ChatOfficePreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-office-preview": ChatOfficePreview;
  }
}
