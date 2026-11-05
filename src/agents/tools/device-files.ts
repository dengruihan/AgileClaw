/**
 * Device-routed file adapters (read, ls, write).
 *
 * Placement file tools keep their Gateway semantics but run against the scoped
 * device through the existing `file.fetch`, `dir.list`, and `file.write` node
 * commands. Those commands are registered by the file-transfer plugin, whose
 * per-device path policy (`allowReadPaths`/`allowWritePaths`) is enforced on the
 * Gateway's node-invoke path, so device scope changes *where* the containment
 * applies, never whether it applies.
 */
import { createHash, randomUUID } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { textResult } from "./tool-results.js";

/** Model-facing read bound; larger files report their size instead of flooding context. */
const DEVICE_READ_MAX_BYTES = 1024 * 1024;
/** file-transfer hard ceiling for a single fetch round trip. */
const DEVICE_READ_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEVICE_WRITE_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DEVICE_DIR_LIST_MAX_ENTRIES = 500;

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
