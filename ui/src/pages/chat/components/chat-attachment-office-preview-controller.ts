import { html, nothing, type TemplateResult } from "lit";
import type { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { t } from "../../../i18n/index.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
import { officePreviewPayload } from "./chat-office-attachment.ts";
import { renderOfficePreview } from "./chat-office-preview.ts";
import type {
  AttachmentSidebarContent,
  ChatDetailPanelContent,
  OfficeSidebarContent,
} from "./chat-sidebar-content-types.ts";

type OfficePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: OfficeSidebarContent }
  | { status: "unavailable"; reason: string };

type OfficePreviewHost = {
  readonly isConnected: boolean;
  requestUpdate(): void;
};

type DownloadControls = {
  readonly pending: boolean;
  readonly error: string | null;
  onDownload: () => void;
};

function unavailableReason(state: string | undefined): string {
  switch (state) {
    case "too-large":
      return t("chat.officePreview.tooLarge");
    case "invalid":
      return t("chat.officePreview.invalid");
    default:
      return t("chat.officePreview.unsupported");
  }
}

/**
 * Loads the structured Office payload only while one attachment is open, and
 * keeps the explicit download action outside the viewer. Cancels on close or
 * selection change so a late parse cannot replace newer content.
 */
export class AttachmentOfficePreviewController {
  private state: OfficePreviewState = { status: "idle" };
  private request: AbortController | null = null;
  private owner: AttachmentSidebarContent | null = null;

  constructor(
    private readonly host: OfficePreviewHost,
    private readonly content: () => ChatDetailPanelContent | null,
    private readonly loader: LazyCustomElementRequestController,
    private readonly blobDownload: DownloadControls,
  ) {}

  cancel(): void {
    this.request?.abort();
    this.request = null;
    this.owner = null;
    if (this.state.status !== "idle") {
      this.state = { status: "idle" };
    }
  }

  sync(): void {
    const content = this.content();
    if (content?.kind !== "attachment" || !content.office) {
      if (this.state.status !== "idle" || this.owner) {
        this.cancel();
      }
      return;
    }
    if (this.owner === content && this.state.status !== "idle") {
      return;
    }
    this.start(content);
  }

  private start(content: AttachmentSidebarContent): void {
    const office = content.office;
    if (!office) {
      return;
    }
    this.cancel();
    this.owner = content;
    const request = new AbortController();
    this.request = request;
    this.state = { status: "loading" };
    void office
      .load(request.signal)
      .then((preview) => {
        if (this.request !== request || request.signal.aborted) {
          return;
        }
        this.request = null;
        const payload = officePreviewPayload(preview);
        this.state = payload
          ? {
              status: "ready",
              content: {
                kind: "office",
                title: content.title,
                format: payload.format,
                preview: payload.preview,
                ...(content.download ? { download: content.download } : {}),
                ...(content.downloadNow ? { downloadNow: content.downloadNow } : {}),
              },
            }
          : {
              status: "unavailable",
              reason: unavailableReason(preview?.kind === "office" ? preview.state : undefined),
            };
        this.host.requestUpdate();
      })
      .catch(() => {
        if (this.request !== request || request.signal.aborted) {
          return;
        }
        this.request = null;
        this.state = { status: "unavailable", reason: t("chat.officePreview.invalid") };
        this.host.requestUpdate();
      });
  }

  private renderUnavailable(content: AttachmentSidebarContent, reason: string): TemplateResult {
    const direct = content.downloadNow;
    const blob = content.download;
    return html`
      <div class="sidebar-office-preview__state" role="alert">${reason}</div>
      ${renderCompactAttachmentCard({
        kind: "document",
        label: content.title,
        mimeType: content.mimeType ?? undefined,
        sizeBytes: content.sizeBytes,
        onDownload: direct ?? (blob ? this.blobDownload.onDownload : undefined),
        downloadPending: blob ? this.blobDownload.pending : false,
        downloadLabel: t("chat.officePreview.download"),
      })}
      ${this.blobDownload.error ? html`<div role="alert">${this.blobDownload.error}</div>` : nothing}
    `;
  }

  render(): TemplateResult | typeof nothing {
    if (this.state.status === "idle") {
      return nothing;
    }
    const content = this.content();
    if (content?.kind !== "attachment" || !content.office) {
      return nothing;
    }
    if (this.state.status === "loading") {
      return html`<div class="sidebar-office-preview__state" role="status">
        ${t("common.loading")}
      </div>`;
    }
    if (this.state.status === "unavailable") {
      return this.renderUnavailable(content, this.state.reason);
    }
    return renderOfficePreview(this.loader, this.state.content, this.blobDownload);
  }
}
