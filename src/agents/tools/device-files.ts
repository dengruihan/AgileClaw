/**
 * Device-routed file adapters (read, ls, write, edit, apply_patch).
 *
 * Placement file tools keep their Gateway semantics but run against the scoped
 * device through the existing `file.fetch`, `file.stat`, `dir.list`, and
 * `file.write` node commands. Those commands are registered by the
 * file-transfer plugin, whose per-device path policy
 * (`allowReadPaths`/`allowWritePaths`) is enforced on the Gateway's node-invoke
 * path, so device scope changes *where* the containment applies, never whether
 * it applies. Edit and apply_patch reuse the Gateway's planning/patch owners
 * over device read/stat/write round trips; hunk kinds the node command surface
 * cannot express (delete, move) fail per call with a clear reason instead of
 * degrading.
 */
import { createHash, randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import { createPatchTarget, type PatchFileOps } from "../apply-patch-file-ops.js";
import { applyUpdateHunk } from "../apply-patch-update.js";
import {
  formatSummary,
  normalizeUpdateComparison,
  parsePatchText,
  type ApplyPatchSummary,
} from "../apply-patch.js";
import type { Edit } from "../sessions/tools/edit-diff.js";
import { planFileEdit } from "../sessions/tools/file-tool-planning.js";
import type { EditToolDetails } from "../sessions/tools/tool-contracts.js";
import { decodeUtf8File } from "../utf8-file.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { textResult } from "./tool-results.js";

/** Model-facing read bound; larger files report their size instead of flooding context. */
const DEVICE_READ_MAX_BYTES = 1024 * 1024;
/** file-transfer hard ceiling for a single fetch round trip. */
const DEVICE_READ_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEVICE_WRITE_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEVICE_DIR_LIST_MAX_ENTRIES = 500;
/** edit/apply_patch rewrite whole files, so the read and write ceilings coincide. */
const DEVICE_EDIT_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEVICE_EDIT_MISMATCH_HINT_LIMIT = 800;

function nodeInvokeOptions(timeoutMs: number) {
  return { timeoutMs };
}

async function invokeDeviceFileCommand(params: {
  deviceId: string;
  command: string;
  commandParams: Record<string, unknown>;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
}) {
  const raw = await callGatewayTool(
    "node.invoke",
    nodeInvokeOptions(60_000),
    {
      nodeId: params.deviceId,
      command: params.command,
      sessionKey: params.rootSessionKey,
      idempotencyKey: randomUUID(),
      params: { ...params.commandParams, leaseToken: params.leaseToken },
    },
    params.signal ? { signal: params.signal } : undefined,
  );
  const payload = asNullableRecord(asNullableRecord(raw)?.payload);
  if (!payload) {
    throw new Error(`device ${params.deviceId} returned a malformed ${params.command} payload`);
  }
  if (payload.ok === false) {
    const code = typeof payload.code === "string" ? payload.code : "UNAVAILABLE";
    const message =
      typeof payload.message === "string" ? payload.message : `${params.command} failed`;
    throw new Error(`${params.command} on device ${params.deviceId} failed (${code}): ${message}`);
  }
  return payload;
}

type DeviceFileCall = {
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
};

function assertNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** `file.stat` on the scoped device: canonical path and identity for edit planning. */
async function statDeviceFile(params: DeviceFileCall & { path: string }) {
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "file.stat",
    commandParams: { path: params.path },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const canonicalPath = typeof payload.path === "string" ? payload.path : params.path;
  const type = payload.type === "directory" ? "directory" : payload.type === "file" ? "file" : "";
  const size = typeof payload.size === "number" ? payload.size : -1;
  if (!type || size < 0) {
    throw new Error("file.stat payload is missing its target metadata");
  }
  return { canonicalPath, type, size };
}

/** Fetch one whole device file as text; edit-style calls need untruncated bytes. */
async function fetchDeviceTextFile(params: DeviceFileCall & { path: string }) {
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "file.fetch",
    commandParams: { path: params.path, maxBytes: DEVICE_EDIT_HARD_MAX_BYTES },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const canonicalPath = typeof payload.path === "string" ? payload.path : params.path;
  const size = typeof payload.size === "number" ? payload.size : -1;
  const base64 = typeof payload.base64 === "string" ? payload.base64 : undefined;
  if (base64 === undefined || size < 0) {
    throw new Error("file.fetch payload is missing its content bytes");
  }
  if (size > DEVICE_EDIT_HARD_MAX_BYTES) {
    throw new ToolInputError(
      `${canonicalPath} on device ${params.deviceId} is ${size} bytes; the device edit ceiling is ${DEVICE_EDIT_HARD_MAX_BYTES} bytes`,
    );
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength < size) {
    throw new ToolInputError(
      `${canonicalPath} on device ${params.deviceId} could not be fetched whole (${buffer.byteLength} of ${size} bytes); edit requires the complete file`,
    );
  }
  return { canonicalPath, size, text: decodeUtf8File(buffer, canonicalPath) };
}

/** Overwrite one device file, pinning the stat-resolved canonical path against swaps. */
async function overwriteDeviceFile(
  params: DeviceFileCall & {
    path: string;
    canonicalPath?: string;
    buffer: Buffer;
  },
) {
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "file.write",
    commandParams: {
      path: params.path,
      contentBase64: params.buffer.toString("base64"),
      overwrite: true,
      createParents: true,
      expectedSha256: createHash("sha256").update(params.buffer).digest("hex"),
      ...(params.canonicalPath ? { expectedCanonicalPath: params.canonicalPath } : {}),
    },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return typeof payload.path === "string" ? payload.path : params.path;
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= DEVICE_EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${truncateUtf8Prefix(currentContent, DEVICE_EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`, {
    cause: error,
  });
  enhanced.stack = error.stack;
  return enhanced;
}

function readEditParams(input: Record<string, unknown>): { path: string; edits: Edit[] } {
  const filePath = readToolStringParam(input, "path", { required: true });
  const rawEdits = Array.isArray(input.edits) ? input.edits : [];
  const edits: Edit[] = [];
  for (const entry of rawEdits) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).oldText === "string" &&
      typeof (entry as Record<string, unknown>).newText === "string"
    ) {
      edits.push({
        oldText: (entry as Record<string, unknown>).oldText as string,
        newText: (entry as Record<string, unknown>).newText as string,
      });
    }
  }
  if (edits.length === 0) {
    throw new ToolInputError("edit requires at least one edits[] replacement");
  }
  return { path: filePath, edits };
}

/** `edit` on the scoped device: exact-match replacements planned by the shared edit owner. */
export async function editDeviceFile(
  params: DeviceFileCall & {
    params: Record<string, unknown>;
  },
) {
  const { path: filePath, edits } = readEditParams(params.params);
  const stat = await statDeviceFile({ ...params, path: filePath });
  if (stat.type !== "file") {
    throw new ToolInputError(
      `${filePath} on device ${params.deviceId} is a ${stat.type}; edit targets files`,
    );
  }
  if (stat.size > DEVICE_EDIT_HARD_MAX_BYTES) {
    throw new ToolInputError(
      `${filePath} on device ${params.deviceId} is ${stat.size} bytes; the device edit ceiling is ${DEVICE_EDIT_HARD_MAX_BYTES} bytes`,
    );
  }
  assertNotAborted(params.signal);
  const fetched = await fetchDeviceTextFile({ ...params, path: filePath });
  let plan;
  try {
    plan = await planFileEdit({ path: filePath, content: fetched.text, edits }, params.signal);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (normalized.message.includes("Could not find the exact text")) {
      throw appendMismatchHint(normalized, fetched.text);
    }
    throw normalized;
  }
  if (!plan.changed) {
    return textResult(plan.message, { changed: false } satisfies EditToolDetails);
  }
  assertNotAborted(params.signal);
  const buffer = Buffer.from(plan.content, "utf8");
  if (buffer.byteLength > DEVICE_EDIT_HARD_MAX_BYTES) {
    throw new ToolInputError(
      `edited content is ${buffer.byteLength} bytes; the device write ceiling is ${DEVICE_EDIT_HARD_MAX_BYTES} bytes`,
    );
  }
  await overwriteDeviceFile({
    ...params,
    path: filePath,
    canonicalPath: stat.canonicalPath,
    buffer,
  });
  assertNotAborted(params.signal);
  const verify = await statDeviceFile({ ...params, path: filePath });
  if (verify.type !== "file" || verify.size !== buffer.byteLength) {
    throw new Error(
      `Edit verification failed for ${filePath}: the device file does not match the requested content (${verify.type}, ${verify.size} of ${buffer.byteLength} bytes). Inspect the target and retry.`,
    );
  }
  return textResult<EditToolDetails>(
    `Successfully replaced ${plan.editCount} block(s) in ${filePath}.`,
    { changed: true, ...plan.receipt },
  );
}

function assertAbsoluteDevicePath(rawPath: string, hunkKind: string): void {
  if (rawPath.startsWith("/")) {
    return;
  }
  throw new ToolInputError(
    `device-scoped apply_patch requires absolute device paths; the ${hunkKind} hunk path '${rawPath}' cannot be resolved against the Gateway workspace`,
  );
}

/** Device-backed file operations for the patch envelope; the node command surface owns containment. */
function createDevicePatchOps(params: DeviceFileCall): PatchFileOps {
  return {
    readFile: async (filePath) => (await fetchDeviceTextFile({ ...params, path: filePath })).text,
    writeFile: async (filePath, content) => {
      await overwriteDeviceFile({
        ...params,
        path: filePath,
        buffer: Buffer.from(content, "utf8"),
      });
    },
    createFileExclusive: async (filePath, content) => {
      const buffer = Buffer.from(content, "utf8");
      try {
        await invokeDeviceFileCommand({
          deviceId: params.deviceId,
          command: "file.write",
          commandParams: {
            path: filePath,
            contentBase64: buffer.toString("base64"),
            overwrite: false,
            createParents: true,
            expectedSha256: createHash("sha256").update(buffer).digest("hex"),
          },
          rootSessionKey: params.rootSessionKey,
          leaseToken: params.leaseToken,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        return "created";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("CANONICAL_PATH_CHANGED")) {
          return "exists";
        }
        throw error;
      }
    },
    remove: async () => {
      throw new ToolInputError(
        "device file commands have no delete; switch back with use_device device='gateway' to delete files there",
      );
    },
  };
}

/** `apply_patch` on the scoped device over read/stat/write; delete/move hunks fail per call. */
export async function applyDevicePatch(
  params: DeviceFileCall & {
    params: Record<string, unknown>;
  },
) {
  const input = readToolStringParam(params.params, "input", { required: true });
  const hunks = parsePatchText(input);
  if (hunks.length === 0) {
    throw new Error("No files were modified.");
  }
  for (const hunk of hunks) {
    if (hunk.kind === "delete") {
      throw new ToolInputError(
        `device file commands cannot delete '${hunk.path}'; use Update File instead, or switch back with use_device device='gateway' for Delete File hunks`,
      );
    }
    if (hunk.kind === "update" && hunk.movePath) {
      throw new ToolInputError(
        `device file commands cannot move '${hunk.path}' to '${hunk.movePath}'; apply the content as an Update File hunk instead, or switch back with use_device device='gateway' for Move to hunks`,
      );
    }
    assertAbsoluteDevicePath(hunk.path, hunk.kind === "add" ? "Add File" : "Update File");
  }
  const ops = createDevicePatchOps(params);
  const changedPaths: Record<keyof ApplyPatchSummary, Set<string>> = {
    added: new Set(),
    modified: new Set(),
    deleted: new Set(),
  };
  const noOpPaths = new Set<string>();
  for (const hunk of hunks) {
    assertNotAborted(params.signal);
    if (hunk.kind === "add") {
      await createPatchTarget({
        target: { resolved: hunk.path, display: hunk.path },
        contents: hunk.contents,
        ops,
        hint: `Use "*** Update File: ${hunk.path}" to change it, or delete it earlier in the same patch.`,
      });
      changedPaths.added.add(hunk.path);
      continue;
    }
    if (hunk.kind !== "update") {
      // Unreachable: the validation pass already rejected delete and move hunks.
      throw new ToolInputError(
        `device apply_patch does not support '${hunk.kind}' hunks for ${hunk.path}`,
      );
    }
    const stat = await statDeviceFile({ ...params, path: hunk.path });
    if (stat.type !== "file") {
      throw new ToolInputError(
        `${hunk.path} on device ${params.deviceId} is a ${stat.type}; Update File hunks target files`,
      );
    }
    if (stat.size > DEVICE_EDIT_HARD_MAX_BYTES) {
      throw new ToolInputError(
        `${hunk.path} on device ${params.deviceId} is ${stat.size} bytes; the device edit ceiling is ${DEVICE_EDIT_HARD_MAX_BYTES} bytes`,
      );
    }
    const fetched = await fetchDeviceTextFile({ ...params, path: hunk.path });
    assertNotAborted(params.signal);
    const applied = await applyUpdateHunk(hunk.path, hunk.chunks, {
      readFile: async () => fetched.text,
    });
    if (normalizeUpdateComparison(fetched.text) === normalizeUpdateComparison(applied)) {
      noOpPaths.add(hunk.path);
      continue;
    }
    const buffer = Buffer.from(applied, "utf8");
    if (buffer.byteLength > DEVICE_EDIT_HARD_MAX_BYTES) {
      throw new ToolInputError(
        `patched content is ${buffer.byteLength} bytes; the device write ceiling is ${DEVICE_EDIT_HARD_MAX_BYTES} bytes`,
      );
    }
    await overwriteDeviceFile({
      ...params,
      path: hunk.path,
      canonicalPath: stat.canonicalPath,
      buffer,
    });
    noOpPaths.delete(hunk.path);
    changedPaths.modified.add(hunk.path);
  }
  const summary: ApplyPatchSummary = {
    added: [...changedPaths.added],
    modified: [...changedPaths.modified],
    deleted: [...changedPaths.deleted],
  };
  const noOp = noOpPaths.size > 0 && Object.values(summary).every((paths) => paths.length === 0);
  return textResult(
    noOp ? `No changes made to ${[...noOpPaths].join(", ")}.` : formatSummary(summary),
    { summary, deviceScope: params.deviceId },
  );
}

/** `read` on the scoped device: file content with a bounded, explicit truncation. */
export async function readDeviceFile(params: {
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
}) {
  const filePath = readToolStringParam(params.params, "path", { required: true });
  const requested = readPositiveIntegerParam(params.params, "maxBytes") ?? DEVICE_READ_MAX_BYTES;
  const maxBytes = Math.max(1, Math.min(requested, DEVICE_READ_HARD_MAX_BYTES));
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "file.fetch",
    commandParams: { path: filePath, maxBytes },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const canonicalPath = typeof payload.path === "string" ? payload.path : filePath;
  const size = typeof payload.size === "number" ? payload.size : -1;
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
  const base64 = typeof payload.base64 === "string" ? payload.base64 : undefined;
  if (base64 === undefined || size < 0) {
    throw new Error("file.fetch payload is missing its content bytes");
  }
  const buffer = Buffer.from(base64, "base64");
  const truncated = size > buffer.byteLength;
  const textLike =
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "";
  const body = textLike
    ? truncateUtf8Prefix(buffer.toString("utf8"), maxBytes)
    : `[binary ${mimeType || "file"} omitted: ${size} bytes]`;
  return textResult(`Device: ${params.deviceId}\nPath: ${canonicalPath}\n${body}`, {
    path: canonicalPath,
    deviceScope: params.deviceId,
    size,
    mimeType,
    ...(truncated ? { truncated: true } : {}),
  });
}

/** `ls` on the scoped device: canonical directory listing within one page. */
export async function listDeviceDirectory(params: {
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
}) {
  const dirPath = readToolStringParam(params.params, "path", { required: true });
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "dir.list",
    commandParams: { path: dirPath, maxEntries: DEVICE_DIR_LIST_MAX_ENTRIES },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const canonicalPath = typeof payload.path === "string" ? payload.path : dirPath;
  const entries = Array.isArray(payload.entries)
    ? (payload.entries as Array<Record<string, unknown>>)
    : [];
  const lines = entries.map((entry) => {
    const name = typeof entry.name === "string" ? entry.name : "?";
    const isDir = entry.isDir === true;
    const size = typeof entry.size === "number" ? ` ${entry.size}B` : "";
    return `${isDir ? "dir " : "file"} ${name}${isDir ? "" : size}`;
  });
  const truncated = payload.truncated === true;
  return textResult(
    [
      `Device: ${params.deviceId}`,
      `Path: ${canonicalPath}`,
      ...lines,
      truncated ? "(listing truncated; request a narrower path)" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    {
      path: canonicalPath,
      deviceScope: params.deviceId,
      entries,
      truncated,
    },
  );
}

/** `write` on the scoped device: full-content overwrite with integrity proof. */
export async function writeDeviceFile(params: {
  params: Record<string, unknown>;
  deviceId: string;
  rootSessionKey: string;
  leaseToken: string;
  signal?: AbortSignal;
}) {
  const filePath = readToolStringParam(params.params, "path", { required: true });
  const rawContent = params.params.content;
  if (typeof rawContent !== "string") {
    throw new ToolInputError("write requires string content");
  }
  const buffer = Buffer.from(rawContent, "utf8");
  if (buffer.byteLength > DEVICE_WRITE_HARD_MAX_BYTES) {
    throw new ToolInputError(
      `content is ${buffer.byteLength} bytes; the device write ceiling is ${DEVICE_WRITE_HARD_MAX_BYTES} bytes`,
    );
  }
  const payload = await invokeDeviceFileCommand({
    deviceId: params.deviceId,
    command: "file.write",
    commandParams: {
      path: filePath,
      contentBase64: buffer.toString("base64"),
      overwrite: true,
      createParents: true,
      expectedSha256: createHash("sha256").update(buffer).digest("hex"),
    },
    rootSessionKey: params.rootSessionKey,
    leaseToken: params.leaseToken,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const writtenPath = typeof payload.path === "string" ? payload.path : filePath;
  const size = typeof payload.size === "number" ? payload.size : buffer.byteLength;
  const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
  return textResult(
    `Wrote ${writtenPath} on device ${params.deviceId} (${size} bytes${sha256 ? `, sha256:${sha256.slice(0, 12)}` : ""})`,
    {
      path: writtenPath,
      deviceScope: params.deviceId,
      size,
      ...(sha256 ? { sha256 } : {}),
      overwritten: payload.overwritten === true,
    },
  );
}
