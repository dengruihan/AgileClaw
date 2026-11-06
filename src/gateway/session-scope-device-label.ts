import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readPromptDeviceScopeSnapshot } from "../agents/prompt-device-scope.js";

/**
 * Row/event display label for a session's scope device, read from the
 * process-stable device-scope snapshot the device-scope owner publishes per
 * turn and scope switch. Synchronous by contract: with no snapshot, or when
 * the snapshot's device no longer matches the committed scope, callers get no
 * label and clients fall back to the device id. A rename lands with the
 * snapshot's next publication (the following turn or scope switch), not
 * immediately.
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
  return target?.kind === "node" && target.deviceId === deviceId
    ? normalizeOptionalString(target.displayName)
    : undefined;
}
