import { t } from "../../../i18n/index.ts";
import { showToast } from "../../../lib/toast.ts";
import {
  isManagedOutgoingMediaSource,
  loadAssistantAttachmentAvailability,
  resolveManagedOutgoingMediaSessionKey,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import {
  applyResourceBasePath,
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

type DownloadableAttachment = AttachmentItem["attachment"];

const inFlightDownloads = new Set<string>();

/** History can carry pre-ticketed assistant-media URLs. The source query param
 * still names the local file, so click-time re-minting covers them too. */
function assistantMediaRequestSource(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!parsed.pathname.endsWith("/__openclaw__/assistant-media")) {
      return null;
    }
    const source = parsed.searchParams.get("source")?.trim();
    return source && isLocalAssistantAttachmentSource(source) ? source : null;
  } catch {
    return null;
  }
}

/** Ticketed attachment URLs authorize one short window and die with the gateway's
 * process-random signing key, so a saved href goes stale after expiry or a
 * restart. Mint a fresh ticket at click time and let the browser download
 * natively; static http(s) sources keep their plain anchor (undefined here). */
export function createAttachmentDownloadHandler(
  attachment: DownloadableAttachment,
  options: ImageRenderOptions,
): (() => void) | undefined {
  const requestSource = assistantMediaRequestSource(attachment.url);
  if (!requestSource) {
    if (isManagedOutgoingMediaSource(attachment.url)) {
      if (!attachment.artifactId || !options.resolveArtifactDownload) {
        return undefined;
      }
    } else if (!isLocalAssistantAttachmentSource(attachment.url)) {
      return undefined;
    }
  }
  const source = requestSource ?? attachment.url;
  return () => {
    void downloadAttachmentWithFreshTicket(attachment, options, source);
  };
}

async function downloadAttachmentWithFreshTicket(
  attachment: DownloadableAttachment,
  options: ImageRenderOptions,
  source: string,
): Promise<void> {
  const dedupeKey = `${options.connectionEpoch ?? 0}::${attachment.url}`;
  if (inFlightDownloads.has(dedupeKey)) {
    return;
  }
  inFlightDownloads.add(dedupeKey);
  try {
    const url = await resolveFreshAttachmentDownloadUrl(attachment, options, source);
    if (!url) {
      throw new Error("attachment download url unavailable");
    }
    triggerAttachmentDownload(url, attachment.label);
  } catch {
    showToast({ message: t("chat.attachments.downloadFailed") });
  } finally {
    inFlightDownloads.delete(dedupeKey);
  }
}

/**
 * Retained optimistic/outbox upload bytes (data:/blob:) have no ticket to
 * re-mint; the browser downloads those bytes directly under the attachment's
 * name. Scoped to Office uploads whose preview already parsed the same bytes.
 */
export function createRetainedUploadDownloadHandler(url: string, label: string): () => void {
  const source = url.trim();
  return () => {
    if (source) {
      triggerAttachmentDownload(source, label);
    }
  };
}

/**
 * Click-time download for a rail-opened managed artifact. The ordinary
 * `artifacts.download` response is URL-only, so re-mint the ticket on every
 * click and hand the fresh URL to the browser's download flow, exactly like a
 * managed chat attachment.
 */
export function createManagedArtifactDownloadHandler(params: {
  sessionKey: string;
  artifactId: string;
  label: string;
  resolveArtifactDownload: (
    resolveParams: { sessionKey: string; artifactId: string; variant?: "full" | "thumbnail" },
    signal?: AbortSignal,
  ) => Promise<{ url?: string } | null>;
  resourceBasePath?: string;
  connectionEpoch?: () => number | undefined;
}): () => void {
  return () => {
    const dedupeKey = `managed::${params.connectionEpoch?.() ?? 0}::${params.sessionKey}::${params.artifactId}`;
    if (inFlightDownloads.has(dedupeKey)) {
      return;
    }
    inFlightDownloads.add(dedupeKey);
    void (async () => {
      try {
        const result = await params.resolveArtifactDownload({
          sessionKey: params.sessionKey,
          artifactId: params.artifactId,
        });
        const url = result?.url?.trim();
        if (!url) {
          throw new Error("artifact download url unavailable");
        }
        triggerAttachmentDownload(
          applyResourceBasePath(url, params.resourceBasePath),
          params.label,
        );
      } catch {
        showToast({ message: t("chat.attachments.downloadFailed") });
      } finally {
        inFlightDownloads.delete(dedupeKey);
      }
    })();
  };
}

async function resolveFreshAttachmentDownloadUrl(
  attachment: DownloadableAttachment,
  options: ImageRenderOptions,
  source: string,
): Promise<string | null> {
  if (!isLocalAssistantAttachmentSource(source)) {
    const sessionKey = resolveManagedOutgoingMediaSessionKey(attachment.url);
    if (!sessionKey || !attachment.artifactId || !options.resolveArtifactDownload) {
      return null;
    }
    const result = await options.resolveArtifactDownload({
      sessionKey,
      artifactId: attachment.artifactId,
    });
    const url = result?.url?.trim();
    return url ? applyResourceBasePath(url, options.resourceBasePath) : null;
  }
  retryAssistantAttachmentAvailability(source, options);
  const availability = await loadAssistantAttachmentAvailability(source, options);
  if (availability?.status !== "available") {
    return null;
  }
  return buildAssistantAttachmentUrl(
    source,
    options.resourceBasePath,
    availability.mediaTicket,
    options,
    attachment.label,
  );
}

/** Hands one URL to the browser's download flow with an explicit filename. */
export function triggerAttachmentDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.click();
}
