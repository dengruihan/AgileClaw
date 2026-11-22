// Protocol owner for direct chat attachment uploads. One WebSocket frame cannot
// carry a multi-hundred-megabyte base64 payload, so files above that budget are
// sent as parts to the Gateway staging route and referenced by upload ID.
//
// The UI supplies the transport (auth headers, same-origin credentials) and the
// composed scope is repeated on every request: begin binds it, part and commit
// must present the same session/agent or the Gateway rejects them.
export const CHAT_ATTACHMENT_UPLOAD_PATH = "/api/chat/attachments/upload";

/** Fallback part size; the Gateway's begin response is authoritative. */
export const CHAT_ATTACHMENT_UPLOAD_FALLBACK_PART_BYTES = 16 * 1024 * 1024;

export type ChatAttachmentUploadScope = {
  sessionKey?: string;
  agentId?: string;
};

export type ChatAttachmentUploadRequest = {
  url: string;
  body?: Blob;
  signal: AbortSignal;
};

export type ChatAttachmentUploadResponse = {
  status: number;
  body: unknown;
};

export type ChatAttachmentUploadSender = (
  request: ChatAttachmentUploadRequest,
) => Promise<ChatAttachmentUploadResponse>;

export class ChatAttachmentUploadClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly receivedBytes?: number,
  ) {
    super(message);
    this.name = "ChatAttachmentUploadClientError";
  }
}

export type StagedChatAttachmentUpload = {
  uploadId: string;
  sizeBytes: number;
  mimeType: string;
  fileName?: string;
};

function scopedQuery(
  query: Record<string, string | number | undefined>,
  scope: ChatAttachmentUploadScope | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  if (scope?.sessionKey) {
    params.set("sessionKey", scope.sessionKey);
  }
  if (scope?.agentId) {
    params.set("agentId", scope.agentId);
  }
  return params;
}

export function buildChatAttachmentUploadUrl(params: {
  basePath?: string | null;
  query: Record<string, string | number | undefined>;
  scope?: ChatAttachmentUploadScope;
}): string {
  const base =
    params.basePath && params.basePath !== "/" ? params.basePath.replace(/\/+$/, "") : "";
  return `${base}${CHAT_ATTACHMENT_UPLOAD_PATH}?${scopedQuery(params.query, params.scope).toString()}`;
}

function errorFromResponse(
  response: ChatAttachmentUploadResponse,
): ChatAttachmentUploadClientError {
  const body = response.body && typeof response.body === "object" ? response.body : {};
  const error = (body as { error?: unknown }).error;
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : `http-${response.status}`;
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : `attachment upload failed (HTTP ${response.status})`;
  const receivedBytes =
    typeof record.receivedBytes === "number" && Number.isFinite(record.receivedBytes)
      ? record.receivedBytes
      : undefined;
  return new ChatAttachmentUploadClientError(code, message, receivedBytes);
}

function readNumber(body: unknown, key: string): number | undefined {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(body: unknown, key: string): string | undefined {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Streams one file to the Gateway staging route and returns its committed
 * reference. A rejected or interrupted part resumes from the offset the
 * Gateway reports, so a transport retry never re-sends confirmed bytes.
 */
export async function uploadChatAttachmentInParts(params: {
  basePath?: string | null;
  file: Blob;
  sizeBytes: number;
  mimeType?: string;
  fileName?: string;
  scope?: ChatAttachmentUploadScope;
  signal: AbortSignal;
  send: ChatAttachmentUploadSender;
  onProgress?: (fraction: number) => void;
}): Promise<StagedChatAttachmentUpload> {
  const { file, signal } = params;
  const sizeBytes = params.sizeBytes;
  const post = async (
    query: Record<string, string | number | undefined>,
    body?: Blob,
  ): Promise<ChatAttachmentUploadResponse> => {
    signal.throwIfAborted();
    const response = await params.send({
      url: buildChatAttachmentUploadUrl({
        basePath: params.basePath,
        query,
        scope: params.scope,
      }),
      ...(body ? { body } : {}),
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw errorFromResponse(response);
    }
    return response;
  };

  const begin = await post({
    action: "begin",
    sizeBytes,
    fileName: params.fileName,
    mimeType: params.mimeType,
  });
  const uploadId = readString(begin.body, "uploadId");
  if (!uploadId) {
    throw new ChatAttachmentUploadClientError(
      "invalid-response",
      "attachment upload was not accepted",
    );
  }
  const partBytes = readNumber(begin.body, "partBytes");
  const partSize =
    partBytes && partBytes > 0
      ? Math.min(partBytes, sizeBytes || partBytes)
      : CHAT_ATTACHMENT_UPLOAD_FALLBACK_PART_BYTES;
  let offset = 0;
  let resumedAt = -1;
  while (offset < sizeBytes) {
    signal.throwIfAborted();
    const end = Math.min(sizeBytes, offset + partSize);
    try {
      const part = await post(
        { action: "part", uploadId, offset },
        file.slice(offset, end, params.mimeType || "application/octet-stream"),
      );
      const received = readNumber(part.body, "receivedBytes") ?? end;
      offset = Math.max(offset, Math.min(sizeBytes, received));
      params.onProgress?.(sizeBytes > 0 ? offset / sizeBytes : 1);
    } catch (error) {
      const receivedBytes =
        error instanceof ChatAttachmentUploadClientError ? error.receivedBytes : undefined;
      if (
        typeof receivedBytes === "number" &&
        receivedBytes > offset &&
        receivedBytes <= sizeBytes &&
        receivedBytes !== resumedAt
      ) {
        // Resume once from the offset the Gateway confirmed on disk.
        resumedAt = receivedBytes;
        offset = receivedBytes;
        params.onProgress?.(sizeBytes > 0 ? offset / sizeBytes : 1);
        continue;
      }
      throw error;
    }
  }
  const committed = await post({ action: "commit", uploadId });
  return {
    uploadId,
    sizeBytes: readNumber(committed.body, "sizeBytes") ?? sizeBytes,
    mimeType:
      readString(committed.body, "mimeType") ?? params.mimeType ?? "application/octet-stream",
    ...(params.fileName ? { fileName: params.fileName } : {}),
  };
}
