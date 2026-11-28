/**
 * Bounds for the read-only Office preview conversion.
 *
 * The Gateway never parses OOXML itself: it hands the bounded original bytes to
 * the Gotenberg/LibreOffice converter and receives a PDF. Every limit is
 * enforced here so a hostile document or a stalled converter cannot grow the
 * Gateway's memory or hold a request open indefinitely.
 */

/** Largest source document the Gateway will send to the converter. */
export const OFFICE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Largest PDF the Gateway will accept back from the converter. */
export const OFFICE_PREVIEW_MAX_PDF_BYTES = 16 * 1024 * 1024;

/** Wall-clock ceiling for one conversion request, including response drain. */
export const OFFICE_PREVIEW_CONVERSION_TIMEOUT_MS = 30_000;

/** Maximum converted PDFs kept in the process-local preview cache. */
export const OFFICE_PREVIEW_CACHE_MAX_ENTRIES = 8;

/** Total converted-PDF bytes the process-local preview cache may retain. */
export const OFFICE_PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** Idle lifetime of one cached PDF; each hit refreshes it. */
export const OFFICE_PREVIEW_CACHE_IDLE_TTL_MS = 15 * 60 * 1000;
