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
import { settlesWithin } from "../shared/settle-within.js";

/** Per-part body cap; the client sends parts so no single request runs for minutes. */
export const CHAT_ATTACHMENT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
/** In-progress staging files are abandoned after an hour. */
const STAGING_TTL_MS = 60 * 60 * 1000;
/** Committed uploads wait for a send (or its recovery) for six hours. */
const COMMITTED_TTL_MS = 6 * 60 * 60 * 1000;
/** Caps concurrently staged files so abandoned uploads cannot exhaust the disk. */
const MAX_STAGED_UPLOADS = 8;
/** Caps committed-but-unsent uploads, which keep their published media. */
const MAX_COMMITTED_UPLOADS = 12;
/** Caps unsent bytes (staged reservations plus published media) for this owner. */
const MAX_UNSENT_BYTES = 4 * 1024 * 1024 * 1024;
/** Bounds how long shutdown waits for in-flight upload mutations to settle. */
const MUTATION_DRAIN_TIMEOUT_MS = 5_000;

export const CHAT_ATTACHMENT_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ChatAttachmentUploadError extends Error {
  constructor(
    readonly code:
      | "invalid-request"
      | "unknown-upload"
      | "offset-mismatch"
      | "too-large"
      | "part-too-large"
      | "scope-mismatch"
      | "capacity"
      | "shutting-down",
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
  /** Admission generation that owns this entry and its staging file. */
  generation: number;
  fileName?: string;
  mimeType?: string;
  declaredBytes: number;
  receivedBytes: number;
  /** Part ceiling advertised at begin; the server enforces the same value. */
  partBytes: number;
  filePath: string;
  createdAtMs: number;
  handle?: FileHandle;
};

type CommittedUpload = ChatAttachmentUploadScope & {
  id: string;
  /** Admission generation that published this entry's media. */
  generation: number;
  media: SavedMedia;
  fileName?: string;
  createdAtMs: number;
};

const staged = new Map<string, StagedUpload>();
const committed = new Map<string, CommittedUpload>();
const uploadQueue = new KeyedAsyncQueue();
const activeMutations = new Set<Promise<unknown>>();
/** Shutdown fence: set before the final discard so no new upload can be admitted. */
let closing = false;
/**
 * Admission generation. Bumped whenever the fence opens or closes, so an
 * operation admitted before a maintenance restart cannot publish into the new
 * generation's maps.
 */
let admissionGeneration = 0;
let stagingRootPromise: Promise<string> | undefined;
let stagingRootOverride: (() => Promise<string>) | undefined;

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

function committedBytes(): number {
  let total = 0;
  for (const entry of committed.values()) {
    total += entry.media.size;
  }
  return total;
}

/** Removes one staged entry and its file, dropping the slot it reserved. */
async function releaseStagedUpload(entry: StagedUpload): Promise<void> {
  if (staged.get(entry.id) === entry) {
    staged.delete(entry.id);
  }
  const handle = entry.handle;
  entry.handle = undefined;
  await handle?.close().catch(() => undefined);
  await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
}

/** Removes one committed-but-unsent entry and its published media. */
async function releaseCommittedUpload(entry: CommittedUpload): Promise<void> {
  if (committed.get(entry.id) === entry) {
    committed.delete(entry.id);
  }
  await fs.rm(entry.media.path, { force: true }).catch(() => undefined);
}

/**
 * Bytes this owner has reserved but not yet sent: published media plus the
 * declared size of every in-progress staging file. Counted together so
 * concurrent begins cannot exceed the unsent-byte ceiling.
 */
function reservedBytes(): number {
  let total = committedBytes();
  for (const entry of staged.values()) {
    total += entry.declaredBytes;
  }
  return total;
}

function assertUploadsOpen(admittedGeneration?: number): void {
  if (closing || (admittedGeneration !== undefined && admittedGeneration !== admissionGeneration)) {
    throw new ChatAttachmentUploadError(
      "shutting-down",
      "attachment uploads are closing; retry after the Gateway restarts",
    );
  }
}

function currentAdmissionGeneration(): number {
  assertUploadsOpen();
  return admissionGeneration;
}

async function sweepExpired(now = Date.now()): Promise<void> {
  for (const [id, entry] of staged) {
    if (now - entry.createdAtMs > STAGING_TTL_MS) {
      staged.delete(id);
      await entry.handle?.close().catch(() => undefined);
      await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
    }
  }
  for (const [id, entry] of committed) {
    if (now - entry.createdAtMs > COMMITTED_TTL_MS) {
      committed.delete(id);
      await fs.rm(entry.media.path, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Staging files survive a crash, so the first maintenance run of a new process
 * removes anything past its TTL that no live upload owns.
 */
async function sweepOrphanedStagingFiles(now = Date.now()): Promise<void> {
  const root = await stagingRoot().catch(() => undefined);
  if (!root) {
    return;
  }
  const names = await fs.readdir(root).catch(() => [] as string[]);
  await Promise.allSettled(
    names.map(async (name) => {
      if (!name.endsWith(".part") || staged.has(name.slice(0, -".part".length))) {
        return;
      }
      const filePath = path.join(root, name);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (stat && now - stat.mtimeMs > STAGING_TTL_MS) {
        await fs.rm(filePath, { force: true });
      }
    }),
  );
}

export function assertChatAttachmentUploadId(uploadId: string | undefined): string {
  const id = uploadId?.trim();
  if (!id || !CHAT_ATTACHMENT_UPLOAD_ID_PATTERN.test(id)) {
    throw new ChatAttachmentUploadError("invalid-request", "invalid uploadId");
  }
  return id;
}

/**
 * Activation for a maintenance generation. It never retires admissions of an
 * already-open store; it only reopens a fenced store, and only after any prior
 * generation's shutdown and final discard settled. The owner's signal is the
 * activation's cancellation: a stop that arrives while this waits prevents the
 * reopen, so a stopped owner can never leave the store open after its drain.
 */
export async function startChatAttachmentUploadMaintenance(options?: {
  signal?: AbortSignal;
}): Promise<boolean> {
  for (let pending = shutdownInFlight; pending; pending = shutdownInFlight) {
    await pending.catch(() => undefined);
  }
  // Revalidate immediately before the synchronous transition: no await may
  // follow, so a stop cannot interleave between the check and the reopen.
  if (options?.signal?.aborted) {
    return false;
  }
  if (!closing) {
    return false;
  }
  closing = false;
  admissionGeneration += 1;
  return true;
}

/**
 * Periodic maintenance: expires abandoned staging and unsent media, and clears
 * staging files a previous process left behind. The Gateway maintenance owner
 * schedules it and owns its stop.
 */
export async function runChatAttachmentUploadMaintenance(): Promise<void> {
  await sweepExpired();
  await sweepOrphanedStagingFiles();
}

export async function beginStagedChatAttachment(params: {
  scope: ChatAttachmentUploadScope;
  declaredBytes: number;
  maxBytes: number;
  fileName?: string;
  mimeType?: string;
  partBytes?: number;
}): Promise<{ uploadId: string; partBytes: number }> {
  const generation = currentAdmissionGeneration();
  await sweepExpired();
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
  if (
    committed.size + staged.size >= MAX_COMMITTED_UPLOADS ||
    reservedBytes() + params.declaredBytes > MAX_UNSENT_BYTES
  ) {
    throw new ChatAttachmentUploadError(
      "capacity",
      "too many attachment uploads are waiting to be sent; retry after sending or discarding one",
    );
  }
  const id = randomUUID();
  const filePath = path.join(await stagingRoot(), `${id}.part`);
  const handle = await fs.open(filePath, "wx", 0o600);
  // The staging file exists now; a shutdown that began during the awaits must
  // not leave it behind or hand out an ID it already discarded.
  try {
    assertUploadsOpen(generation);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  staged.set(id, {
    id,
    generation,
    ...params.scope,
    ...(params.fileName ? { fileName: params.fileName } : {}),
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    declaredBytes: params.declaredBytes,
    receivedBytes: 0,
    partBytes: params.partBytes ?? CHAT_ATTACHMENT_UPLOAD_PART_BYTES,
    filePath,
    createdAtMs: Date.now(),
    handle,
  });
  return { uploadId: id, partBytes: params.partBytes ?? CHAT_ATTACHMENT_UPLOAD_PART_BYTES };
}

export async function writeStagedChatAttachmentPart(params: {
  uploadId: string;
  offset: number;
  stream: AsyncIterable<unknown>;
  scope: ChatAttachmentUploadScope;
  maxBytes: number;
  /** Reports whether the intake received the complete body, not a broken one. */
  isComplete?: () => boolean;
}): Promise<{ uploadId: string; receivedBytes: number }> {
  const generation = currentAdmissionGeneration();
  await sweepExpired();
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
  const openedHere = !entry.handle;
  const handle = entry.handle ?? (await fs.open(entry.filePath, "a", 0o600));
  if (openedHere) {
    // Do not recreate a staging file the final discard already removed.
    try {
      assertUploadsOpen(generation);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  entry.handle = handle;
  let partBytes = 0;
  try {
    for await (const chunk of params.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (buffer.byteLength === 0) {
        continue;
      }
      if (partBytes + buffer.byteLength > entry.partBytes) {
        throw new ChatAttachmentUploadError(
          "part-too-large",
          `attachment part exceeds ${entry.partBytes} bytes`,
          entry.receivedBytes + partBytes,
        );
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
    if (error instanceof ChatAttachmentUploadError) {
      // A protocol rejection keeps the staged bytes: the client can still retry
      // or commit this upload from the offset the error reports.
      entry.receivedBytes += partBytes;
      throw error;
    }
    // A broken or aborted part stream means no client is finishing these bytes.
    // Release the slot and its file now; a resumable retry cannot reach an
    // entry the transport already abandoned.
    await releaseStagedUpload(entry);
    throw new ChatAttachmentUploadError("invalid-request", "attachment upload was interrupted");
  }
  // A transport can end a body early without erroring the stream, so the intake
  // reports the truncation it saw. Either way no client is finishing these
  // bytes: release the slot instead of holding it for the staging TTL.
  if (params.isComplete && !params.isComplete()) {
    await releaseStagedUpload(entry);
    throw new ChatAttachmentUploadError("invalid-request", "attachment upload was interrupted");
  }
  try {
    assertUploadsOpen(generation);
  } catch {
    throw new ChatAttachmentUploadError(
      "shutting-down",
      "attachment uploads are closing; retry after the Gateway restarts",
      entry.receivedBytes + partBytes,
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
  const generation = currentAdmissionGeneration();
  await sweepExpired();
  const id = assertChatAttachmentUploadId(params.uploadId);
  const replay = committed.get(id);
  if (replay) {
    // A commit whose response was lost is safe to repeat while the upload is
    // still unsent and belongs to this caller; consumption stays single-use.
    assertScope(replay, params.scope, "attachment upload");
    return {
      uploadId: id,
      sizeBytes: replay.media.size,
      mimeType: replay.media.contentType ?? "application/octet-stream",
      ...(replay.fileName ? { fileName: replay.fileName } : {}),
    };
  }
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
  // Take ownership of the staging handle before awaiting its close so a
  // concurrent discard never closes the same handle a second time.
  const stagingHandle = entry.handle;
  entry.handle = undefined;
  await stagingHandle?.close().catch(() => undefined);
  params.assertCommitAllowed?.();
  // Closing the staging handle is another await: re-check admission before the
  // publication read, which a final discard may already have unlinked.
  try {
    assertUploadsOpen(generation);
  } catch (error) {
    await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  // A failed publication keeps the staging file so the client can retry commit.
  let media;
  try {
    media = await saveMediaStream(
      createReadStream(entry.filePath),
      entry.mimeType,
      "inbound",
      params.maxBytes,
      entry.fileName,
      undefined,
      { assertCommitAllowed: params.assertCommitAllowed },
    );
  } catch (error) {
    // A discard during publication removes the staging file; report the fence,
    // not the resulting read error.
    assertUploadsOpen(generation);
    throw error;
  }
  if (media.size !== entry.declaredBytes) {
    // A partially written chunk must not publish bytes the client never declared.
    await fs.rm(media.path, { force: true }).catch(() => undefined);
    throw new ChatAttachmentUploadError(
      "offset-mismatch",
      `attachment upload size does not match its declaration (${media.size}/${entry.declaredBytes} bytes)`,
      entry.receivedBytes,
    );
  }
  try {
    // Synchronous transfer with the fence check: reservedBytes never misses these
    // bytes, and a shutdown/restart cannot interleave between the two map writes.
    assertUploadsOpen(generation);
  } catch (error) {
    await fs.rm(media.path, { force: true }).catch(() => undefined);
    await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  committed.set(id, {
    id,
    generation: entry.generation,
    media,
    ...(entry.ownerKey ? { ownerKey: entry.ownerKey } : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
    createdAtMs: Date.now(),
  });
  staged.delete(id);
  // The reservation has moved; the staging file is no longer accounted for.
  await fs.rm(entry.filePath, { force: true }).catch(() => undefined);
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
  const id = assertChatAttachmentUploadId(uploadId);
  const entry = committed.get(id);
  if (!entry) {
    throw new ChatAttachmentUploadError(
      "unknown-upload",
      "attachment upload is unknown, expired, or already used",
    );
  }
  if (Date.now() - entry.createdAtMs > COMMITTED_TTL_MS) {
    committed.delete(id);
    void fs.rm(entry.media.path, { force: true }).catch(() => undefined);
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

/**
 * Cancels one upload for its owner and releases the capacity it holds. A staged
 * entry loses its bytes and slot; a committed-but-unsent entry loses its
 * published media, its committed slot, and its reserved bytes. An upload a send
 * already adopted is not in either map, so consuming it wins the race; both map
 * removals are synchronous before the filesystem work, so a concurrent consume
 * can never see a half-deleted entry. An upload that is already gone is a
 * success, so a cancel racing a commit, or a retried cancel after a lost
 * response, never surfaces as a new user-facing error.
 */
export async function discardChatAttachmentUpload(params: {
  uploadId: string;
  scope: ChatAttachmentUploadScope;
}): Promise<{ uploadId: string; discarded: boolean }> {
  const id = assertChatAttachmentUploadId(params.uploadId);
  const stagedEntry = staged.get(id);
  if (stagedEntry) {
    assertScope(stagedEntry, params.scope, "attachment upload");
    await releaseStagedUpload(stagedEntry);
    return { uploadId: id, discarded: true };
  }
  const committedEntry = committed.get(id);
  if (committedEntry) {
    assertScope(committedEntry, params.scope, "attachment upload");
    await releaseCommittedUpload(committedEntry);
    return { uploadId: id, discarded: true };
  }
  return { uploadId: id, discarded: false };
}

/**
 * Drops staging and committed bytes that no message will reference. A scoped
 * discard only touches entries (and files) owned by that admission generation,
 * so an older shutdown can never clear state a replacement generation admitted.
 */
export async function discardChatAttachmentUploads(options?: {
  generation?: number;
}): Promise<void> {
  const owns = (entry: { generation: number }) =>
    options?.generation === undefined || entry.generation === options.generation;
  const stagedEntries = [...staged.values()].filter(owns);
  const committedEntries = [...committed.values()].filter(owns);
  await Promise.allSettled([
    ...stagedEntries.map((entry) => releaseStagedUpload(entry)),
    ...committedEntries.map((entry) => releaseCommittedUpload(entry)),
  ]);
}

let shutdownInFlight: Promise<void> | undefined;

/**
 * Shutdown cleanup: fences new admission, joins in-flight mutations so none can
 * publish after the discard, then removes the staging and unsent media owned by
 * this generation. Single-flight so overlapping stop calls share one discard,
 * and generation-scoped so a later generation's uploads are untouched. The
 * Gateway maintenance owner awaits this before the HTTP listener closes.
 */
export function shutdownChatAttachmentUploads(): Promise<void> {
  if (shutdownInFlight) {
    return shutdownInFlight;
  }
  closing = true;
  const generation = admissionGeneration;
  admissionGeneration += 1;
  const run = (async () => {
    // Bounded join: a stalled transport must not hold shutdown open. Any commit
    // that lands after this discard re-checks the fence and deletes its media.
    await settlesWithin(Promise.allSettled(activeMutations), MUTATION_DRAIN_TIMEOUT_MS);
    await discardChatAttachmentUploads({ generation });
    stagingRootPromise = undefined;
  })();
  shutdownInFlight = run.finally(() => {
    shutdownInFlight = undefined;
  });
  return shutdownInFlight;
}

export function resetChatAttachmentUploadsForTests(options?: {
  stagingRoot?: () => Promise<string>;
}): void {
  staged.clear();
  committed.clear();
  stagingRootOverride = options?.stagingRoot;
  stagingRootPromise = undefined;
  closing = false;
  admissionGeneration += 1;
  activeMutations.clear();
  shutdownInFlight = undefined;
}

/** Serializes part and commit mutations per upload, and tracks them for shutdown. */
export function runStagedChatAttachmentMutation<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const run = uploadQueue.enqueue(key, task);
  activeMutations.add(run);
  void run
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => activeMutations.delete(run));
  return run;
}
