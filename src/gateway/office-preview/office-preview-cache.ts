/**
 * Process-local converted-PDF cache with same-key singleflight.
 *
 * Source attachments remain the only durable data: nothing here is written to
 * disk, JSON, or SQLite. The cache is keyed by the source byte hash plus the
 * converter version, never by a session, user, or path, so two users opening
 * identical bytes share one conversion and no identity leaks into the key.
 */
import { sha256Hex } from "../../infra/crypto-digest.js";
import { LruCache } from "../../infra/lru-cache.js";
import type { OfficeConversionResult } from "./office-preview-convert.js";
import { OFFICE_PREVIEW_CONVERTER_VERSION } from "./office-preview-convert.js";
import {
  OFFICE_PREVIEW_CACHE_IDLE_TTL_MS,
  OFFICE_PREVIEW_CACHE_MAX_BYTES,
  OFFICE_PREVIEW_CACHE_MAX_ENTRIES,
} from "./office-preview-limits.js";

type CachedOfficePdf = {
  pdf: Buffer;
  expiresAt: number;
};

const cache = new LruCache<CachedOfficePdf>(OFFICE_PREVIEW_CACHE_MAX_ENTRIES, {
  maxBytes: OFFICE_PREVIEW_CACHE_MAX_BYTES,
  sizeOf: (entry) => entry.pdf.byteLength,
});
const inflight = new Map<string, Promise<OfficeConversionResult>>();

/** Stable cache identity: source bytes and converter generation only. */
export function officePreviewCacheKey(bytes: Buffer): string {
  return `${OFFICE_PREVIEW_CONVERTER_VERSION}:${sha256Hex(bytes)}`;
}

function dropExpired(now: number): void {
  for (const key of cache.keys()) {
    const entry = cache.peek(key);
    if (entry && entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

/** Cached PDF for the key, refreshing its idle lifetime; expired entries miss. */
export function readCachedOfficePdf(key: string, now = Date.now()): Buffer | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  entry.expiresAt = now + OFFICE_PREVIEW_CACHE_IDLE_TTL_MS;
  return entry.pdf;
}

/** Stores one converted PDF, evicting the least recently used previews. */
export function storeCachedOfficePdf(key: string, pdf: Buffer, now = Date.now()): void {
  dropExpired(now);
  cache.set(key, { pdf, expiresAt: now + OFFICE_PREVIEW_CACHE_IDLE_TTL_MS });
}

/**
 * Runs one conversion per key while callers wait on the same promise.
 *
 * Concurrent opens of the same document must not start parallel LibreOffice
 * jobs. Failures are not cached, so a recovered converter serves the next
 * request instead of a stale error.
 */
export async function convertOfficeDocumentWithCache(
  key: string,
  convert: () => Promise<OfficeConversionResult>,
): Promise<OfficeConversionResult> {
  const pending = inflight.get(key);
  if (pending) {
    return await pending;
  }
  const request = convert().then((result) => {
    if ("pdf" in result) {
      storeCachedOfficePdf(key, result.pdf);
    }
    return result;
  });
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    inflight.delete(key);
  }
}
