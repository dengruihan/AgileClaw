import type {
  ArtifactOfficePreview,
  SessionFileOfficeFormat,
} from "../../../packages/gateway-protocol/src/index.js";
import { OFFICE_PREVIEW_MAX_BYTES } from "./office-preview-limits.js";
import {
  isLegacyOfficeMimeType,
  readOfficePreview,
  resolveOfficePreviewFormatForMime,
  resolveOfficePreviewTarget,
} from "./office-preview.js";

/** One caller-owned document that may receive an opt-in Office preview. */
export type OfficePreviewSource = {
  filename?: string;
  mimeType?: string;
  /** Declared size, when known; avoids reading a file that cannot fit the limit. */
  sizeBytes?: number;
  /** Reads the bounded original bytes; null means the bytes are unavailable. */
  read: () => Promise<Buffer | null>;
};

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function hasZipSignature(buffer: Buffer): boolean {
  return buffer.length >= ZIP_LOCAL_HEADER.length && buffer.subarray(0, 4).equals(ZIP_LOCAL_HEADER);
}

/** Office family declared by a file name and/or MIME type. */
export function resolveOfficePreviewFamily(source: { filename?: string; mimeType?: string }): {
  format?: SessionFileOfficeFormat;
  legacy: boolean;
  office: boolean;
} {
  const named = source.filename ? resolveOfficePreviewTarget(source.filename) : undefined;
  if (named?.kind === "modern") {
    return { format: named.format, legacy: false, office: true };
  }
  const byMime = resolveOfficePreviewFormatForMime(source.mimeType);
  if (byMime) {
    return { format: byMime, legacy: false, office: true };
  }
  const legacy = named?.kind === "legacy" || isLegacyOfficeMimeType(source.mimeType);
  return { legacy, office: Boolean(named || legacy) };
}

/**
 * Builds the shared structured Office preview for every artifact/attachment
 * entry point. Files outside the Office families return undefined so callers
 * keep their existing preview path.
 */
export async function buildOfficePreviewPayload(
  source: OfficePreviewSource,
): Promise<ArtifactOfficePreview | undefined> {
  const target = resolveOfficePreviewFamily(source);
  if (!target.office) {
    return undefined;
  }
  if (target.legacy) {
    // Legacy OLE containers need an OLE reader; report the family honestly.
    return { kind: "office", state: "unsupported" };
  }
  const format = target.format;
  if (!format) {
    return { kind: "office", state: "unsupported" };
  }
  if (source.sizeBytes !== undefined && source.sizeBytes > OFFICE_PREVIEW_MAX_BYTES) {
    return { kind: "office", format, state: "too-large" };
  }
  const buffer = await source.read();
  if (!buffer || buffer.length === 0) {
    return { kind: "office", format, state: "invalid" };
  }
  if (buffer.length > OFFICE_PREVIEW_MAX_BYTES) {
    return { kind: "office", format, state: "too-large" };
  }
  if (!hasZipSignature(buffer)) {
    // A renamed text or legacy file keeps the declared type but no fake preview.
    return { kind: "office", format, state: "invalid" };
  }
  const preview = await readOfficePreview(buffer, format);
  return preview
    ? { kind: "office", format, state: "ready", preview }
    : { kind: "office", format, state: "invalid" };
}
