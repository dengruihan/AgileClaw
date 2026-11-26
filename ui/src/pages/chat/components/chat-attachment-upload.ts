// Direct chat attachment upload client. A file whose base64 form cannot fit one
// `chat.send` frame (and whose browser string would exceed V8's string ceiling)
// streams to the Gateway in parts instead; the send then references it by ID.
import {
  ChatAttachmentUploadClientError,
  discardChatAttachmentUpload,
  uploadChatAttachmentInParts,
  type ChatAttachmentUploadResponse,
  type ChatAttachmentUploadScope,
  type StagedChatAttachmentUpload,
} from "../../../../../src/shared/chat-attachment-upload-client.ts";
import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { buildChatMediaFetchHeaders } from "./chat-media-playback.ts";

export { CHAT_ATTACHMENT_UPLOAD_PATH } from "../../../../../src/shared/chat-attachment-upload-client.ts";
export type { StagedChatAttachmentUpload };

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

async function postUpload(
  target: ChatAttachmentUploadTarget,
  request: { url: string; body?: Blob; signal: AbortSignal },
): Promise<ChatAttachmentUploadResponse> {
  const response = await fetchControlUiResource(request.url, {
    method: "POST",
    headers: buildChatMediaFetchHeaders(target.authToken),
    credentials: "same-origin",
    ...(request.body ? { body: request.body } : {}),
    signal: request.signal,
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

function uploadScope(target: ChatAttachmentUploadTarget): ChatAttachmentUploadScope {
  return {
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    ...(target.agentId ? { agentId: target.agentId } : {}),
  };
}

/**
 * Streams one file to the Gateway staging store. Progress is reported per part;
 * a part whose response was lost resumes from the byte offset the Gateway
 * reports, while a cancelled or broken transfer releases its capacity instead.
 */
export async function stageChatAttachment(params: {
  file: File;
  target: ChatAttachmentUploadTarget;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<StagedChatAttachmentUpload> {
  const { file, target, signal } = params;
  try {
    return await uploadChatAttachmentInParts({
      basePath: target.basePath,
      file,
      sizeBytes: file.size,
      mimeType: file.type || "application/octet-stream",
      ...(file.name ? { fileName: file.name } : {}),
      scope: uploadScope(target),
      signal,
      send: (request) => postUpload(target, request),
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  } catch (error) {
    // jsdom and browsers disagree on whether AbortError extends Error; keep the
    // abort identity so callers can tell cancellation from a failed transfer.
    if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
      throw error;
    }
    if (error instanceof ChatAttachmentUploadClientError) {
      throw new Error(error.message, { cause: error });
    }
    if (error instanceof Error && error.message) {
      throw error;
    }
    throw new Error(t("chat.attachments.readFailed", { names: file.name, more: "" }), {
      cause: error,
    });
  }
}

/**
 * Releases the Gateway capacity an attachment the user removed before sending
 * still holds — its in-progress bytes or its uploaded-but-unsent file. Removing
 * the slot already dropped the only reference, so this stays best effort and
 * silent: the Gateway also drops an interrupted transfer itself, and a release
 * failure must not surface as a new upload error.
 */
export function releaseChatAttachmentUpload(
  attachment: Pick<ChatAttachment, "uploadId">,
  target: ChatAttachmentUploadTarget | undefined,
): void {
  const uploadId = attachment.uploadId?.trim();
  if (!uploadId || !target) {
    return;
  }
  void discardChatAttachmentUpload({
    basePath: target.basePath,
    uploadId,
    scope: uploadScope(target),
    send: (request) => postUpload(target, request),
  }).catch(() => undefined);
}
