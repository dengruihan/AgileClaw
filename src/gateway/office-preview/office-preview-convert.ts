import { isContainerEnvironment } from "../../infra/container-environment.js";
/**
 * The single Office-to-PDF conversion owner.
 *
 * Gotenberg renders DOCX/XLSX/PPTX through LibreOffice and returns a PDF. This
 * module owns the HTTP contract only: endpoint resolution, the multipart upload,
 * bounded response drain, and the distinct failure reasons the preview states
 * expose. Cache and singleflight live in `office-preview-cache.ts`; callers use
 * `buildOfficePreviewPayload` in `office-preview.ts`.
 */
import { readResponseWithLimit } from "../../infra/http-response-body.js";
import {
  OFFICE_PREVIEW_CONVERSION_TIMEOUT_MS,
  OFFICE_PREVIEW_MAX_PDF_BYTES,
} from "./office-preview-limits.js";

/** Native installs run Gotenberg beside the Gateway; Compose uses its service name. */
const GOTENBERG_NATIVE_BASE_URL = "http://127.0.0.1:3000";
const GOTENBERG_CONTAINER_BASE_URL = "http://gotenberg:3000";

/** Gotenberg route that converts one uploaded document through LibreOffice. */
export const GOTENBERG_LIBREOFFICE_CONVERT_PATH = "/forms/libreoffice/convert";

/** Bumped whenever conversion semantics change so cached PDFs cannot go stale. */
export const OFFICE_PREVIEW_CONVERTER_VERSION = "gotenberg-9-libreoffice";

/** Why a conversion did not produce a usable PDF. */
export type OfficeConversionFailure = "unavailable" | "failed" | "too-large";

export type OfficeConversionResult = { pdf: Buffer } | { failure: OfficeConversionFailure };

/** Base URL of the conversion service for this deployment shape. */
export function resolveOfficeConverterBaseUrl(): string {
  return isContainerEnvironment() ? GOTENBERG_CONTAINER_BASE_URL : GOTENBERG_NATIVE_BASE_URL;
}

function hasPdfSignature(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

class ConvertedPdfTooLargeError extends Error {}

function multipartDocument(bytes: Buffer, filename: string): FormData {
  const form = new FormData();
  // Gotenberg reads the original name to pick the LibreOffice import filter.
  form.append("files", new Blob([new Uint8Array(bytes)]), filename);
  return form;
}

/**
 * Converts one bounded Office document to PDF.
 *
 * Connection failures, timeouts, and 5xx answers mean the service is not
 * serving; a 4xx answer or a non-PDF body means this document failed to
 * convert. Those are different user-visible states, so they stay distinct.
 */
export async function convertOfficeDocumentToPdf(params: {
  bytes: Buffer;
  filename: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OfficeConversionResult> {
  const baseUrl = (params.baseUrl ?? resolveOfficeConverterBaseUrl()).replace(/\/+$/, "");
  const url = `${baseUrl}${GOTENBERG_LIBREOFFICE_CONVERT_PATH}`;
  const timeoutMs = params.timeoutMs ?? OFFICE_PREVIEW_CONVERSION_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body: multipartDocument(params.bytes, params.filename),
      signal: timeout,
    });
  } catch {
    // Refused connection, DNS failure, and timeout all mean the service is not
    // answering within the preview budget.
    return { failure: "unavailable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { failure: response.status >= 500 ? "unavailable" : "failed" };
  }
  let pdf: Buffer;
  try {
    pdf = await readResponseWithLimit(response, OFFICE_PREVIEW_MAX_PDF_BYTES, {
      timeoutMs,
      signal: timeout,
      onOverflow: () => new ConvertedPdfTooLargeError("converted PDF exceeds the preview limit"),
    });
  } catch (error) {
    if (error instanceof ConvertedPdfTooLargeError) {
      return { failure: "too-large" };
    }
    return { failure: timeout.aborted ? "unavailable" : "failed" };
  }
  if (pdf.length === 0 || !hasPdfSignature(pdf)) {
    return { failure: "failed" };
  }
  return { pdf };
}
