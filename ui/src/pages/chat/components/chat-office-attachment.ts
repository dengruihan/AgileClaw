import type { SessionFileOfficeFormat } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ArtifactOfficePreview } from "../../../api/artifact-download.ts";
import { t } from "../../../i18n/index.ts";
import { createRetainedUploadDownloadHandler } from "./chat-attachment-download.ts";
import {
  isManagedOutgoingMediaSource,
  resolveManagedOutgoingMediaSessionKey,
} from "./chat-message-attachment-availability.ts";
import {
  loadAssistantAttachmentOfficePreview,
  loadUploadedAttachmentOfficePreview,
} from "./chat-message-attachment-office-preview.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import type { ImageRenderOptions } from "./chat-message-media.ts";
import type { AttachmentOfficePreviewSource } from "./chat-sidebar-content-types.ts";

const OFFICE_MIME_FORMATS = new Map<string, SessionFileOfficeFormat>([
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
]);

const OFFICE_EXTENSION_FORMATS = new Map<string, SessionFileOfficeFormat>([
  ["xlsx", "xlsx"],
  ["docx", "docx"],
  ["pptx", "pptx"],
]);

const LEGACY_OFFICE_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls", "ppt"]);

function extensionOf(value: string | undefined): string {
  return value?.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? "";
}

function normalizedMime(mimeType: string | null | undefined): string {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Modern OOXML format for an attachment descriptor. The MIME type wins, then
 * the label extension, so generic `application/octet-stream` documents still
 * reach the structured viewer when they carry an Office file name.
 */
export function resolveOfficeAttachmentFormat(
  mimeType: string | null | undefined,
  label?: string,
): SessionFileOfficeFormat | undefined {
  return (
    OFFICE_MIME_FORMATS.get(normalizedMime(mimeType)) ??
    OFFICE_EXTENSION_FORMATS.get(extensionOf(label))
  );
}

/** Legacy binary Office family the modern reader deliberately does not parse. */
export function isLegacyOfficeAttachment(
  mimeType: string | null | undefined,
  label?: string,
): boolean {
  return (
    LEGACY_OFFICE_MIME_TYPES.has(normalizedMime(mimeType)) ||
    LEGACY_OFFICE_EXTENSIONS.has(extensionOf(label))
  );
}

/**
 * Chooses the Gateway preview source for one attachment descriptor. Managed
 * artifacts use their stable artifact id; local and uploaded files use the
 * assistant-media metadata route. Both only run when the user opens the file.
 */
export function resolveAttachmentOfficePreview(
  attachment: {
    url: string;
    label: string;
    mimeType?: string | null;
    artifactId?: string;
  },
  options: ImageRenderOptions,
): { office?: AttachmentOfficePreviewSource; legacy: boolean } {
  const format = resolveOfficeAttachmentFormat(attachment.mimeType, attachment.label);
  if (!format) {
    return { legacy: isLegacyOfficeAttachment(attachment.mimeType, attachment.label) };
  }
  const resolveArtifactDownload = options.resolveArtifactDownload;
  const managedSessionKey = isManagedOutgoingMediaSource(attachment.url)
    ? resolveManagedOutgoingMediaSessionKey(attachment.url)
    : null;
  const load = (signal: AbortSignal): Promise<ArtifactOfficePreview | null> => {
    if (/^(?:data|blob):/iu.test(attachment.url.trim())) {
      // Optimistic/outbox bytes live only in this client; the Gateway's
      // bounded parser reads them through the assistant-media owner.
      return loadUploadedAttachmentOfficePreview(attachment.url, attachment.label, options, signal);
    }
    if (managedSessionKey && attachment.artifactId && resolveArtifactDownload) {
      return resolveArtifactDownload(
        {
          sessionKey: managedSessionKey,
          artifactId: attachment.artifactId,
          preview: "office",
        },
        signal,
      ).then((result) => result?.preview ?? null);
    }
    if (isLocalAssistantAttachmentSource(attachment.url)) {
      return loadAssistantAttachmentOfficePreview(attachment.url, options, signal);
    }
    return Promise.resolve(null);
  };
  return { office: { format, load }, legacy: false };
}

/** Formats the viewer can show, or null when the preview has no payload. */
export function officePreviewPayload(preview: ArtifactOfficePreview | null | undefined): {
  format: SessionFileOfficeFormat;
  preview: NonNullable<ArtifactOfficePreview["preview"]>;
} | null {
  if (
    preview?.kind !== "office" ||
    preview.state !== "ready" ||
    !preview.format ||
    !preview.preview
  ) {
    return null;
  }
  return { format: preview.format, preview: preview.preview };
}

/**
 * Sidebar extras for one possibly-Office attachment: the opt-in preview, the
 * legacy metadata notice, and the explicit download. Optimistic/outbox bytes
 * (data:/blob:) back a direct local download since no ticket exists to re-mint
 * for bytes that live only in this client.
 */
export function resolveOfficeSidebarExtras(input: {
  attachment: { url: string; label: string };
  pastedText: boolean;
  onDownload: (() => void) | undefined;
  options: ImageRenderOptions;
}): {
  content: {
    office?: AttachmentOfficePreviewSource;
    previewNotice?: string;
    downloadNow?: () => void;
  };
  uploadSource: boolean;
} {
  const officePreview = input.pastedText
    ? { legacy: false }
    : resolveAttachmentOfficePreview(input.attachment, input.options);
  const uploadSource =
    Boolean(officePreview.office) && /^(?:data|blob):/iu.test(input.attachment.url.trim());
  const downloadNow =
    input.onDownload ??
    (uploadSource
      ? createRetainedUploadDownloadHandler(input.attachment.url, input.attachment.label)
      : undefined);
  return {
    content: {
      ...(officePreview.office ? { office: officePreview.office } : {}),
      ...(officePreview.legacy ? { previewNotice: t("chat.attachments.legacyOfficePreview") } : {}),
      ...(downloadNow ? { downloadNow } : {}),
    },
    uploadSource,
  };
}
