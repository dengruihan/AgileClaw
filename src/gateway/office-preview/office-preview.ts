import type {
  SessionFileOfficeFormat,
  SessionFileOfficePreview,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { OFFICE_PREVIEW_MAX_BYTES, OFFICE_PREVIEW_TIMEOUT_MS } from "./office-preview-limits.js";
import type {
  OfficePreviewParseFailure,
  OfficePreviewParseResult,
} from "./office-preview-parse.js";
import type { OfficePreviewWorkerRequest } from "./office-preview-worker.types.js";

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

/** Reader outcome: a structured preview or a distinct degraded reason. */
export type OfficePreviewReadResult =
  | { preview: SessionFileOfficePreview }
  | { failure: OfficePreviewParseFailure };

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
export function resolveOfficePreviewFormatForMime(
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
export function isLegacyOfficeMimeType(mimeType: string | undefined): boolean {
  const normalized = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return Boolean(normalized && Object.hasOwn(LEGACY_OFFICE_MIME_TYPES, normalized));
}

/** Detected package MIME type for a modern Office format. */
export function officeMimeTypeForFormat(format: SessionFileOfficeFormat): string {
  return MODERN_OFFICE_MIME_TYPES[format];
}

let pool: WorkerTaskPool<OfficePreviewWorkerRequest, OfficePreviewParseResult> | undefined;

function parsePool(): WorkerTaskPool<OfficePreviewWorkerRequest, OfficePreviewParseResult> {
  pool ??= new WorkerTaskPool<OfficePreviewWorkerRequest, OfficePreviewParseResult>({
    workerUrl: resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "office-preview.worker",
      distWorkerPath: "gateway/office-preview/office-preview.worker.js",
    }),
    // One parser keeps peak inflation memory bounded; extra previews queue.
    maxWorkers: 1,
    sharedCompute: true,
    maxPendingTasks: 16,
    maxPendingBytes: 2 * OFFICE_PREVIEW_MAX_BYTES,
  });
  return pool;
}

function isParseResult(
  value: unknown,
  format: SessionFileOfficeFormat,
): value is OfficePreviewParseResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  if ("failure" in value) {
    return (
      value.failure === "invalid" ||
      value.failure === "password-protected" ||
      value.failure === "too-large"
    );
  }
  if (!("preview" in value)) {
    return false;
  }
  const preview = value.preview;
  return Boolean(
    preview && typeof preview === "object" && "format" in preview && preview.format === format,
  );
}

/**
 * Parses one Office buffer in the worker that owns OOXML inflation.
 *
 * Degraded reasons are preserved so callers can distinguish an encrypted
 * package from a corrupt one; transport failures degrade to `invalid`.
 */
export async function readOfficePreviewResult(
  buffer: Buffer,
  format: SessionFileOfficeFormat,
  options?: { workerUrl?: URL },
): Promise<OfficePreviewReadResult> {
  const runPool = options?.workerUrl
    ? new WorkerTaskPool<OfficePreviewWorkerRequest, OfficePreviewParseResult>({
        workerUrl: options.workerUrl,
        maxWorkers: 1,
      })
    : parsePool();
  try {
    const result = await runPool.run(
      { format, bytes: buffer },
      { timeoutMs: OFFICE_PREVIEW_TIMEOUT_MS, inputBytes: buffer.byteLength },
    );
    return isParseResult(result, format) ? result : { failure: "invalid" };
  } catch {
    return { failure: "invalid" };
  } finally {
    if (options?.workerUrl) {
      await runPool.close();
    }
  }
}

/**
 * Parses one Office buffer and returns its structured preview, or null for
 * every degraded path (corrupt archive, unsupported package, timeout,
 * overloaded pool) so callers render the metadata-only preview.
 */
export async function readOfficePreview(
  buffer: Buffer,
  format: SessionFileOfficeFormat,
  options?: { workerUrl?: URL },
): Promise<SessionFileOfficePreview | null> {
  const result = await readOfficePreviewResult(buffer, format, options);
  return "preview" in result ? result.preview : null;
}
