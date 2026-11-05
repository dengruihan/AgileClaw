/**
 * Process-stable device-scope facts for the model-facing Runtime Context.
 *
 * The Gateway turn owner publishes one snapshot per session when that session's
 * tool-execution scope or the device registry changes. Prompt assembly reads the
 * published snapshot at the turn boundary instead of reloading the node registry
 * or the session store per turn. The current scope never enters the stable
 * system-prompt prefix, so switching devices cannot invalidate prompt caching.
 *
 * Device-reported strings are untrusted: every field is sanitized and bounded
 * here so all consumers render identical bytes for identical facts.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

export const PROMPT_DEVICE_SCOPE_HEADER = "## Device Scope";
/** Bounded device list: one line per device, deterministic order, first 10 by id. */
export const PROMPT_DEVICE_SCOPE_MAX_DEVICES = 10;
const MAX_DEVICE_SCOPE_FIELD_CHARS = 64;
/** Bounded per-process session snapshots; oldest publication is evicted first. */
const MAX_PUBLISHED_DEVICE_SCOPE_SESSIONS = 256;

/** One selectable device; disabled devices stay out of the prompt list. */
export type PromptDeviceScopeDevice = {
  deviceId: string;
  displayName?: string;
  platform?: string;
  /** Registry flag from the pairing store; absent reads as enabled. */
  enabled?: boolean;
  connected?: boolean;
};

/** Where this session's tools run: the Gateway host or one paired device. */
export type PromptDeviceScopeTarget =
  | { kind: "gateway"; host?: string; os?: string; cwd?: string }
  | {
      kind: "node";
      deviceId: string;
      displayName?: string;
      platform?: string;
      cwd?: string;
    };

export type PromptDeviceScopeSnapshot = {
  target: PromptDeviceScopeTarget;
  devices: readonly PromptDeviceScopeDevice[];
};

type PublishedSnapshot = {
  snapshot: PromptDeviceScopeSnapshot;
  isCurrent?: () => boolean;
};

const publishedBySessionKey = new Map<string, PublishedSnapshot>();

/**
 * Replaces the process-stable snapshot for one session. The Gateway turn owner
 * republishes on a scope or device-registry change and withdraws it when the
 * session ends or resets. Passing no snapshot withdraws the fact, so prompt
 * assembly omits the family instead of guessing a scope. `isCurrent`
 * revalidates live device state before the fact is rendered.
 */
export function publishPromptDeviceScopeSnapshot(params: {
  sessionKey: string;
  snapshot?: PromptDeviceScopeSnapshot;
  isCurrent?: () => boolean;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  // Re-insert so a refreshed session outlives older publications.
  publishedBySessionKey.delete(sessionKey);
  if (!params.snapshot) {
    return;
  }
  publishedBySessionKey.set(sessionKey, {
    snapshot: {
      target: { ...params.snapshot.target },
      devices: params.snapshot.devices.map((device) => ({ ...device })),
    },
    ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
  });
  while (publishedBySessionKey.size > MAX_PUBLISHED_DEVICE_SCOPE_SESSIONS) {
    const oldest = publishedBySessionKey.keys().next();
    if (oldest.done) {
      break;
    }
    publishedBySessionKey.delete(oldest.value);
  }
}

/** Synchronous turn-boundary read: never loads a registry or a session row. */
export function readPromptDeviceScopeSnapshot(
  sessionKey?: string,
): PromptDeviceScopeSnapshot | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const record = publishedBySessionKey.get(key);
  if (!record) {
    return undefined;
  }
  try {
    if (record.isCurrent && !record.isCurrent()) {
      publishedBySessionKey.delete(key);
      return undefined;
    }
  } catch {
    publishedBySessionKey.delete(key);
    return undefined;
  }
  return record.snapshot;
}

export function clearPromptDeviceScopeSnapshotsForTest(): void {
  publishedBySessionKey.clear();
}

function boundedField(value: string | undefined): string | undefined {
  const sanitized = sanitizeForPromptLiteral(value?.trim() ?? "").trim();
  if (!sanitized) {
    return undefined;
  }
  return truncateUtf16Safe(sanitized, MAX_DEVICE_SCOPE_FIELD_CHARS).trimEnd() || undefined;
}

function renderFields(fields: Array<[label: string, value: string | undefined]>): string {
  return fields.flatMap(([label, value]) => (value ? [`${label}=${value}`] : [])).join(", ");
}

function renderScopeTarget(target: PromptDeviceScopeTarget): string {
  if (target.kind === "gateway") {
    const fields = renderFields([
      ["host", boundedField(target.host)],
      ["os", boundedField(target.os)],
      ["cwd", boundedField(target.cwd)],
    ]);
    return fields ? `Current scope device: gateway (${fields})` : "Current scope device: gateway";
  }
  const deviceId = boundedField(target.deviceId);
  if (!deviceId) {
    return "Current scope device: unknown";
  }
  const displayName = boundedField(target.displayName);
  const fields = renderFields([
    ["os", boundedField(target.platform)],
    // A node filesystem has a default working directory; absent execCwd means that default.
    ["cwd", boundedField(target.cwd) ?? "node default"],
  ]);
  return `Current scope device: node:${deviceId}${displayName ? ` (${displayName})` : ""}${fields ? `, ${fields}` : ""}`;
}

function renderDeviceLine(device: PromptDeviceScopeDevice): string | undefined {
  const deviceId = boundedField(device.deviceId);
  if (!deviceId) {
    return undefined;
  }
  const displayName = boundedField(device.displayName);
  const platform = boundedField(device.platform);
  const connectionState =
    device.connected === true
      ? "connected"
      : device.connected === false
        ? "disconnected"
        : "unknown";
  const label = displayName ? `${deviceId} (${displayName})` : deviceId;
  return `- ${label}: ${[platform, connectionState].filter(Boolean).join(", ")}`;
}

/**
 * Renders the transient `## Device Scope` family. Disabled devices are omitted
 * because they cannot execute; the enabled list is sorted by device id and
 * capped so identical registry state always yields identical prompt bytes.
 */
export function renderPromptDeviceScopeFact(params: {
  snapshot: PromptDeviceScopeSnapshot;
  includeEmptySnapshots?: boolean;
}): string {
  const deviceLines = params.snapshot.devices
    .filter((device) => device.enabled !== false)
    .map((device) => ({
      deviceId: boundedField(device.deviceId) ?? "",
      line: renderDeviceLine(device),
    }))
    .filter((entry): entry is { deviceId: string; line: string } => Boolean(entry.line))
    .toSorted((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))
    .slice(0, PROMPT_DEVICE_SCOPE_MAX_DEVICES)
    .map((entry) => entry.line);
  if (deviceLines.length === 0 && params.includeEmptySnapshots !== true) {
    return [PROMPT_DEVICE_SCOPE_HEADER, renderScopeTarget(params.snapshot.target)].join("\n");
  }
  return [
    PROMPT_DEVICE_SCOPE_HEADER,
    renderScopeTarget(params.snapshot.target),
    `Enabled devices (max ${PROMPT_DEVICE_SCOPE_MAX_DEVICES}):`,
    ...(deviceLines.length > 0 ? deviceLines : ["- none"]),
  ].join("\n");
}
