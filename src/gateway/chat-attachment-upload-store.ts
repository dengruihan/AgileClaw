// Ownership of direct (out-of-band) chat attachment uploads. One `chat.send`
// frame cannot carry a multi-hundred-megabyte base64 payload: JSON expansion and
// V8's ~512Mi string ceiling make it impossible to encode in a browser. Bytes
// stream to a bounded staging file in parts, publish into the inbound media
// store on commit, and the send consumes the resulting upload ID exactly once.
//
// The upload ID is a reference only. Ordinary Gateway authority still applies,
// and every staged attachment stays bound to the authenticated owner plus the
// session and agent it was admitted for.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { saveMediaStream, type SavedMedia } from "../media/store.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { registerMediaCleanupDrain } from "./server-media-cleanup-lifecycle.js";

/** Per-part body cap; the client sends parts so no single request runs for minutes. */
export const CHAT_ATTACHMENT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
/** In-progress staging files are abandoned after an hour. */
const STAGING_TTL_MS = 60 * 60 * 1000;
/** Committed uploads wait for a send (or its recovery) for six hours. */
const COMMITTED_TTL_MS = 6 * 60 * 60 * 1000;
/** Caps concurrently staged files so abandoned uploads cannot exhaust the disk. */
const MAX_STAGED_UPLOADS = 8;

export const CHAT_ATTACHMENT_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ChatAttachmentUploadError extends Error {
  constructor(
    readonly code:
      | "invalid-request"
      | "unknown-upload"
      | "offset-mismatch"
      | "too-large"
      | "scope-mismatch"
      | "capacity",
    message: string,
    readonly receivedBytes?: number,
  ) {
    super(message);
    this.name = "ChatAttachmentUploadError";
  }
}

export type ChatAttachmentUploadScope = {
  ownerKey?: string;
  sessionKey?: string;
  agentId?: string;
};

type StagedUpload = ChatAttachmentUploadScope & {
  id: string;
  fileName?: string;
  mimeType?: string;
  declaredBytes: number;
  receivedBytes: number;
  filePath: string;
  createdAtMs: number;
  handle?: FileHandle;
};

type CommittedUpload = ChatAttachmentUploadScope & {
  id: string;
  media: SavedMedia;
  fileName?: string;
  createdAtMs: number;
};

const staged = new Map<string, StagedUpload>();
const committed = new Map<string, CommittedUpload>();
const uploadQueue = new KeyedAsyncQueue();
let stagingRootPromise: Promise<string> | undefined;
let stagingRootOverride: (() => Promise<string>) | undefined;
let cleanupRegistered = false;

function stagingRoot(): Promise<string> {
  if (stagingRootOverride) {
    return stagingRootOverride();
  }
  return (stagingRootPromise ??= (async () => {
    const root = path.join(resolvePreferredOpenClawTmpDir(), "chat-attachment-uploads");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  })().catch((error: unknown) => {
    stagingRootPromise = undefined;
    throw error;
  }));
}

type OwnerIdentity = {
  authenticatedUserProfile?: { profileId?: string } | null;
  authenticatedUserId?: string | null;
};

/**
 * Owner binding uses the verified user profile when the Gateway has one.
 * Shared-secret operator clients without a profile keep the unguessable upload
 * ID, the bound session/agent, and their ordinary Gateway authority as the
 * boundary.
 */
export function chatAttachmentUploadOwnerKey(
  identity: OwnerIdentity | undefined,
): string | undefined {
  const profileId = identity?.authenticatedUserProfile?.profileId?.trim();
  if (profileId) {
    return `profile:${profileId}`;
  }
  const userId = identity?.authenticatedUserId?.trim();
  return userId ? `user:${userId}` : undefined;
}

function assertScope(
  entry: ChatAttachmentUploadScope,
  scope: ChatAttachmentUploadScope,
  what: string,
): void {
  if (entry.ownerKey && entry.ownerKey !== scope.ownerKey) {
    throw new ChatAttachmentUploadError("scope-mismatch", `${what} belongs to another owner`);
  }
  if (entry.sessionKey && entry.sessionKey !== scope.sessionKey) {
    throw new ChatAttachmentUploadError("scope-mismatch", `${what} belongs to another session`);
  }
  if (entry.agentId && entry.agentId !== scope.agentId) {
    throw new ChatAttachmentUploadError("scope-mismatch", `${what} belongs to another agent`);
  }
}

function sweepExpired(now = Date.now()): void {
  for (const [id, entry] of staged) {
    if (now - entry.createdAtMs > STAGING_TTL_MS) {
      staged.delete(id);
      void entry.handle?.close().catch(() => undefined);
      void fs.rm(entry.filePath, { force: true }).catch(() => undefined);
    }
  }
  for (const [id, entry] of committed) {
    if (now - entry.createdAtMs > COMMITTED_TTL_MS) {
      committed.delete(id);
      void fs.rm(entry.media.path, { force: true }).catch(() => undefined);
    }
  }
}

export function assertChatAttachmentUploadId(uploadId: string | undefined): string {
  const id = uploadId?.trim();
  if (!id || !CHAT_ATTACHMENT_UPLOAD_ID_PATTERN.test(id)) {
    throw new ChatAttachmentUploadError("invalid-request", "invalid uploadId");
  }
  return id;
}

export async function beginStagedChatAttachment(params: {
  scope: ChatAttachmentUploadScope;
  declaredBytes: number;
  maxBytes: number;
  fileName?: string;
  mimeType?: string;
}): Promise<{ uploadId: string; partBytes: number }> {
  sweepExpired();
  if (staged.size >= MAX_STAGED_UPLOADS) {
    throw new ChatAttachmentUploadError(
      "capacity",
      "too many pending attachment uploads; finish or discard one first",
    );
  }
  if (!Number.isSafeInteger(params.declaredBytes) || params.declaredBytes < 1) {
    throw new ChatAttachmentUploadError("invalid-request", "sizeBytes must be a positive integer");
  }
  if (params.declaredBytes > params.maxBytes) {
    throw new ChatAttachmentUploadError(
      "too-large",
      `attachment exceeds size limit (${params.declaredBytes} > ${params.maxBytes} bytes)`,
    );
  }
  const id = randomUUID();
  const filePath = path.join(await stagingRoot(), `${id}.part`);
  const handle = await fs.open(filePath, "wx", 0o600);
  staged.set(id, {
    id,
    ...params.scope,
    ...(params.fileName ? { fileName: params.fileName } : {}),
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    declaredBytes: params.declaredBytes,
    receivedBytes: 0,
    filePath,
    createdAtMs: Date.now(),
    handle,
  });
  return { uploadId: id, partBytes: CHAT_ATTACHMENT_UPLOAD_PART_BYTES };
}

export async function writeStagedChatAttachmentPart(params: {
  uploadId: string;
  offset: number;
  stream: AsyncIterable<unknown>;
  scope: ChatAttachmentUploadScope;
  maxBytes: number;
}): Promise<{ uploadId: string; receivedBytes: number }> {
  sweepExpired();
  const id = assertChatAttachmentUploadId(params.uploadId);
  const entry = staged.get(id);
  if (!entry) {
    throw new ChatAttachmentUploadError(
      "unknown-upload",
      "attachment upload is unknown or expired",
    );
  }
  assertScope(entry, params.scope, "attachment upload");
  if (params.offset !== entry.receivedBytes) {
    throw new ChatAttachmentUploadError(
      "offset-mismatch",
      `offset does not match received bytes (${entry.receivedBytes})`,
      entry.receivedBytes,
    );
  }
  const handle = entry.handle ?? (await fs.open(entry.filePath, "a", 0o600));
  entry.handle = handle;
  let partBytes = 0;
  try {
    for await (const chunk of params.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (buffer.byteLength === 0) {
        continue;
      }
      // Actual bytes are the authority; the declared size only bounds it earlier.
      if (
        entry.receivedBytes + partBytes + buffer.byteLength > params.maxBytes ||
        entry.receivedBytes + partBytes + buffer.byteLength > entry.declaredBytes
      ) {
        throw new ChatAttachmentUploadError(
          "too-large",
          `attachment exceeds its declared or configured size limit (${entry.declaredBytes} bytes)`,
          entry.receivedBytes + partBytes,
        );
      }
      await handle.write(buffer);
      partBytes += buffer.byteLength;
    }
  } catch (error) {
    // Keep bytes already durably written; the client resumes from this offset.
    entry.receivedBytes += partBytes;
    if (error instanceof ChatAttachmentUploadError) {
      throw error;
    }
    throw new ChatAttachmentUploadError(
      "invalid-request",
      "attachment upload was interrupted",
      entry.receivedBytes,
    );
  }
  entry.receivedBytes += partBytes;
  return { uploadId: id, receivedBytes: entry.receivedBytes };
}

export async function commitStagedChatAttachment(params: {
  uploadId: string;
  scope: ChatAttachmentUploadScope;
  maxBytes: number;
  assertCommitAllowed?: () => void;
}): Promise<{ uploadId: string; sizeBytes: number; mimeType: string; fileName?: string }> {
  sweepExpired();
  const id = assertChatAttachmentUploadId(params.uploadId);
  const entry = staged.get(id);
  if (!entry) {
    throw new ChatAttachmentUploadError(
      "unknown-upload",
      "attachment upload is unknown or expired",
    );
  }
  assertScope(entry, params.scope, "attachment upload");
  if (entry.receivedBytes !== entry.declaredBytes) {
    throw new ChatAttachmentUploadError(
      "offset-mismatch",
      `attachment upload is incomplete (${entry.receivedBytes}/${entry.declaredBytes} bytes)`,
      entry.receivedBytes,
    );
  }
  await entry.handle?.close().catch(() => undefined);
  entry.handle = undefined;
  params.assertCommitAllowed?.();
  // A failed publication keeps the staging file so the client can retry commit.
  const media = await saveMediaStream(
    createReadStream(entry.filePath),
    entry.mimeType,
    "inbound",
    params.maxBytes,
    entry.fileName,
    undefined,
    { assertCommitAllowed: params.assertCommitAllowed },
  );
  if (media.size !== entry.declaredBytes) {
    // A partially written chunk must not publish bytes the client never declared.
    await fs.rm(media.path, { force: true }).catch(() => undefined);
    throw new ChatAttachmentUploadError(
      "offset-mismatch",
      `attachment upload size does not match its declaration (${media.size}/${entry.declaredBytes} bytes)`,
      entry.receivedBytes,
    );
  }
  staged.delete(id);
  await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
  committed.set(id, {
    id,
    media,
    ...(entry.ownerKey ? { ownerKey: entry.ownerKey } : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
    createdAtMs: Date.now(),
  });
  return {
    uploadId: id,
    sizeBytes: media.size,
    mimeType: media.contentType ?? "application/octet-stream",
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
  };
}

/**
 * Resolves and consumes a committed upload. The media file keeps belonging to
 * the message after consumption, so only unconsumed entries are ever removed.
 */
export function consumeStagedChatAttachment(
  uploadId: string,
  scope: ChatAttachmentUploadScope,
  options: { maxBytes: number },
): SavedMedia & { fileName?: string } {
  sweepExpired();
  const id = assertChatAttachmentUploadId(uploadId);
  const entry = committed.get(id);
  if (!entry) {
    throw new ChatAttachmentUploadError(
      "unknown-upload",
      "attachment upload is unknown, expired, or already used",
    );
  }
  assertScope(entry, scope, "attachment upload");
  if (entry.media.size > options.maxBytes) {
    throw new ChatAttachmentUploadError(
      "too-large",
      `attachment ${entry.fileName ?? id}: exceeds size limit (${entry.media.size} > ${options.maxBytes} bytes)`,
    );
  }
  committed.delete(id);
  return { ...entry.media, ...(entry.fileName ? { fileName: entry.fileName } : {}) };
}

/** Drops staging and committed bytes that no message will reference. */
export async function discardChatAttachmentUploads(): Promise<void> {
  const files = [
    ...[...staged.values()].map((entry) => entry.filePath),
    ...[...committed.values()].map((entry) => entry.media.path),
  ];
  for (const entry of staged.values()) {
    void entry.handle?.close().catch(() => undefined);
  }
  staged.clear();
  committed.clear();
  await Promise.allSettled(files.map((filePath) => fs.rm(filePath, { force: true })));
}

/** Removes staging bytes on Gateway shutdown; committed uploads belong to the media store. */
export function registerChatAttachmentUploadCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  registerMediaCleanupDrain(
    discardChatAttachmentUploads().finally(() => {
      stagingRootPromise = undefined;
    }),
  );
}

export function resetChatAttachmentUploadsForTests(options?: {
  stagingRoot?: () => Promise<string>;
}): void {
  staged.clear();
  committed.clear();
  stagingRootOverride = options?.stagingRoot;
  stagingRootPromise = undefined;
  cleanupRegistered = false;
}

/** Serializes part and commit mutations per upload. */
export function runStagedChatAttachmentMutation<T>(
  uploadId: string,
  task: () => Promise<T>,
): Promise<T> {
  return uploadQueue.enqueue(uploadId, task);
}
