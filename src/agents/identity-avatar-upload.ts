import fs from "node:fs/promises";
import path from "node:path";
// Upload-time avatar staging: decode base64 image data URLs and stage workspace
// image files so persisted identity sources stay file paths. Workspace bytes are
// published only from the admitted create/update mutation.
import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";

/** Directory inside the agent workspace that owns Gateway-written avatar files. */
export const AGENT_AVATAR_DIRECTORY = "avatars";

const AVATAR_DATA_URL_RE =
  /^data:([a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]*={0,2})$/i;

const AVATAR_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export const SUPPORTED_AVATAR_UPLOAD_MIME_TYPES = Object.keys(AVATAR_EXTENSION_BY_MIME);

export type DecodedAvatarUpload = {
  mimeType: string;
  extension: string;
  body: Buffer;
};

export type AvatarUploadDecodeFailureReason =
  | "malformed"
  | "unsupported_mime"
  | "invalid_base64"
  | "too_large";

export type AvatarUploadDecodeResult =
  | { ok: true; value: DecodedAvatarUpload }
  | { ok: false; reason: AvatarUploadDecodeFailureReason; message: string };

const DECODE_FAILURE_MESSAGES: Record<AvatarUploadDecodeFailureReason, string> = {
  malformed: "avatar data URL must be a base64-encoded image (data:image/...;base64,...)",
  unsupported_mime: `avatar data URL must use one of the locally servable image types: ${SUPPORTED_AVATAR_UPLOAD_MIME_TYPES.join(", ")}`,
  invalid_base64: "avatar data URL payload is not valid base64",
  too_large: `avatar image exceeds the ${AVATAR_MAX_BYTES} byte limit`,
};

function decodeFailure(reason: AvatarUploadDecodeFailureReason): {
  ok: false;
  reason: AvatarUploadDecodeFailureReason;
  message: string;
} {
  return { ok: false, reason, message: DECODE_FAILURE_MESSAGES[reason] };
}

/** Decode one base64 image data URL into storable avatar bytes. */
export function decodeAvatarImageDataUrl(value: string): AvatarUploadDecodeResult {
  const match = AVATAR_DATA_URL_RE.exec(value.trim());
  if (!match) {
    return decodeFailure("malformed");
  }
  const mimeType = match[1]!.toLowerCase();
  const extension = AVATAR_EXTENSION_BY_MIME[mimeType];
  if (!extension) {
    return decodeFailure("unsupported_mime");
  }
  const payload = match[2]!;
  if (payload.length === 0 || payload.length % 4 !== 0) {
    return decodeFailure("invalid_base64");
  }
  const body = Buffer.from(payload, "base64");
  // Node's decoder skips invalid characters; round-trip length proves canonical input.
  if (body.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) {
    return decodeFailure("invalid_base64");
  }
  if (body.byteLength === 0 || body.byteLength > AVATAR_MAX_BYTES) {
    return decodeFailure("too_large");
  }
  return { ok: true, value: { mimeType, extension, body } };
}

/** Deterministic workspace-relative storage path for one agent's exact avatar bytes. */
export function agentAvatarStoragePath(
  agentId: string,
  extension: string,
  body: Uint8Array,
): string {
  return `${AGENT_AVATAR_DIRECTORY}/${agentId}-${sha256HexPrefixCore(body, 16)}.${extension}`;
}

/** Normalize a workspace avatar storage path for the current platform. */
export function agentAvatarStorageFilePath(workspaceDir: string, source: string): string {
  return path.join(workspaceDir, ...source.split("/"));
}

export type StagedAgentAvatarUpload = {
  /** Workspace-relative source to persist in config and IDENTITY.md. */
  source: string;
  filePath: string;
  /**
   * Write the staged bytes. The content-hashed path means a different upload
   * never replaces this file, so a failed operation cannot alter an existing
   * avatar image; callers publish only from their admitted mutation.
   */
  publish: (assertCurrent?: () => void) => Promise<void>;
};

/** Stage decoded avatar bytes without touching the workspace. */
export function stageDecodedAgentAvatarUpload(params: {
  workspaceDir: string;
  agentId: string;
  decoded: DecodedAvatarUpload;
}): StagedAgentAvatarUpload {
  const source = agentAvatarStoragePath(
    params.agentId,
    params.decoded.extension,
    params.decoded.body,
  );
  return {
    source,
    filePath: agentAvatarStorageFilePath(params.workspaceDir, source),
    publish: (assertCurrent) =>
      writeAgentAvatarFile({
        workspaceDir: params.workspaceDir,
        source,
        body: params.decoded.body,
        assertCurrent,
      }),
  };
}

/**
 * Stage one uploaded data-URL avatar. Decoding and path selection validate the
 * request; workspace bytes are written only by the returned `publish`.
 */
export function stageAgentAvatarUpload(params: {
  workspaceDir: string;
  agentId: string;
  avatar: string;
}): { ok: true; upload: StagedAgentAvatarUpload } | { ok: false; message: string } {
  const decoded = decodeAvatarImageDataUrl(params.avatar);
  if (!decoded.ok) {
    return { ok: false, message: decoded.message };
  }
  return {
    ok: true,
    upload: stageDecodedAgentAvatarUpload({
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      decoded: decoded.value,
    }),
  };
}

export type PersistedAgentAvatarUpload = { source: string; filePath: string };

/**
 * Write decoded avatar bytes immediately. Gateway uploads stage instead and
 * publish from their admitted mutation; Doctor migration owns its own writes.
 */
export async function persistAgentAvatarUpload(params: {
  workspaceDir: string;
  agentId: string;
  decoded: DecodedAvatarUpload;
  assertCurrent?: () => void;
}): Promise<PersistedAgentAvatarUpload> {
  const staged = stageDecodedAgentAvatarUpload(params);
  await staged.publish(params.assertCurrent);
  return { source: staged.source, filePath: staged.filePath };
}

async function writeAgentAvatarFile(params: {
  workspaceDir: string;
  source: string;
  body: Buffer;
  assertCurrent?: () => void;
}): Promise<void> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (access) {
    params.assertCurrent?.();
    await access.bridge.writeFile({
      filePath: params.source,
      data: params.body,
      mkdir: true,
    });
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed while saving the Agent avatar");
    }
    return;
  }
  const filePath = agentAvatarStorageFilePath(params.workspaceDir, params.source);
  // Revalidate admission before the first filesystem effect (directory creation).
  params.assertCurrent?.();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const workspaceRoot = await fsSafeRoot(params.workspaceDir);
  params.assertCurrent?.();
  try {
    await workspaceRoot.write(params.source, params.body, {
      assertBeforeMutation: params.assertCurrent,
    });
  } catch (error) {
    if (error instanceof FsSafeError) {
      throw new Error(`unsafe avatar destination "${params.source}" in the agent workspace`, {
        cause: error,
      });
    }
    throw error;
  }
}
