import { isManagedArtifactId } from "../../../api/artifact-download.ts";
import type { ArtifactDownloadResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { showToast } from "../../../lib/toast.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
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
let downloadHandlerSequence = 0;

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
export function createRetainedUploadDownloadHandler(
  url: string,
  label: string,
): (signal?: AbortSignal) => void {
  const source = url.trim();
  return (signal?: AbortSignal) => {
    if (source && !signal?.aborted) {
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
function createManagedArtifactDownloadHandler(params: {
  sessionKey: string;
  artifactId: string;
  label: string;
  resolveArtifactDownload: (
    resolveParams: { sessionKey: string; artifactId: string; variant?: "full" | "thumbnail" },
    signal?: AbortSignal,
  ) => Promise<{ url?: string } | null>;
  resourceBasePath?: string;
  connectionEpoch?: () => number | undefined;
}): (signal?: AbortSignal) => void {
  const handlerId = ++downloadHandlerSequence;
  return (signal?: AbortSignal) => {
    const dedupeKey = `managed::${handlerId}::${params.connectionEpoch?.() ?? 0}::${params.sessionKey}::${params.artifactId}`;
    if (inFlightDownloads.has(dedupeKey)) {
      return;
    }
    inFlightDownloads.add(dedupeKey);
    void (async () => {
      try {
        const result = await params.resolveArtifactDownload(
          {
            sessionKey: params.sessionKey,
            artifactId: params.artifactId,
          },
          signal,
        );
        if (signal?.aborted) {
          return;
        }
        const url = result?.url?.trim();
        if (!url) {
          throw new Error("artifact download url unavailable");
        }
        triggerAttachmentDownload(
          applyResourceBasePath(url, params.resourceBasePath),
          params.label,
        );
      } catch {
        if (!signal?.aborted) {
          showToast({ message: t("chat.attachments.downloadFailed") });
        }
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

/** Saves one blob under an explicit filename through the browser download flow. */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    triggerAttachmentDownload(url, filename);
  } finally {
    // The browser snapshots the resource when the download starts; revoking on
    // a later turn keeps repeated previews from leaking object URLs.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * Click-time download for a rail artifact whose open-time delivery was
 * URL-only. Every click re-runs the fresh download RPC and consumes only that
 * response: validated bytes save directly, and a returned URL must pass the
 * artifact download safety check — a cached ticket from the open-time
 * response is never reused.
 */
function createArtifactFreshDownloadHandler(params: {
  dedupeKey: string;
  label: string;
  resolveDownload: (
    signal?: AbortSignal,
  ) => Promise<(ArtifactDownloadResult & { blob?: Blob }) | null>;
  isSafeUrl: (url: string) => boolean;
  applyBasePath: (url: string) => string;
  connectionEpoch?: () => number | undefined;
}): (signal?: AbortSignal) => void {
  const handlerId = ++downloadHandlerSequence;
  return (signal?: AbortSignal) => {
    const dedupeKey = `artifact::${handlerId}::${params.connectionEpoch?.() ?? 0}::${params.dedupeKey}`;
    if (inFlightDownloads.has(dedupeKey)) {
      return;
    }
    inFlightDownloads.add(dedupeKey);
    void (async () => {
      try {
        const result = await params.resolveDownload(signal);
        if (signal?.aborted) {
          return;
        }
        // The fresh response owns the authoritative title; a rail row may lack one.
        const label = result?.artifact.title.trim() || params.label;
        if (result?.blob) {
          triggerBlobDownload(result.blob, label);
          return;
        }
        if (result?.encoding === "base64" && result.data !== undefined) {
          triggerBlobDownload(
            new Blob([base64ToBytes(result.data)], {
              type: result.artifact.mimeType ?? "application/octet-stream",
            }),
            label,
          );
          return;
        }
        const url = result?.url?.trim();
        if (!url || !params.isSafeUrl(url)) {
          throw new Error("artifact download url rejected");
        }
        triggerAttachmentDownload(params.applyBasePath(url), label);
      } catch {
        if (!signal?.aborted) {
          showToast({ message: t("chat.attachments.downloadFailed") });
        }
      } finally {
        inFlightDownloads.delete(dedupeKey);
      }
    })();
  };
}

/** How one opened artifact downloads: fresh blob read or click-time re-mint. */
export type ArtifactDownloadContract = {
  blob?: (signal: AbortSignal) => Promise<Blob | null>;
  now?: (signal?: AbortSignal) => void;
};

/**
 * Download contract for one rail artifact: managed transcript artifacts
 * re-mint their ticket, and ordinary artifacts save fresh bytes when the
 * Gateway returns them or hand a freshly authorized URL to the browser.
 */
export function createArtifactDownloadContract(params: {
  artifactId: string;
  sessionKey: string;
  label: string | undefined;
  resolveFreshResult: (
    signal?: AbortSignal,
  ) => Promise<(ArtifactDownloadResult & { blob?: Blob }) | null>;
  resolveManagedDownload: (
    resolveParams: { sessionKey: string; artifactId: string; variant?: "full" | "thumbnail" },
    signal?: AbortSignal,
  ) => Promise<{ url?: string } | null>;
  resourceBasePath?: string;
  connectionEpoch: () => number | undefined;
}): ArtifactDownloadContract {
  const label = params.label || t("chat.workspaceFiles.artifacts");
  if (isManagedArtifactId(params.artifactId)) {
    return {
      now: createManagedArtifactDownloadHandler({
        sessionKey: params.sessionKey,
        artifactId: params.artifactId,
        label,
        resolveArtifactDownload: params.resolveManagedDownload,
        resourceBasePath: params.resourceBasePath,
        connectionEpoch: params.connectionEpoch,
      }),
    };
  }
  return {
    blob: async (signal) => {
      const result = await params.resolveFreshResult(signal);
      if (result?.blob) {
        return result.blob;
      }
      if (result?.encoding !== "base64" || result.data === undefined) {
        return null;
      }
      return new Blob([base64ToBytes(result.data)], {
        type: result.artifact.mimeType ?? "application/octet-stream",
      });
    },
    now: createArtifactFreshDownloadHandler({
      dedupeKey: `${params.sessionKey}::${params.artifactId}`,
      label,
      resolveDownload: params.resolveFreshResult,
      isSafeUrl: (url) =>
        Boolean(safeAttachmentHref(applyResourceBasePath(url, params.resourceBasePath))),
      applyBasePath: (url) => applyResourceBasePath(url, params.resourceBasePath),
      connectionEpoch: params.connectionEpoch,
    }),
  };
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
