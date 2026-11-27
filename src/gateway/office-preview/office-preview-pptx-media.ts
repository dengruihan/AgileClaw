/**
 * Bounded inline pictures for the PPTX slide reader.
 *
 * Slides reference pictures by relationship; only parts under `ppt/media/` with
 * a PNG, JPEG, GIF, or WebP signature are inlined, through the shared
 * media-core data-URL sanitizer. Every other picture (metafiles, oversized
 * bytes, broken relationships, video posters) is counted as an explicit
 * omission instead of disappearing.
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

/** Slide pictures reference one deduplicated media table per presentation. */
export type SlideImageReader = {
  readonly media: SessionFileOfficeMedia[];
  read: (params: {
    /** Resolved in-package part path, or undefined for a broken relationship. */
    target: string | undefined;
    alt: string | undefined;
    widthPt: number;
    heightPt: number;
  }) => SessionFileOfficeImage | undefined;
};

export function createSlideImageReader(
  archive: OfficeZipArchive,
  counter: OmittedFeatureCounter,
): SlideImageReader {
  const indexes = new Map<string, number>();
  const media: SessionFileOfficeMedia[] = [];
  let totalBytes = 0;

  const read = (params: {
    target: string | undefined;
    alt: string | undefined;
    widthPt: number;
    heightPt: number;
  }): SessionFileOfficeImage | undefined => {
    const target = params.target;
    if (!target || !target.startsWith("ppt/media/")) {
      counter.add("images");
      return undefined;
    }
    const mimeType =
      INLINE_IMAGE_MIME_BY_EXTENSION[target.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? ""];
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
