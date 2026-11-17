import { maxBytesForKind, mediaKindFromMime, type MediaKind } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { WEBCHAT_LOCAL_MEDIA_MAX_BYTES } from "../media/configured-max-bytes.js";

export type ManagedMediaKind = Extract<MediaKind, "image" | "audio" | "video" | "document">;

export function maxBytesForManagedMediaKind(
  kind: ManagedMediaKind,
  imageMaxBytes: number,
  local = false,
): number {
  return kind === "image"
    ? imageMaxBytes
    : local && (kind === "audio" || kind === "video")
      ? WEBCHAT_LOCAL_MEDIA_MAX_BYTES
      : maxBytesForKind(kind);
}

/**
 * Maps any stored content type to a delivery family. Unknown and active types
 * (including SVG and octet-stream) are documents: they render as a downloadable
 * attachment card rather than through image delivery or inline media.
 */
export function resolveManagedMediaKind(contentType: string | undefined): ManagedMediaKind | null {
  const normalized = normalizeMimeType(contentType);
  if (!normalized) {
    return null;
  }
  // SVG can execute script when navigated to and cannot be raster-optimized.
  if (normalized === "image/svg+xml") {
    return "document";
  }
  const kind = mediaKindFromMime(normalized);
  if (kind === "image" || kind === "audio" || kind === "video") {
    return kind;
  }
  return "document";
}

export function formatLimitMiB(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${bytes} bytes`;
  }
  return Number.isInteger(bytes / (1024 * 1024))
    ? `${bytes / (1024 * 1024)} MiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
