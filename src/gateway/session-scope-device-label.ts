import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readPromptDeviceScopeSnapshot } from "../agents/prompt-device-scope.js";
import { sanitizeForPromptLiteral } from "../agents/sanitize-for-prompt.js";

/** Mirrors SessionRowSchema.scopeDeviceName's maxLength so rows never violate their own schema. */
const SCOPE_DEVICE_LABEL_MAX_CHARS = 128;

/**
 * Row/event display label for a session's scope device, read from the
 * process-stable device-scope snapshot the device-scope owner publishes per
 * turn and scope switch. The device-reported name is untrusted and unbounded,
 * so it is sanitized and truncated to the row schema's limit here. Synchronous
 * by contract: with no snapshot, or when the snapshot's device no longer
 * matches the committed scope, callers get no label and clients fall back to
 * the device id. A rename lands with the snapshot's next publication (the
 * following turn or scope switch), not immediately.
 */
export function sessionScopeDeviceLabel(
  rootSessionKey: string,
  scopeDeviceId: string | undefined,
): string | undefined {
  const deviceId = normalizeOptionalString(scopeDeviceId);
  if (!deviceId) {
    return undefined;
  }
  const target = readPromptDeviceScopeSnapshot(rootSessionKey)?.target;
  if (target?.kind !== "node" || target.deviceId !== deviceId) {
    return undefined;
  }
  const label = truncateUtf16Safe(
    sanitizeForPromptLiteral(normalizeOptionalString(target.displayName) ?? ""),
    SCOPE_DEVICE_LABEL_MAX_CHARS,
  ).trimEnd();
  return label || undefined;
}
