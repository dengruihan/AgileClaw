/**
 * Protection for a document that received a vault fill.
 *
 * This is deliberately independent of `logging.redact`: the fill route owns its
 * own full-mask scrub so `logging.redact=off` cannot expose a filled value
 * through evaluate/text/snapshot results. Page JavaScript and co-attached CDP
 * clients can still read the DOM; this masks OpenClaw's own tool surfaces only.
 *
 * A session persists until the tab navigates, closes, or the approved submit
 * path clears the field. It never expires by wall-clock time: an arbitrary TTL
 * would re-open reads while the plaintext is still in the document.
 */
import type { BrowserActRequest } from "./client-actions.types.js";

const MASK = "***";

type FillSession = {
  secrets: string[];
};

const sessions = new Map<string, FillSession>();

function secretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  try {
    variants.add(encodeURIComponent(secret));
  } catch {
    // Ignore lone-surrogate input; the raw value is still registered.
  }
  try {
    variants.add(JSON.stringify(secret).slice(1, -1));
  } catch {
    // See above.
  }
  variants.add(Buffer.from(secret, "utf8").toString("base64"));
  variants.add(Buffer.from(secret, "utf8").toString("base64url"));
  // Longest first so a shorter encoding cannot partially replace a longer one.
  return [...variants].filter((value) => value.length > 0).toSorted((a, b) => b.length - a.length);
}

/** Arm masking before the value is inserted into the document. */
export function registerVaultFillSecret(targetId: string, secret: string): void {
  if (!targetId || !secret) {
    return;
  }
  const existing = sessions.get(targetId);
  const secrets = new Set(existing?.secrets ?? []);
  for (const variant of secretVariants(secret)) {
    secrets.add(variant);
  }
  sessions.set(targetId, { secrets: [...secrets].toSorted((a, b) => b.length - a.length) });
}

export function hasActiveVaultFill(targetId: string | undefined): boolean {
  return targetId ? sessions.has(targetId) : false;
}

export function hasAnyActiveVaultFill(): boolean {
  return sessions.size > 0;
}

export function clearVaultFillSession(targetId: string | undefined): void {
  if (targetId) {
    sessions.delete(targetId);
  }
}

export function clearAllVaultFillSessions(): void {
  sessions.clear();
}

function containsScript(action: BrowserActRequest): boolean {
  switch (action.kind) {
    case "evaluate":
      return true;
    case "wait":
      return typeof action.fn === "string" && action.fn.trim().length > 0;
    case "batch":
      return action.actions.some(containsScript);
    default:
      return false;
  }
}

function containsProtectedMutation(action: BrowserActRequest): boolean {
  switch (action.kind) {
    case "click":
    case "clickCoords":
    case "type":
    case "press":
    case "drag":
    case "select":
    case "fill":
    case "insertText":
    case "evaluate":
      return true;
    case "wait":
      return typeof action.fn === "string" && action.fn.trim().length > 0;
    case "batch":
      return action.actions.some(containsProtectedMutation);
    default:
      return false;
  }
}

/**
 * Guard every agent interaction while a fill session owns the tab. Submission
 * is only available through the separately approved browser_login path.
 */
export function assertVaultFillActAllowed(
  targetId: string | undefined,
  action: BrowserActRequest,
): void {
  const protectedSession = targetId ? hasActiveVaultFill(targetId) : hasAnyActiveVaultFill();
  if (!protectedSession) {
    return;
  }
  if (containsScript(action)) {
    throw new Error(
      "act:evaluate and act:wait --fn are blocked while a password fill session is active; navigate or close the filled tab.",
    );
  }
  if (containsProtectedMutation(action)) {
    throw new Error(
      "Browser interactions are blocked while a password fill session is active; use the approved browser_login submit flow, or navigate/close the filled tab.",
    );
  }
}

export function scrubVaultFillText(targetId: string | undefined, text: string): string {
  if (!targetId) {
    return text;
  }
  const session = sessions.get(targetId);
  if (!session) {
    return text;
  }
  let scrubbed = text;
  for (const secret of session.secrets) {
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join(MASK);
    }
  }
  return scrubbed;
}

export function scrubVaultFillValue<T>(targetId: string | undefined, value: T): T {
  if (!targetId) {
    return value;
  }
  const session = sessions.get(targetId);
  if (!session) {
    return value;
  }
  const seen = new WeakSet<object>();
  const scrub = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return scrubVaultFillText(targetId, candidate);
    }
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    if (seen.has(candidate)) {
      return candidate;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.map(scrub);
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      result[key] = scrub(entry);
    }
    return result;
  };
  return scrub(value) as T;
}
