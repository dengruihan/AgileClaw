import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  parseOfficePreviewBufferResult,
  type OfficePreviewParseResult,
} from "./office-preview-parse.js";
import type { OfficePreviewWorkerRequest } from "./office-preview-worker.types.js";

function asRequest(input: unknown): OfficePreviewWorkerRequest | null {
  if (!isRecord(input)) {
    return null;
  }
  const format = input.format;
  const bytes = input.bytes;
  if (
    (format !== "xlsx" && format !== "docx" && format !== "pptx") ||
    !(bytes instanceof Uint8Array)
  ) {
    return null;
  }
  return { format, bytes };
}

serveWorkerTasks<OfficePreviewParseResult>((input) => {
  const request = asRequest(input);
  if (!request) {
    throw new Error("Invalid office preview request");
  }
  return parseOfficePreviewBufferResult(Buffer.from(request.bytes), request.format);
});
