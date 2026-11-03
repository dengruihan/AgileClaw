import { html, nothing, type TemplateResult } from "lit";
import type { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
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

/**
 * Loads the Office viewer only once a preview is opened and keeps the loading
 * and retry states owned by the request controller.
 */
export function renderOfficePreview(
  loader: LazyCustomElementRequestController,
  content: OfficeSidebarContent | null,
): TemplateResult | typeof nothing {
  if (!content) {
    return nothing;
  }
  loader.requestWhileActive(officePreviewElement, true);
  const state = loader.visibleState;
  return html`
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
