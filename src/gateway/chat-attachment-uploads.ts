// HTTP intake for direct chat attachment uploads. The store owns staging,
// consumption, and cleanup; this module owns request authentication, the scope
// it binds an upload to, and the wire response.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SaveMediaSourceError } from "../media/store.shared.js";
import { resolveChatAttachmentMaxBytes } from "./chat-attachment-policy.js";
import {
  beginStagedChatAttachment,
  ChatAttachmentUploadError,
  chatAttachmentUploadOwnerKey,
  commitStagedChatAttachment,
  type ChatAttachmentUploadScope,
  runStagedChatAttachmentMutation,
  writeStagedChatAttachmentPart,
} from "./chat-attachment-upload-store.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";
import { areGatewayUploadsEnabled, GATEWAY_UPLOADS_DISABLED_MESSAGE } from "./upload-policy.js";

export const CHAT_ATTACHMENT_UPLOAD_PATH = "/api/chat/attachments/upload";

const ERROR_STATUS: Record<ChatAttachmentUploadError["code"], number> = {
  "invalid-request": 400,
  "unknown-upload": 404,
  "offset-mismatch": 409,
  "too-large": 413,
  "part-too-large": 413,
  "scope-mismatch": 403,
  capacity: 503,
  "shutting-down": 503,
};

function readQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function parseSize(value: string | undefined): number {
  const size = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ChatAttachmentUploadError("invalid-request", "sizeBytes must be a positive integer");
  }
  return size;
}

export type ChatAttachmentUploadHttpOptions = GatewayHttpRequestAuthOptions & {
  basePath?: string;
};

export async function handleChatAttachmentUploadHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ChatAttachmentUploadHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const basePath = opts.basePath && opts.basePath !== "/" ? opts.basePath.replace(/\/+$/, "") : "";
  if (
    url.pathname !== `${basePath}${CHAT_ATTACHMENT_UPLOAD_PATH}` &&
    url.pathname !== CHAT_ATTACHMENT_UPLOAD_PATH
  ) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }
  // Control UI HTTP surfaces authenticate with the same cookie/device-token
  // path as their other requests; the upload additionally needs the write
  // authority that `chat.send` implies.
  const requestAuth = await authorizeControlUiReadRequestOrReply({
    ...opts,
    req,
    res,
    requiredOperatorMethod: "chat.send",
  });
  if (!requestAuth) {
    return true;
  }
  const cfg: OpenClawConfig | undefined = (opts.getRuntimeConfig ?? (() => opts.cfg))();
  if (!areGatewayUploadsEnabled(cfg)) {
    sendJson(res, 403, {
      error: { code: "UPLOADS_DISABLED", message: GATEWAY_UPLOADS_DISABLED_MESSAGE },
    });
    return true;
  }
  const maxBytes = cfg ? resolveChatAttachmentMaxBytes(cfg) : Number.MAX_SAFE_INTEGER;
  const scope: ChatAttachmentUploadScope = {
    ownerKey: chatAttachmentUploadOwnerKey({
      authenticatedUserProfile: requestAuth.authenticatedUserProfile,
    }),
    ...(readQuery(url, "sessionKey") ? { sessionKey: readQuery(url, "sessionKey") } : {}),
    ...(readQuery(url, "agentId") ? { agentId: readQuery(url, "agentId") } : {}),
  };
  const assertCommitAllowed = () => {
    if (requestAuth.hasCurrentClientAuthority?.() === false) {
      throw new ChatAttachmentUploadError(
        "scope-mismatch",
        "Gateway requester authority changed during upload",
      );
    }
  };
  const action = readQuery(url, "action") ?? "begin";
  const uploadId = readQuery(url, "uploadId") ?? "";
  const offset = readQuery(url, "offset");
  try {
    // Every begin shares one lane so the staged/committed capacity check cannot
    // race; part and commit mutations stay serialized per upload.
    const queueKey = action === "begin" ? "begin" : uploadId || "missing";
    const result = await runStagedChatAttachmentMutation(queueKey, async () => {
      switch (action) {
        case "begin":
          return await beginStagedChatAttachment({
            scope,
            declaredBytes: parseSize(readQuery(url, "sizeBytes")),
            maxBytes,
            ...(readQuery(url, "fileName") ? { fileName: readQuery(url, "fileName") } : {}),
            ...(readQuery(url, "mimeType") ? { mimeType: readQuery(url, "mimeType") } : {}),
          });
        case "part": {
          if (!offset || !/^\d+$/.test(offset)) {
            throw new ChatAttachmentUploadError(
              "invalid-request",
              "offset must be a non-negative integer",
            );
          }
          return await writeStagedChatAttachmentPart({
            uploadId,
            offset: Number(offset),
            stream: req,
            scope,
            maxBytes,
          });
        }
        case "commit":
          assertCommitAllowed();
          return await commitStagedChatAttachment({
            uploadId,
            scope,
            maxBytes,
            assertCommitAllowed,
          });
        default:
          throw new ChatAttachmentUploadError("invalid-request", "unknown upload action");
      }
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (res.destroyed || res.writableEnded) {
      return true;
    }
    if (error instanceof ChatAttachmentUploadError) {
      const status = ERROR_STATUS[error.code];
      if (action !== "begin") {
        // Unread request bytes cannot be resumed on a kept-alive socket.
        res.shouldKeepAlive = false;
      }
      sendJson(res, status, {
        error: {
          code: error.code,
          message: error.message,
          ...(error.receivedBytes === undefined ? {} : { receivedBytes: error.receivedBytes }),
        },
      });
      return true;
    }
    if (error instanceof SaveMediaSourceError && error.code === "too-large") {
      res.shouldKeepAlive = false;
      sendJson(res, 413, {
        error: {
          code: "too-large",
          message: `attachment exceeds size limit (${maxBytes} bytes)`,
        },
      });
      return true;
    }
    sendJson(res, 500, {
      error: { code: "upload-failed", message: "attachment upload failed" },
    });
  }
  return true;
}
