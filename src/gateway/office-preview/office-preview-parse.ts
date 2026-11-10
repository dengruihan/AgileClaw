/**
 * Office preview parser dispatch.
 *
 * One owner selects the reader for a validated OOXML package and keeps the
 * degraded states distinct: a corrupt package, a wrong-family package, and an
 * encrypted package must not collapse into the same caller state. Parsers are
 * read-only and run in the worker that owns OOXML inflation.
 */
import type {
  SessionFileOfficeFormat,
  SessionFileOfficePreview,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseDocument } from "./office-preview-docx.js";
import { parsePresentation } from "./office-preview-pptx.js";
import { parseSpreadsheet } from "./office-preview-xlsx.js";
import { OfficeArchiveError, OfficeZipArchive } from "./office-preview-zip.js";

/** Why a package could not produce a structured preview. */
export type OfficePreviewParseFailure = "invalid" | "password-protected";

export type OfficePreviewParseResult =
  | { preview: SessionFileOfficePreview }
  | { failure: OfficePreviewParseFailure };

function selectPreview(
  archive: OfficeZipArchive,
  format: SessionFileOfficeFormat,
): SessionFileOfficePreview | null {
  if (format === "xlsx") {
    return parseSpreadsheet(archive);
  }
  if (format === "docx") {
    return parseDocument(archive);
  }
  return parsePresentation(archive);
}

/** Parses one validated OOXML buffer and keeps degraded reasons distinct. */
export function parseOfficePreviewBufferResult(
  buffer: Buffer,
  format: SessionFileOfficeFormat,
): OfficePreviewParseResult {
  let archive: OfficeZipArchive;
  try {
    archive = new OfficeZipArchive(buffer);
  } catch (error) {
    return {
      failure:
        error instanceof OfficeArchiveError && error.reason === "encrypted"
          ? "password-protected"
          : "invalid",
    };
  }
  try {
    const preview = selectPreview(archive, format);
    // A valid ZIP without the expected family part is a mislabelled package.
    return preview ? { preview } : { failure: "invalid" };
  } catch {
    return { failure: "invalid" };
  }
}

/** Parses one validated OOXML buffer; null keeps the metadata-only preview path. */
export function parseOfficePreviewBuffer(
  buffer: Buffer,
  format: SessionFileOfficeFormat,
): SessionFileOfficePreview | null {
  const result = parseOfficePreviewBufferResult(buffer, format);
  return "preview" in result ? result.preview : null;
}
