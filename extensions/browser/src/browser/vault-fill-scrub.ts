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
  documentId?: string;
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
export function registerVaultFillSecret(
  targetId: string,
  secret: string,
  documentId?: string,
): void {
  if (!targetId || !secret) {
    return;
  }
  const existing = sessions.get(targetId);
  const secrets = new Set(existing?.secrets ?? []);
  for (const variant of secretVariants(secret)) {
    secrets.add(variant);
  }
  sessions.set(targetId, {
    secrets: [...secrets].toSorted((a, b) => b.length - a.length),
    ...((documentId ?? existing?.documentId)
      ? { documentId: documentId ?? existing?.documentId }
      : {}),
  });
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

/**
 * Drop the session only when the browser proves the approved document was
 * replaced. A download, hash-only navigation, or a same-document navigation
 * keeps the filled document alive and must keep protection in place. If the
 * current document identity is unavailable, keep protection (fail closed).
 */
export function clearVaultFillSessionIfDocumentChanged(
  targetId: string | undefined,
  currentDocumentId: string | undefined,
): boolean {
  if (!targetId || !currentDocumentId) {
    return false;
  }
  const session = sessions.get(targetId);
  if (!session?.documentId || session.documentId === currentDocumentId) {
    return false;
  }
  sessions.delete(targetId);
  return true;
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
  return scrubTextWithSecrets(text, session.secrets);
}

function allFillSecrets(): string[] {
  const secrets = new Set<string>();
  for (const session of sessions.values()) {
    for (const secret of session.secrets) {
      secrets.add(secret);
    }
  }
  return [...secrets].toSorted((a, b) => b.length - a.length);
}

/** Mask every active fill secret; use for aggregate or uncertain target results. */
export function scrubVaultFillTextAll(text: string): string {
  return scrubTextWithSecrets(text, allFillSecrets());
}

function scrubTextWithSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (scrubbed.includes(secret)) {
      scrubbed = scrubbed.split(secret).join(MASK);
    }
  }
  return scrubbed;
}

export function scrubVaultFillValue<T>(targetId: string | undefined, value: T): T {
  return scrubValueWith(value, (text) => scrubVaultFillText(targetId, text));
}

/** Mask every active fill secret in a deep value. */
export function scrubVaultFillValueAll<T>(value: T): T {
  return scrubValueWith(value, scrubVaultFillTextAll);
}

const PRESERVED_ERROR_KEYS = new Set(["name", "status", "code"]);

/**
 * Scrub a thrown error in place so it keeps its class, name, status, and code
 * while `message`, `stack`, `cause`, and nested payloads (for example
 * `details`) can no longer return an active fill value. Route failures are
 * thrown before any target is proven, so their text is treated like an
 * aggregate result.
 */
export function scrubVaultFillError<T>(error: T): T {
  return scrubErrorWith(error, scrubVaultFillTextAll);
}

/** Scrub a thrown error with one tab's active fill secrets. */
export function scrubVaultFillErrorForTarget<T>(targetId: string | undefined, error: T): T {
  return scrubErrorWith(error, (text) => scrubVaultFillText(targetId, text));
}

function scrubErrorWith<T>(error: T, scrubText: (text: string) => string): T {
  if (typeof error === "string") {
    const scrubbed = scrubText(error);
    return (scrubbed === error ? error : new Error(scrubbed)) as T;
  }
  if (!error || typeof error !== "object") {
    return error;
  }
  const seen = new WeakSet<object>();
  const write = (target: object, key: string, value: unknown) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: descriptor?.enumerable ?? true,
        configurable: true,
      });
    } catch {
      // Frozen or accessor-only fields keep their original text.
    }
  };
  const visit = (candidate: object, depth: number) => {
    if (depth > 8 || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    // `message`, `stack`, and `cause` are own but non-enumerable on Error.
    const keys = new Set<string>(["message", "stack", "cause", ...Object.keys(record)]);
    for (const key of keys) {
      if (PRESERVED_ERROR_KEYS.has(key)) {
        continue;
      }
      let value: unknown;
      try {
        value = record[key];
      } catch {
        continue;
      }
      if (typeof value === "string") {
        const scrubbed = scrubText(value);
        if (scrubbed !== value) {
          write(candidate, key, scrubbed);
        }
        continue;
      }
      if (!value || typeof value !== "object") {
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const entry = value[index];
          if (typeof entry === "string") {
            const scrubbed = scrubText(entry);
            if (scrubbed !== entry) {
              value[index] = scrubbed;
            }
          } else if (entry && typeof entry === "object") {
            visit(entry, depth + 1);
          }
        }
        continue;
      }
      visit(value, depth + 1);
    }
  };
  visit(error, 0);
  return error;
}

function scrubValueWith<T>(value: T, scrubText: (text: string) => string): T {
  const seen = new WeakSet<object>();
  const scrub = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return scrubText(candidate);
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
