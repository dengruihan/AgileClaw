import { html, nothing, type TemplateResult } from "lit";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { OfficeSidebarContent } from "./chat-sidebar-content-types.ts";
import "./chat-pdf-preview.ts";

registerFilePreviewEnglish();

/**
 * Renders the converted PDF in the existing browser reader. The bytes arrive in
 * the Gateway payload, so the viewer needs no ticket and the explicit download
 * always targets the original Office file.
 */
export function renderOfficePreview(
  content: OfficeSidebarContent | null,
  downloadControls?: { pending: boolean; error: string | null; onDownload: () => void },
): TemplateResult | typeof nothing {
  if (!content) {
    return nothing;
  }
  const download = downloadControls
    ? content.downloadNow
      ? { pending: false, error: null, onDownload: downloadControls.onDownload }
      : content.download
        ? downloadControls
        : undefined
    : undefined;
  return html`
    <openclaw-chat-pdf-preview
      .pdfData=${content.pdf.data}
      .label=${content.title}
      .mimeType=${content.pdf.mimeType}
      .sizeBytes=${content.pdf.sizeBytes}
      .onDownload=${download?.onDownload}
      .downloadPending=${download?.pending ?? false}
      .downloadError=${download?.error ?? ""}
    ></openclaw-chat-pdf-preview>
  `;
}
