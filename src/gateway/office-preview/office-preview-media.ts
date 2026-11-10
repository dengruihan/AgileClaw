/**
 * Bounded inline document images.
 *
 * Only PNG, JPEG, GIF, and WebP parts are inlined, and only through the shared
 * media-core data-URL sanitizer that re-sniffs the bytes. WMF, EMF, SVG, BMP,
 * TIFF, and oversized images are never rendered; they are counted as an explicit
 * omission instead of being silently dropped.
 *
 * Media is deduplicated by package part: one decoded image is inlined once in
 * the preview's `media` table, and every occurrence is a small block that
 * references it. Repeating an image therefore cannot multiply the serialized
 * payload, and the byte budget applies to actual wire bytes.
 */
import { sanitizeInlineImageDataUrl } from "@openclaw/media-core/inline-image-data-url";
import type {
  SessionFileOfficeImage,
  SessionFileOfficeMedia,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  OFFICE_PREVIEW_MAX_DOCX_IMAGE_BYTES,
  OFFICE_PREVIEW_MAX_DOCX_IMAGE_TOTAL_BYTES,
  OFFICE_PREVIEW_MAX_DOCX_IMAGES,
} from "./office-preview-limits.js";
import type { OmittedFeatureCounter } from "./office-preview-theme.js";
import type { OfficeZipArchive } from "./office-preview-zip.js";

const INLINE_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type DocxImageReader = {
  /** Unique images inlined by this document, indexed by `SessionFileOfficeImage.media`. */
  readonly media: SessionFileOfficeMedia[];
  /** Resolves one image occurrence into a media reference, or undefined. */
  read: (params: {
    relationshipId: string | undefined;
    alt: string | undefined;
    widthPt: number;
    heightPt: number;
  }) => SessionFileOfficeImage | undefined;
};

export function createDocxImageReader(
  archive: OfficeZipArchive,
  relationships: ReadonlyMap<string, string>,
  counter: OmittedFeatureCounter,
): DocxImageReader {
  const indexes = new Map<string, number>();
  const media: SessionFileOfficeMedia[] = [];
  let totalBytes = 0;

  const read = (params: {
    relationshipId: string | undefined;
    alt: string | undefined;
    widthPt: number;
    heightPt: number;
  }): SessionFileOfficeImage | undefined => {
    if (!params.relationshipId) {
      return undefined;
    }
    const target = relationships.get(params.relationshipId);
    if (!target || !target.startsWith("word/media/")) {
      counter.add("images");
      return undefined;
    }
    const extension = target.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? "";
    const mimeType = INLINE_IMAGE_MIME_BY_EXTENSION[extension];
    if (!mimeType) {
      counter.add("images");
      return undefined;
    }
    let mediaIndex = indexes.get(target);
    if (mediaIndex === undefined) {
      if (media.length >= OFFICE_PREVIEW_MAX_DOCX_IMAGES) {
        counter.add("images");
        return undefined;
      }
      let bytes: Buffer | undefined;
      try {
        bytes = archive.readBytes(target);
      } catch {
        bytes = undefined;
      }
      if (!bytes || bytes.length === 0 || bytes.length > OFFICE_PREVIEW_MAX_DOCX_IMAGE_BYTES) {
        counter.add("images");
        return undefined;
      }
      if (totalBytes + bytes.length > OFFICE_PREVIEW_MAX_DOCX_IMAGE_TOTAL_BYTES) {
        counter.add("images");
        return undefined;
      }
      const dataUrl = sanitizeInlineImageDataUrl(
        `data:${mimeType};base64,${bytes.toString("base64")}`,
      );
      if (!dataUrl) {
        counter.add("images");
        return undefined;
      }
      totalBytes += bytes.length;
      mediaIndex = media.length;
      media.push({ dataUrl });
      indexes.set(target, mediaIndex);
    }
    return {
      kind: "image",
      media: mediaIndex,
      widthPt: Math.max(0, Math.min(2_000, params.widthPt)),
      heightPt: Math.max(0, Math.min(2_000, params.heightPt)),
      ...(params.alt ? { alt: params.alt.slice(0, 512) } : {}),
    };
  };

  return { media, read };
}
