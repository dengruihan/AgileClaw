/**
 * Bounded inline document images.
 *
 * Only PNG, JPEG, GIF, and WebP parts are inlined, and only through the shared
 * media-core data-URL sanitizer that re-sniffs the bytes. WMF, EMF, SVG, BMP,
 * TIFF, and oversized images are never rendered; they are counted as an explicit
 * omission instead of being silently dropped.
 */
import { sanitizeInlineImageDataUrl } from "@openclaw/media-core/inline-image-data-url";
import type { SessionFileOfficeImage } from "../../../packages/gateway-protocol/src/index.js";
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
  /** Resolves one image relationship into a bounded typed image, or undefined. */
  read: (params: {
    relationshipId: string | undefined;
    alt: string | undefined;
    widthPt: number;
    heightPt: number;
  }) => SessionFileOfficeImage | undefined;
  /** True when at least one image was inlined. */
  readonly used: boolean;
};

export function createDocxImageReader(
  archive: OfficeZipArchive,
  relationships: ReadonlyMap<string, string>,
  counter: OmittedFeatureCounter,
): DocxImageReader {
  const cache = new Map<string, string | undefined>();
  let inlineCount = 0;
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
    let dataUrl = cache.get(target);
    if (dataUrl === undefined) {
      if (inlineCount >= OFFICE_PREVIEW_MAX_DOCX_IMAGES) {
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
      dataUrl = sanitizeInlineImageDataUrl(`data:${mimeType};base64,${bytes.toString("base64")}`);
      if (!dataUrl) {
        counter.add("images");
        return undefined;
      }
      totalBytes += bytes.length;
      inlineCount += 1;
      cache.set(target, dataUrl);
    }
    return {
      kind: "image",
      dataUrl,
      widthPt: Math.max(0, Math.min(2_000, params.widthPt)),
      heightPt: Math.max(0, Math.min(2_000, params.heightPt)),
      ...(params.alt ? { alt: params.alt.slice(0, 512) } : {}),
    };
  };

  return {
    read,
    get used() {
      return inlineCount > 0;
    },
  };
}
