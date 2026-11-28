/**
 * Pure Office family detection shared by the Gateway caller and the staged
 * worker-result inventory.
 *
 * This module has no conversion, cache, or fetch dependency: the inventory runs
 * inside the Git worker and must classify a retention size bound without
 * loading the Gotenberg client.
 */
import type { SessionFileOfficeFormat } from "../../../packages/gateway-protocol/src/index.js";

const MODERN_OFFICE_MIME_TYPES: Record<SessionFileOfficeFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Legacy OLE containers keep metadata-only previews with a recognizable type label. */
const LEGACY_OFFICE_MIME_TYPES: Record<string, string> = {
  xls: "application/vnd.ms-excel",
  doc: "application/msword",
  ppt: "application/vnd.ms-powerpoint",
};

export type OfficePreviewTarget =
  | { kind: "modern"; format: SessionFileOfficeFormat; mimeType: string }
  | { kind: "legacy"; mimeType: string };

function extensionOf(filePath: string): string {
  return filePath.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() ?? "";
}

function modernFormatForExtension(extension: string): SessionFileOfficeFormat | undefined {
  switch (extension) {
    case "xlsx":
    case "docx":
    case "pptx":
      return extension;
    default:
      return undefined;
  }
}

/** Selects the preview reader for a path; extension is the only pre-read signal. */
export function resolveOfficePreviewTarget(filePath: string): OfficePreviewTarget | undefined {
  const extension = extensionOf(filePath);
  const format = modernFormatForExtension(extension);
  if (format) {
    return { kind: "modern", format, mimeType: MODERN_OFFICE_MIME_TYPES[format] };
  }
  const legacyMimeType = LEGACY_OFFICE_MIME_TYPES[extension];
  return legacyMimeType ? { kind: "legacy", mimeType: legacyMimeType } : undefined;
}

/** Modern format declared by a package MIME type, independent of any file name. */
function resolveOfficePreviewFormatForMime(
  mimeType: string | undefined,
): SessionFileOfficeFormat | undefined {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  for (const [format, mime] of Object.entries(MODERN_OFFICE_MIME_TYPES)) {
    if (mime === normalized) {
      return format as SessionFileOfficeFormat;
    }
  }
  return undefined;
}

/** Legacy binary Office family declared by a MIME type. */
function isLegacyOfficeMimeType(mimeType: string | undefined): boolean {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(normalized && Object.hasOwn(LEGACY_OFFICE_MIME_TYPES, normalized));
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
