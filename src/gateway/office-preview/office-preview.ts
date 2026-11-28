/**
 * Office preview family detection and the shared payload builder.
 *
 * Every entry point — `artifacts.download`, the assistant-media route (local
 * files and client-held uploads), and `sessions.files` — reaches the converter
 * through this module so there is one owner for format selection, encryption
 * detection, size bounds, caching, and degraded states.
 */
import type {
  ArtifactOfficePreview,
  SessionFileOfficeFormat,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  convertOfficeDocumentWithCache,
  officePreviewCacheKey,
  readCachedOfficePdf,
} from "./office-preview-cache.js";
import { looksLikeEncryptedOfficePackage } from "./office-preview-container.js";
import {
  convertOfficeDocumentToPdf,
  type OfficeConversionResult,
} from "./office-preview-convert.js";
import { OFFICE_PREVIEW_MAX_BYTES } from "./office-preview-limits.js";

export { OFFICE_PREVIEW_MAX_BYTES } from "./office-preview-limits.js";

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

/** One caller-owned document that may receive an opt-in PDF preview. */
export type OfficePreviewSource = {
  filename?: string;
  mimeType?: string;
  /** Declared size, when known; avoids reading a file that cannot fit the limit. */
  sizeBytes?: number;
  /** Reads the bounded original bytes; null means the bytes are unavailable. */
  read: () => Promise<Buffer | null>;
  /** Cancels the wait for a conversion; the shared job may still finish. */
  signal?: AbortSignal;
};

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

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function hasZipSignature(buffer: Buffer): boolean {
  return buffer.length >= ZIP_LOCAL_HEADER.length && buffer.subarray(0, 4).equals(ZIP_LOCAL_HEADER);
}

/**
 * Keeps the original name for the converter's import filter, adding the format
 * extension when a display title dropped it (managed artifacts often do).
 */
function converterFilename(filename: string | undefined, format: SessionFileOfficeFormat): string {
  const fallback = `document.${format}`;
  if (!filename) {
    return fallback;
  }
  const base = filename.split(/[\\/]/u).pop() ?? filename;
  const extension = base.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase();
  if (extension === format) {
    return base;
  }
  const stem = extension && extension.length <= 5 ? base.slice(0, -(extension.length + 1)) : base;
  return `${stem || "document"}.${format}`;
}

/**
 * Resolves an abortable wait without cancelling the shared conversion job.
 * An aborted caller renders nothing; another waiter can still receive the PDF.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
}

function pdfPreview(format: SessionFileOfficeFormat, pdf: Buffer): ArtifactOfficePreview {
  return {
    kind: "office",
    format,
    state: "ready",
    pdf: {
      mimeType: "application/pdf",
      data: pdf.toString("base64"),
      sizeBytes: pdf.byteLength,
    },
  };
}

/**
 * Builds the shared PDF preview for every artifact/attachment entry point.
 * Files outside the Office families return undefined so callers keep their
 * existing preview path; legacy OLE containers report `unsupported` without a
 * conversion attempt.
 */
export async function buildOfficePreviewPayload(
  source: OfficePreviewSource,
): Promise<ArtifactOfficePreview | undefined> {
  const target = resolveOfficePreviewFamily(source);
  if (!target.office) {
    return undefined;
  }
  if (target.legacy) {
    // Legacy OLE containers are outside the modern OOXML conversion contract.
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
    // A modern extension over an OLE container is the ECMA-376 encrypted
    // package; other non-ZIP bytes are a renamed or corrupt file.
    return {
      kind: "office",
      format,
      state: looksLikeEncryptedOfficePackage(buffer) ? "password-protected" : "invalid",
    };
  }
  const cacheKey = officePreviewCacheKey(buffer);
  const cached = readCachedOfficePdf(cacheKey);
  if (cached) {
    return pdfPreview(format, cached);
  }
  if (source.signal?.aborted) {
    return { kind: "office", format, state: "unavailable" };
  }
  const conversion = await abortable(
    convertOfficeDocumentWithCache(cacheKey, () =>
      convertOfficeDocumentToPdf({
        bytes: buffer,
        filename: converterFilename(source.filename, format),
      }),
    ),
    source.signal,
  );
  if (!conversion) {
    // An aborted caller never publishes a result, so the state is unused.
    return { kind: "office", format, state: "unavailable" };
  }
  return officeConversionPreview(format, conversion);
}

/** Maps one conversion outcome onto the public preview states. */
function officeConversionPreview(
  format: SessionFileOfficeFormat,
  conversion: OfficeConversionResult,
): ArtifactOfficePreview {
  if ("pdf" in conversion) {
    return pdfPreview(format, conversion.pdf);
  }
  return { kind: "office", format, state: conversion.failure };
}
