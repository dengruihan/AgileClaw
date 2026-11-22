import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { t } from "../../../i18n/index.ts";
// Direct chat attachment upload client. A file whose base64 form cannot fit one
// `chat.send` frame (and whose browser string would exceed V8's string ceiling)
// streams to the Gateway in parts instead; the send then references it by ID.
import { buildChatMediaFetchHeaders } from "./chat-media-playback.ts";

export const CHAT_ATTACHMENT_UPLOAD_PATH = "/api/chat/attachments/upload";
/** Matches the Gateway part cap so each request stays small and short-lived. */
const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

export type ChatAttachmentUploadTarget = {
  basePath?: string;
  authToken?: string | null;
  sessionKey?: string;
  agentId?: string;
};

/**
 * Builds the upload target from live Control UI state. The session key is bound
 * only when the caller knows it; a brand-new draft is created later, so it binds
 * the agent and lets the send establish its own session.
 */
export function resolveChatAttachmentUploadTarget(source: {
  resourceBasePath?: string | null;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
}): ChatAttachmentUploadTarget {
  const sessionKey = source.sessionKey?.trim();
  const agentId = source.agentId?.trim();
  return {
    ...(source.resourceBasePath ? { basePath: source.resourceBasePath } : {}),
    authToken: resolveControlUiAuthToken(source),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

export type StagedChatAttachmentUpload = {
  uploadId: string;
  sizeBytes: number;
  mimeType: string;
  fileName?: string;
};

type UploadErrorBody = {
  error?: { code?: string; message?: string; receivedBytes?: number };
};

function uploadUrl(target: ChatAttachmentUploadTarget, query: URLSearchParams): string {
  const base =
    target.basePath && target.basePath !== "/" ? target.basePath.replace(/\/+$/, "") : "";
  return `${base}${CHAT_ATTACHMENT_UPLOAD_PATH}?${query.toString()}`;
}

async function postUpload(
  target: ChatAttachmentUploadTarget,
  query: URLSearchParams,
  body: Blob | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchControlUiResource(uploadUrl(target, query), {
    method: "POST",
    headers: buildChatMediaFetchHeaders(target.authToken),
    credentials: "same-origin",
    ...(body ? { body } : {}),
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | (UploadErrorBody & Record<string, unknown>)
    | null;
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `HTTP ${response.status}`) as Error & {
      code?: string;
      receivedBytes?: number;
    };
    error.code = payload?.error?.code;
    error.receivedBytes = payload?.error?.receivedBytes;
    throw error;
  }
  return payload ?? {};
}

/**
 * Streams one file to the Gateway staging store. Progress is reported per part;
 * a failed part resumes from the byte offset the Gateway reports.
 */
export async function stageChatAttachment(params: {
  file: File;
  target: ChatAttachmentUploadTarget;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<StagedChatAttachmentUpload> {
  const { file, target, signal } = params;
  const begin = new URLSearchParams({ action: "begin", sizeBytes: String(file.size) });
  if (file.name) {
    begin.set("fileName", file.name);
  }
  if (file.type) {
    begin.set("mimeType", file.type);
  }
  if (target.sessionKey) {
    begin.set("sessionKey", target.sessionKey);
  }
  if (target.agentId) {
    begin.set("agentId", target.agentId);
  }
  const started = await postUpload(target, begin, undefined, signal);
  const uploadId = typeof started.uploadId === "string" ? started.uploadId : "";
  if (!uploadId) {
    throw new Error(t("chat.attachments.readFailed", { names: file.name, more: "" }));
  }
  let offset = 0;
  while (offset < file.size) {
    signal.throwIfAborted();
    const end = Math.min(file.size, offset + UPLOAD_PART_BYTES);
    try {
      const part = await postUpload(
        target,
        new URLSearchParams({ action: "part", uploadId, offset: String(offset) }),
        file.slice(offset, end, file.type || "application/octet-stream"),
        signal,
      );
      const received = typeof part.receivedBytes === "number" ? part.receivedBytes : end;
      offset = Math.max(offset, Math.min(file.size, received));
      params.onProgress?.(offset / file.size);
    } catch (error) {
      const receivedBytes = (error as { receivedBytes?: number }).receivedBytes;
      // A transport failure or rejected part can report how much reached disk;
      // resume there once instead of re-sending the whole file.
      if (typeof receivedBytes === "number" && receivedBytes > offset) {
        offset = Math.min(file.size, receivedBytes);
        params.onProgress?.(offset / file.size);
        continue;
      }
      throw error;
    }
  }
  const committed = await postUpload(
    target,
    new URLSearchParams({ action: "commit", uploadId }),
    undefined,
    signal,
  );
  return {
    uploadId,
    sizeBytes: typeof committed.sizeBytes === "number" ? committed.sizeBytes : file.size,
    mimeType:
      typeof committed.mimeType === "string" && committed.mimeType
        ? committed.mimeType
        : file.type || "application/octet-stream",
    ...(file.name ? { fileName: file.name } : {}),
  };
}
