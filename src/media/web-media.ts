import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { basenameFromAnyPath, extnameFromAnyPath } from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  kindFromMime,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { EncodedImage } from "rastermill";
import { resolveCanvasHttpPathToLocalPath } from "../canvas/documents.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError } from "../infra/fs-safe.js";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveUserPath } from "../utils.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { readRemoteMediaBuffer } from "./fetch.js";
import {
  pruneGeneratedHtmlProvenance,
  writeGeneratedHtmlProvenance,
} from "./generated-html-provenance.js";
import { ImageOptimizationLimitError } from "./image-optimization-error.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
import { createImageProcessorWithPixelLimits } from "./image-processor.js";
import type { OutboundMediaReadFile } from "./load-options.js";
import {
  assertLocalMediaAllowed,
  getDefaultLocalRootsCore,
  LocalMediaAccessError,
  readLocalMediaFile,
  type LocalMediaAccessErrorCode,
} from "./local-media-access.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";
import {
  createImageProcessor,
  isAnimatedWebpBuffer,
  readImageMetadataFromHeader,
  readImageProbeFromHeader,
  type ImageMetadata,
} from "./media-services.js";
import { extractOriginalFilename, getMediaDir } from "./store.js";
import { formatMediaSize } from "./store.shared.js";

export { getDefaultLocalRootsCore, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };

/** Loaded media bytes plus resolved MIME kind and filename metadata for outbound/plugin callers. */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  imageCompression?: ImageCompressionPolicy;
  ssrfPolicy?: SsrFPolicy;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  readIdleTimeoutMs?: number;
  trustExplicitProxyDns?: boolean;
  workspaceDir?: string;
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Channel inbound attachment root patterns checked with inbound path policy semantics. */
  inboundRoots?: readonly string[];
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: OutboundMediaReadFile;
  /** Host-local fs-policy read piggyback; enables buffer-verified media typing. */
  hostReadCapability?: boolean;
  /** Outbound attachment callers keep original bytes when image/media preview preparation fails. */
  documentFallback?: boolean;
};

export type ImageQualityPreference = "auto" | "efficient" | "balanced" | "high";

export type ImageCompressionModelPolicy = {
  maxBytes?: number;
  maxPixels?: number;
  maxSidePx?: number;
  preferredSidePx?: number;
};

export type ImageCompressionPolicy = {
  quality?: ImageQualityPreference;
  models?: ImageCompressionModelPolicy[];
  imageCount?: number;
};

async function resolveMediaStoreUriToPath(mediaUrl: string): Promise<string | null> {
  if (!/^media:\/\//i.test(mediaUrl)) {
    return null;
  }
  try {
    return (await resolveInboundMediaReference(mediaUrl))?.physicalPath ?? null;
  } catch (err) {
    if (err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    throw err;
  }
}

async function resolveHostedPluginMediaUrl(mediaUrl: string): Promise<string | null> {
  const registry = getPluginRegistryForContext();
  for (const entry of registry?.hostedMediaResolvers ?? []) {
    try {
      const resolved = await entry.resolver(mediaUrl);
      if (typeof resolved === "string" && resolved.trim()) {
        return resolved;
      }
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Hosted media resolver failed (${entry.pluginId ?? "unknown"}): ${formatErrorMessage(err)}`,
        );
      }
    }
  }
  return null;
}

function resolveWebMediaOptions(params: {
  maxBytesOrOptions?: number | WebMediaOptions;
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" };
  optimizeImages: boolean;
}): WebMediaOptions {
  if (typeof params.maxBytesOrOptions === "number" || params.maxBytesOrOptions === undefined) {
    return {
      maxBytes: params.maxBytesOrOptions,
      optimizeImages: params.optimizeImages,
      ssrfPolicy: params.options?.ssrfPolicy,
      localRoots: params.options?.localRoots,
    };
  }
  return {
    ...params.maxBytesOrOptions,
    optimizeImages: params.optimizeImages
      ? (params.maxBytesOrOptions.optimizeImages ?? true)
      : false,
  };
}

// Pre-compression fetch headroom for callers with an explicit delivery cap:
// enough to pull a large phone photo (~20MB+) and compress it under the cap,
// without letting a tight channel cap buffer up to the 100MB document bound.
const IMAGE_OPTIMIZE_HEADROOM_FACTOR = 4;

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function stripLegacyMediaDirectivePrefix(mediaUrl: string): string {
  if (/^\s*media:\/\//i.test(mediaUrl)) {
    return mediaUrl;
  }
  return mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
}

function resolveLocalMediaFileName(filePath: string): string | undefined {
  const fileName = basenameFromAnyPath(filePath) || undefined;
  return fileName && isPathInside(getMediaDir(), filePath)
    ? extractOriginalFilename(fileName)
    : fileName;
}

/**
 * Legacy marker writer kept for plugin/API compatibility. Host reads admit HTML
 * without provenance now; this records exact bytes for callers that still stage
 * trusted generated HTML outbound.
 */
export async function markTrustedGeneratedHtmlPath(
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const outboundPath = path.join(getMediaDir(), "outbound");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const sizeBytes = contents.length;
  const resolvedFilePath = await realpath(filePath);
  const outboundRoot = await realpath(outboundPath).catch(() => undefined);
  if (!outboundRoot || !isPathInside(outboundRoot, resolvedFilePath)) {
    throw new Error(
      `markTrustedGeneratedHtmlPath: refusing path outside outbound staging: ${resolvedFilePath}`,
    );
  }
  await writeGeneratedHtmlProvenance(context, {
    type: "generatedHtmlProvenance.upsert",
    input: {
      realpath: resolvedFilePath,
      kind: "trusted-generated-html",
      version: 1,
      sha256,
      size_bytes: sizeBytes,
      created_at_ms: Date.now(),
    },
  });
}

/** Removes legacy trusted-HTML markers whose staged regular file no longer exists. */
export async function pruneStaleTrustedGeneratedHtmlMarkers(): Promise<void> {
  await pruneGeneratedHtmlProvenance(captureOpenClawStateWorkerContext());
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMediaSize(cap)} limit (got ${formatMediaSize(size)})`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMediaSize(cap)} (got ${formatMediaSize(size)})`;
}

/**
 * SVG is text that browsers execute when navigated to and that raster decoders cannot
 * process, so it stays on the download-only document path instead of image delivery.
 */
function resolveWebMediaKind(mime: string | undefined): MediaKind | undefined {
  return normalizeMimeType(mime) === "image/svg+xml" ? "document" : kindFromMime(mime);
}

/**
 * Host reads admit every file format, but image/audio/video delivery needs buffer
 * proof. Without a recognized media signature an extension-declared media file is
 * only bytes, so unknown `.png`/`.mp3` names become generic download-only documents
 * instead of broken previews. SVG stays typed by extension because browsers do not
 * execute it inside an image element and raster decoders cannot read it.
 */
function resolveHostReadMime(
  declaredMime: string | undefined,
  sniffedMime: string | undefined,
): string | undefined {
  const normalized = normalizeMimeType(declaredMime);
  if (!normalized || sniffedMime) {
    return declaredMime;
  }
  const kind = kindFromMime(normalized);
  return normalized === "image/svg+xml" ||
    (kind !== "image" && kind !== "audio" && kind !== "video")
    ? declaredMime
    : "application/octet-stream";
}

function toImageFileName(fileName: string | undefined, mimeType: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = basenameFromAnyPath(fileName.trim());
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  const ext = extensionForMime(mimeType);
  return mimeType !== "image/jpeg" && parsed.ext.toLowerCase() === ext
    ? fileName
    : path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext });
}

const DEFAULT_JPEG_SIDES = [2048, 1536, 1280, 1024, 800] as const;
const DEFAULT_JPEG_QUALITIES = [80, 70, 60, 50, 40] as const;
const DEFAULT_VISION_MAX_SIDE = 2048;
const LOW_IMAGE_SIDE_FALLBACKS = [640, 512, 384, 256, 192, 128] as const;

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function effectiveImageQualityPreference(
  policy?: ImageCompressionPolicy,
): Exclude<ImageQualityPreference, "auto"> {
  const preference = policy?.quality;
  if (preference === "efficient" || preference === "balanced" || preference === "high") {
    return preference;
  }
  const imageCount = Math.max(1, Math.floor(policy?.imageCount ?? 1));
  if (imageCount >= 6) {
    return "efficient";
  }
  return "balanced";
}

function maxSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  const maxSide = positiveInteger(model?.maxSidePx);
  const maxPixels = positiveInteger(model?.maxPixels);
  const hardLimits = [maxSide, maxPixels ? Math.floor(Math.sqrt(maxPixels)) : undefined].filter(
    (value): value is number => value !== undefined,
  );
  if (hardLimits.length > 0) {
    return Math.min(...hardLimits);
  }
  return positiveInteger(model?.preferredSidePx) ?? DEFAULT_VISION_MAX_SIDE;
}

function sideForPreference(
  preference: Exclude<ImageQualityPreference, "auto">,
  policy?: ImageCompressionPolicy,
): number {
  const models = policy?.models?.length ? policy.models : [undefined];
  const maxSide = Math.min(...models.map((model) => maxSideForModel(model)));
  const preferredSide = Math.min(
    ...models.map(
      (model) =>
        positiveInteger(model?.preferredSidePx) ??
        Math.min(maxSideForModel(model), DEFAULT_VISION_MAX_SIDE),
    ),
  );
  switch (preference) {
    case "efficient":
      return Math.min(preferredSide, maxSide, 1280);
    case "high":
      return maxSide;
    default:
      return Math.min(preferredSide, maxSide);
  }
}

function imageMaxBytesForPolicy(policy?: ImageCompressionPolicy): number | undefined {
  const maxBytes = policy?.models
    ?.map((model) => positiveInteger(model.maxBytes))
    .filter((value): value is number => value !== undefined);
  return maxBytes?.length ? Math.min(...maxBytes) : undefined;
}

function imageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
  metadata?: ImageMetadata,
): boolean {
  const models = policy?.models ?? [];
  const hardMaxSide = Math.min(
    ...models.map((model) => positiveInteger(model.maxSidePx) ?? Infinity),
  );
  const hardMaxPixels = Math.min(
    ...models.map((model) => positiveInteger(model.maxPixels) ?? Infinity),
  );
  if (hardMaxSide === Infinity && hardMaxPixels === Infinity) {
    return true;
  }
  const meta = metadata ?? readImageMetadataFromHeader(buffer);
  return Boolean(
    meta &&
    Math.max(meta.width, meta.height) <= hardMaxSide &&
    meta.width * meta.height <= hardMaxPixels,
  );
}

function assertImageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
): void {
  if (imageSatisfiesHardDimensionPolicy(buffer, policy)) {
    return;
  }
  const meta = readImageMetadataFromHeader(buffer);
  const detail = meta ? `: ${meta.width}x${meta.height}` : "";
  throw new Error(`Image dimensions exceed model image limits${detail}`);
}

function resolvePreservableOriginalImageContentType(params: {
  buffer: Buffer;
  cap: number;
  contentType?: string;
  policy?: ImageCompressionPolicy;
}): string | null {
  if (params.buffer.length > params.cap) {
    return null;
  }
  const declaredContentType = normalizeMimeType(params.contentType);
  const probe = readImageProbeFromHeader(params.buffer);
  const actualContentType = probe ? `image/${probe.format}` : undefined;
  if (!probe || !isPreservableImageMime(actualContentType)) {
    return null;
  }
  const declaredPreservableContentType = isPreservableImageMime(declaredContentType)
    ? declaredContentType
    : undefined;
  if (declaredPreservableContentType && declaredPreservableContentType !== actualContentType) {
    return null;
  }
  if (declaredContentType?.startsWith("image/") && !declaredPreservableContentType) {
    return null;
  }
  const preferredSide =
    resolveImageCompressionGrid(params.policy).sides[0] ?? DEFAULT_VISION_MAX_SIDE;
  if (
    Math.max(probe.width, probe.height) > preferredSide ||
    !imageSatisfiesHardDimensionPolicy(params.buffer, params.policy, probe)
  ) {
    return null;
  }
  return declaredPreservableContentType ?? actualContentType;
}

function isPreservableImageMime(
  contentType: string | undefined,
): contentType is "image/png" | "image/jpeg" | "image/webp" {
  return (
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
  );
}

export function effectiveImageBytesCap(
  baseCap: number | undefined,
  policy?: ImageCompressionPolicy,
): number | undefined {
  const policyCap = imageMaxBytesForPolicy(policy);
  if (baseCap === undefined) {
    return policyCap;
  }
  return policyCap === undefined ? baseCap : Math.min(baseCap, policyCap);
}

function buildDescendingLadder(maxSide: number, values: readonly number[]): number[] {
  const normalizedMax = Math.max(1, Math.floor(maxSide));
  const ladder = uniqueValues(
    [normalizedMax, ...values, ...LOW_IMAGE_SIDE_FALLBACKS]
      .map((value) => Math.min(normalizedMax, value))
      .filter((value) => value > 0),
  ).toSorted((a, b) => b - a);
  if (ladder.length > 1 || normalizedMax <= 1) {
    return ladder;
  }
  const fallbackLadder = [
    normalizedMax,
    Math.floor(normalizedMax * 0.75),
    Math.floor(normalizedMax * 0.5),
    Math.floor(normalizedMax * 0.25),
  ];
  return uniqueValues(fallbackLadder.filter((value) => value > 0)).toSorted((a, b) => b - a);
}

function resolveImageCompressionGrid(policy?: ImageCompressionPolicy): {
  sides: number[];
  qualities: number[];
} {
  const preference = effectiveImageQualityPreference(policy);
  const side = sideForPreference(preference, policy);
  switch (preference) {
    case "efficient":
      return {
        sides: buildDescendingLadder(side, [1024, 800]),
        qualities: [70, 60, 50, 40],
      };
    case "high":
      return {
        sides: buildDescendingLadder(side, [3072, 2576, 2048, 1800, 1536, 1280, 1024, 800]),
        qualities: [92, 85, 78, 70, 62, 52, 42],
      };
    default:
      return {
        sides: buildDescendingLadder(side, [...DEFAULT_JPEG_SIDES]),
        qualities: [...DEFAULT_JPEG_QUALITIES],
      };
  }
}

function logOptimizedImage(originalSize: number, optimized: EncodedImage): void {
  if (!shouldLogVerbose() || optimized.bytes >= originalSize) {
    return;
  }
  const resizeSide = optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height);
  if (optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMediaSize(originalSize)} to ${formatMediaSize(optimized.bytes)} (side<=${resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMediaSize(originalSize)} to ${formatMediaSize(optimized.bytes)} (side<=${resizeSide}px, q=${optimized.chosen.quality})`,
  );
}

/** Optimizes image bytes for web-media delivery while preserving accepted original formats when possible. */
export async function optimizeImageBufferForWebMedia(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  maxBytes?: number;
  imageCompression?: ImageCompressionPolicy;
  maxInputPixels?: number;
}): Promise<WebMediaResult> {
  const baseCap = params.maxBytes ?? maxBytesForKind("image");
  const cap = effectiveImageBytesCap(baseCap, params.imageCompression) ?? baseCap;
  const isAnimatedWebp = isAnimatedWebpBuffer(params.buffer);
  let originalContentType = isAnimatedWebp ? "image/webp" : (params.contentType ?? null);
  if (originalContentType === "image/gif" || isAnimatedWebp) {
    if (params.buffer.length > cap) {
      const format = isAnimatedWebp ? "Animated WebP" : "GIF";
      throw new ImageOptimizationLimitError(formatCapLimit(format, cap, params.buffer.length), cap);
    }
    assertImageSatisfiesHardDimensionPolicy(params.buffer, params.imageCompression);
  } else {
    originalContentType = resolvePreservableOriginalImageContentType({
      buffer: params.buffer,
      cap,
      contentType: params.contentType,
      policy: params.imageCompression,
    });
  }
  if (originalContentType) {
    return {
      buffer: params.buffer,
      contentType: originalContentType,
      kind: "image",
      fileName: params.fileName,
    };
  }
  const grid = resolveImageCompressionGrid(params.imageCompression);
  // Generic callers keep the shared decode limit. An owner with a bounded downscale path may
  // widen source admission explicitly, while every encoded result remains under the output cap.
  const processor = createImageProcessorWithPixelLimits({
    inputPixels: params.maxInputPixels ?? MAX_IMAGE_INPUT_PIXELS,
    outputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
  const optimized = await processor.encode(params.buffer, {
    format: "auto",
    maxBytes: cap,
    opaque: { format: "jpeg" },
    transparent: { format: "png" },
    search: { maxSide: grid.sides, quality: grid.qualities },
    transparency: "auto",
  });
  if (optimized.chosen.transparency === "flattened" && shouldLogVerbose()) {
    logVerbose(`Image transparency flattened to fit ${formatMediaSize(cap)} optimization budget`);
  }
  logOptimizedImage(params.buffer.length, optimized);
  if (optimized.data.length > cap) {
    throw new ImageOptimizationLimitError(
      formatCapReduce("Media", cap, optimized.data.length),
      cap,
    );
  }
  return {
    buffer: optimized.data,
    contentType: optimized.mimeType,
    kind: "image",
    fileName: toImageFileName(params.fileName, optimized.mimeType),
  };
}

async function loadWebMediaInternal(
  mediaUrlInput: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  let mediaUrl = mediaUrlInput;
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    proxyUrl,
    fetchImpl,
    requestInit,
    readIdleTimeoutMs,
    trustExplicitProxyDns,
    workspaceDir,
    localRoots,
    inboundRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
    hostReadCapability = false,
    documentFallback = false,
    imageCompression,
  } = options;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);
  mediaUrl = (await resolveMediaStoreUriToPath(mediaUrl)) ?? mediaUrl;
  if (/^file:/iu.test(mediaUrl)) {
    try {
      mediaUrl = safeFileURLToPath(mediaUrl);
    } catch (err) {
      throw new LocalMediaAccessError("invalid-file-url", (err as Error).message, { cause: err });
    }
  }
  mediaUrl =
    resolveCanvasHttpPathToLocalPath(mediaUrl) ??
    (await resolveHostedPluginMediaUrl(mediaUrl)) ??
    mediaUrl;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);

  const clampAndFinalize = async (params: WebMediaResult): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind ?? "document");
    const finalizeDocumentFallback = (error: unknown): WebMediaResult => {
      const documentCap = maxBytes ?? maxBytesForKind("document");
      if (params.buffer.length > documentCap) {
        throw error;
      }
      logVerbose(`media preview fallback to document: ${formatErrorMessage(error)}`);
      return {
        buffer: params.buffer,
        contentType: "application/octet-stream",
        kind: "document",
        fileName: params.fileName,
      };
    };
    if (params.kind === "image") {
      try {
        if (optimizeImages) {
          return await optimizeImageBufferForWebMedia({
            buffer: params.buffer,
            contentType: params.contentType,
            fileName: params.fileName,
            maxBytes: cap,
            imageCompression,
          });
        }
        const imageCap = effectiveImageBytesCap(cap, imageCompression) ?? cap;
        const isGif = params.contentType === "image/gif";
        if (params.buffer.length > imageCap) {
          throw new Error(formatCapLimit(isGif ? "GIF" : "Media", imageCap, params.buffer.length));
        }
        assertImageSatisfiesHardDimensionPolicy(params.buffer, imageCompression);
        return {
          buffer: params.buffer,
          contentType: params.contentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      } catch (error) {
        // Outbound attachments keep the original bytes when image preview preparation
        // cannot decode or compress them, as long as the document budget still fits.
        if (!documentFallback) {
          throw error;
        }
        return finalizeDocumentFallback(error);
      }
    }
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("Media", cap, params.buffer.length));
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
    };
  };

  // Bound source reads before buffering. Optimized images may exceed their
  // delivery cap because they are compressed before the final size check, so
  // an explicit caller cap gets image-compression headroom — sized off the
  // image cap, not the 100MB document cap, or a tight channel cap would still
  // permit a 100MB buffer from a hostile URL. Accepted tradeoff: originals
  // above the headroom fail even when they would have compressed under the
  // cap; the error names the fetch bound so the user can shrink the source.
  const defaultSourceReadCap = maxBytesForKind("document");
  const imageOptimizeHeadroom = IMAGE_OPTIMIZE_HEADROOM_FACTOR * maxBytesForKind("image");
  const sourceReadCap =
    maxBytes === undefined
      ? defaultSourceReadCap
      : optimizeImages
        ? Math.max(maxBytes, imageOptimizeHeadroom)
        : maxBytes;

  if (hasHttpUrlPrefix(mediaUrl)) {
    const dispatcherPolicy: PinnedDispatcherPolicy | undefined = proxyUrl
      ? {
          mode: "explicit-proxy",
          proxyUrl,
          allowPrivateProxy: true,
        }
      : undefined;
    const fetched = await readRemoteMediaBuffer({
      url: mediaUrl,
      fetchImpl,
      requestInit,
      readIdleTimeoutMs,
      maxBytes: sourceReadCap,
      ssrfPolicy,
      dispatcherPolicy,
      trustExplicitProxyDns,
    });
    const { buffer, contentType, fileName } = fetched;
    const kind = resolveWebMediaKind(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }
  if (workspaceDir && !path.isAbsolute(mediaUrl) && !WINDOWS_DRIVE_RE.test(mediaUrl)) {
    mediaUrl = path.resolve(workspaceDir, mediaUrl);
  }
  try {
    assertNoWindowsNetworkPath(mediaUrl, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }

  // Guard local reads against allowed directory roots to prevent file exfiltration.
  if (readFileOverride && !(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots, { inboundRoots });
  }

  let data: Buffer;
  if (readFileOverride) {
    data = await readOutboundMediaFile(readFileOverride, mediaUrl, { maxBytes: sourceReadCap });
  } else {
    try {
      data = await readLocalMediaFile(mediaUrl, localRoots, {
        ...(inboundRoots ? { inboundRoots } : {}),
        maxBytes: sourceReadCap,
      });
    } catch (err) {
      if (err instanceof FsSafeError) {
        if (err.code === "too-large") {
          throw new Error(`Media exceeds ${formatMediaSize(sourceReadCap)} limit`, {
            cause: err,
          });
        }
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError(
            "not-file",
            `Local media path is not a file: ${mediaUrl}`,
            { cause: err },
          );
        }
        if (err.code === "path-mismatch") {
          // fs-safe reports pre-open identity drift as path-mismatch; keep the
          // product-facing classification as an access denial, not a bad path.
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaUrl}`,
            { cause: err },
          );
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${mediaUrl}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  const sniffedMime = hostReadCapability ? await detectMime({ buffer: data }) : undefined;
  const detectedMime = await detectMime({ buffer: data, filePath: mediaUrl });
  const mime = hostReadCapability ? resolveHostReadMime(detectedMime, sniffedMime) : detectedMime;
  const kind = resolveWebMediaKind(mime);
  let fileName = resolveLocalMediaFileName(mediaUrl);
  if (fileName && !extnameFromAnyPath(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
  });
}

/** Loads local, remote, hosted, or media-store media and optimizes images by default. */
export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: true }),
  );
}

/** Loads local, remote, hosted, or media-store media without image optimization. */
export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: false }),
  );
}

/** Optimizes image bytes to JPEG under a target byte cap using the shared compression grid. */
export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: {
    contentType?: string;
    fileName?: string;
    imageCompression?: ImageCompressionPolicy;
  } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  const { sides, qualities } = resolveImageCompressionGrid(opts.imageCompression);
  const optimized = await createImageProcessor().encode(buffer, {
    format: "auto",
    maxBytes,
    opaque: { format: "jpeg" },
    search: {
      maxSide: sides,
      quality: qualities,
    },
    transparency: "flatten",
  });
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    quality: optimized.chosen.quality ?? qualities.at(-1) ?? 85,
  };
}

export { optimizeImageToPng } from "./media-services.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
