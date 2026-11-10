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
import { renderDocumentPages } from "./chat-office-docx-view.ts";
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

  override willUpdate(changed: PropertyValues<this>): void {
    const sheetCount = (this.preview?.sheets ?? []).filter((entry) => entry.hidden !== true).length;
    if (changed.has("preview") && this.selectedSheet >= sheetCount) {
      this.selectedSheet = 0;
    }
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
                ${renderDocumentPages(preview)}`
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
