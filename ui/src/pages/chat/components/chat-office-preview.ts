import { html, nothing, type TemplateResult } from "lit";
import type { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { icons } from "../../../components/icons.ts";
import { renderLazyViewError } from "../../../components/lazy-view-error.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { OfficeSidebarContent } from "./chat-sidebar-content-types.ts";

registerFilePreviewEnglish();

export const officePreviewElement = {
  tagName: "openclaw-chat-office-preview",
  get label() {
    return t("chat.officePreview.title");
  },
  loadModule: () => import("./chat-office-preview-element.ts"),
};

/** Explicit, user-triggered download shown beside the read-only viewer. */
export type OfficePreviewDownload = {
  label: string;
  title?: string;
  pending?: boolean;
  error?: string | null;
  onDownload?: () => void;
};

/** Explicit download controls for one artifact-backed Office preview. */
export function officePreviewDownload(
  content: OfficeSidebarContent,
  blobDownload: { pending: boolean; error: string | null; onDownload: () => void },
): OfficePreviewDownload | undefined {
  const label = t("chat.officePreview.download");
  const title = t("chat.mediaPlayer.download", { filename: content.title });
  if (content.downloadNow) {
    // The panel controller scopes the direct ticket re-mint to its lifecycle.
    return {
      label,
      title,
      pending: false,
      onDownload: blobDownload.onDownload,
    };
  }
  if (content.download) {
    return {
      label,
      title,
      pending: blobDownload.pending,
      error: blobDownload.error,
      onDownload: blobDownload.onDownload,
    };
  }
  return undefined;
}

/**
 * Loads the Office viewer only once a preview is opened and keeps the loading
 * and retry states owned by the request controller.
 */
export function renderOfficePreview(
  loader: LazyCustomElementRequestController,
  content: OfficeSidebarContent | null,
  downloadControls?: { pending: boolean; error: string | null; onDownload: () => void },
): TemplateResult | typeof nothing {
  if (!content) {
    return nothing;
  }
  loader.requestWhileActive(officePreviewElement, true);
  const state = loader.visibleState;
  const download = downloadControls ? officePreviewDownload(content, downloadControls) : undefined;
  return html`
    ${
      download?.onDownload
        ? html`<div class="sidebar-office-preview__toolbar">
            <button
              class="btn btn--sm sidebar-office-preview__download"
              type="button"
              aria-label=${download.title ?? download.label}
              title=${download.title ?? download.label}
              ?disabled=${download.pending === true}
              @click=${download.onDownload}
            >
              ${icons.download}<span>${download.label}</span>
            </button>
            ${download.error ? html`<div role="alert">${download.error}</div>` : nothing}
          </div>`
        : nothing
    }
    ${
      state?.status === "error"
        ? renderLazyViewError({
            error: state.error,
            stale: state.stale,
            onRetry: () => loader.retry(),
          })
        : state
          ? html`<div role="status">${t("common.loading")}</div>`
          : nothing
    }
    <openclaw-chat-office-preview
      .preview=${content.preview}
      .label=${content.title}
    ></openclaw-chat-office-preview>
  `;
}
