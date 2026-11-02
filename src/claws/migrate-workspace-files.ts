import { resolve } from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { isAvatarDataUrl, isSupportedLocalAvatarExtension } from "../shared/avatar-policy.js";
import { digestClawBytes } from "./digest.js";
import { ClawMigrationError } from "./migrate-errors.js";
import { lstatMigrationPathIfExists } from "./migrate-package.js";
import type { CapturedWorkspaceFile } from "./migrate-package.js";
import { containsPotentialSecret } from "./migrate-validation.js";
import { isSafeClawRelativePath } from "./schema-portability.js";
import { MAX_MANAGED_FILE_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import { CLAW_BOOTSTRAP_FILE_NAMES } from "./types.js";

const PROMPT_FILE_NAMES = [...CLAW_BOOTSTRAP_FILE_NAMES];

export type CapturedManagedFile = { path: string; content: Buffer; digest: string };

/**
 * Read the configured workspace avatar as a managed Claw workspace file. The
 * avatar must already be an independent image file; embedded data URLs are not
 * persisted sources and are never converted back into one.
 */
export async function readMigrationAvatarFile(params: {
  workspace: string;
  avatar: string | undefined;
}): Promise<CapturedManagedFile | undefined> {
  const avatar = params.avatar?.trim();
  if (!avatar) {
    return undefined;
  }
  if (isAvatarDataUrl(avatar)) {
    throw new ClawMigrationError(
      "agent_avatar_unsupported",
      "Embedded base64 avatars are no longer persisted. Save the image as a file inside the agent workspace and reference its relative path before migrating.",
      "$.agent.identity.avatar",
    );
  }
  const relativePath = avatar.replaceAll("\\", "/");
  if (!isSafeClawRelativePath(relativePath) || !isSupportedLocalAvatarExtension(relativePath)) {
    throw new ClawMigrationError(
      "agent_avatar_unsupported",
      `Avatar ${JSON.stringify(avatar)} is not a workspace-relative image file. Use a png, jpeg, webp, gif, or svg file inside the agent workspace.`,
      "$.agent.identity.avatar",
    );
  }
  const root = await fsSafeRoot(params.workspace, {
    hardlinks: "reject",
    maxBytes: MAX_MANAGED_FILE_BYTES,
    symlinks: "reject",
  });
  let content: Buffer;
  try {
    const read = await root.read(relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
      symlinks: "reject",
    });
    content = read.buffer;
  } catch (error) {
    const detail =
      error instanceof FsSafeError && error.code === "too-large"
        ? `the image exceeds the ${MAX_MANAGED_FILE_BYTES}-byte Claw workspace file limit`
        : formatErrorMessage(error);
    throw new ClawMigrationError(
      "agent_avatar_unreadable",
      `Avatar ${JSON.stringify(avatar)} is not a readable workspace image file: ${detail}. Save a bounded image inside the workspace and retry.`,
      "$.agent.identity.avatar",
    );
  }
  return { path: relativePath, content, digest: digestClawBytes(content) };
}

export async function readSelectedWorkspaceFiles(
  workspace: string,
): Promise<CapturedWorkspaceFile[]> {
  const root = await fsSafeRoot(workspace, {
    hardlinks: "reject",
    maxBytes: MAX_MANAGED_FILE_BYTES,
    symlinks: "reject",
  });
  const captured: CapturedWorkspaceFile[] = [];
  let totalBytes = 0;
  for (const name of PROMPT_FILE_NAMES) {
    const info = await lstatMigrationPathIfExists(resolve(workspace, name));
    if (!info) {
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new ClawMigrationError(
        "workspace_file_unsafe",
        `${name} must be a regular, non-symlinked, non-hardlinked file.`,
        `$.workspace.${name}`,
      );
    }
    const read = await root.read(name, {
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
      symlinks: "reject",
    });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
    } catch {
      throw new ClawMigrationError(
        "workspace_file_encoding_unsupported",
        `${name} is not valid UTF-8 text and cannot be represented as an agent prompt file.`,
        `$.workspace.${name}`,
      );
    }
    if (containsPotentialSecret(text)) {
      throw new ClawMigrationError(
        "workspace_file_secret_detected",
        `Potential secret material was found in ${name}. Remove it or leave this file unmanaged; the matching text was not displayed.`,
        `$.workspace.${name}`,
      );
    }
    totalBytes += read.buffer.byteLength;
    if (totalBytes > MAX_MANAGED_WORKSPACE_BYTES) {
      throw new ClawMigrationError(
        "workspace_files_too_large",
        `Selected prompt files exceed the ${MAX_MANAGED_WORKSPACE_BYTES}-byte Claw workspace limit.`,
        "$.workspace",
      );
    }
    captured.push({ name, content: read.buffer, digest: digestClawBytes(read.buffer) });
  }
  return captured;
}
