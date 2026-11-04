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

// Fields a consumer of a thrown error reads even when they are non-enumerable
// (`message`, `stack`, `cause` on Error) or identity-bearing (`name`, `code`,
// `status`). Identity fields keep their original text only while proven
// value-free; otherwise they are masked like any other secret-bearing text.
const ERROR_SURFACE_KEYS = ["message", "stack", "cause", "name", "code", "status"] as const;

const MAX_ERROR_SCRUB_DEPTH = 8;
const CIRCULAR_PLACEHOLDER = "[Circular]";
const WITHHELD_ERROR_MESSAGE =
  "Browser error withheld: the original error could not be scrubbed of an active vault fill value.";

/**
 * Scrub a thrown error so no readable field can still return an active fill
 * value, regardless of `logging.redact`. Ordinary mutable errors keep their
 * class, name, status, and code; a field that carries a secret is masked in
 * place. When any reachable field cannot be rewritten and re-read clean —
 * frozen objects, non-configurable accessors, unreadable or regenerating
 * getters — the original object is discarded and a sanitized replacement Error
 * is returned instead: fail closed rather than rethrow a secret. Route
 * failures are thrown before any target is proven, so their text is treated
 * like an aggregate result.
 */
export function scrubVaultFillError<T>(error: T): T {
  return scrubErrorWith(error, scrubVaultFillTextAll);
}

/** Scrub a thrown error with one tab's active fill secrets. */
export function scrubVaultFillErrorForTarget<T>(targetId: string | undefined, error: T): T {
  return scrubErrorWith(error, (text) => scrubVaultFillText(targetId, text));
}

function readErrorField(
  record: Record<string, unknown>,
  key: string,
): { value: unknown; readable: boolean } {
  try {
    return { value: record[key], readable: true };
  } catch {
    return { value: undefined, readable: false };
  }
}

function writeErrorField(target: object, key: string, value: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor && !descriptor.configurable) {
      // A non-configurable writable data property keeps its shape; only the
      // value may change. Read-only data and any accessor cannot be rewritten.
      if (!("value" in descriptor) || !descriptor.writable) {
        return false;
      }
      Object.defineProperty(target, key, { ...descriptor, value });
      return true;
    }
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: descriptor?.enumerable ?? true,
      configurable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function ownEnumerableKeys(candidate: object): string[] {
  try {
    return Object.keys(candidate);
  } catch {
    return [];
  }
}

function scrubErrorWith<T>(error: T, scrubText: (text: string) => string): T {
  if (typeof error === "string") {
    const scrubbed = scrubText(error);
    return (scrubbed === error ? error : new Error(scrubbed)) as T;
  }
  if (!error || typeof error !== "object") {
    return error;
  }
  let tainted = false;
  let beyondDepth = false;
  const seen = new WeakSet<object>();
  const verified = new WeakSet<object>();
  const visit = (candidate: object, depth: number): void => {
    if (depth > MAX_ERROR_SCRUB_DEPTH) {
      beyondDepth = true;
      return;
    }
    if (seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const keys = new Set<string>([...ERROR_SURFACE_KEYS, ...ownEnumerableKeys(candidate)]);
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch {
        descriptor = undefined;
      }
      const isOwnAccessor =
        descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined);
      const read = readErrorField(record, key);
      if (!read.readable) {
        tainted = true;
        continue;
      }
      if (isOwnAccessor) {
        // Snapshot the accessor into a data property so a later read cannot
        // regenerate the secret. Non-configurable accessors cannot be
        // replaced, so they can never be proven safe.
        const snapshot = typeof read.value === "string" ? scrubText(read.value) : read.value;
        if (!writeErrorField(candidate, key, snapshot)) {
          tainted = true;
          continue;
        }
      }
      const value = read.value;
      if (typeof value === "string") {
        const scrubbed = scrubText(value);
        if (scrubbed !== value && !writeErrorField(candidate, key, scrubbed)) {
          tainted = true;
        }
        continue;
      }
      if (!value || typeof value !== "object") {
        continue;
      }
      if (Array.isArray(value)) {
        if (depth + 1 > MAX_ERROR_SCRUB_DEPTH) {
          beyondDepth = true;
          continue;
        }
        for (let index = 0; index < value.length; index += 1) {
          const entryRead = readErrorField(
            value as unknown as Record<string, unknown>,
            String(index),
          );
          if (!entryRead.readable) {
            tainted = true;
            continue;
          }
          const entry = entryRead.value;
          if (typeof entry === "string") {
            const scrubbed = scrubText(entry);
            if (scrubbed !== entry) {
              try {
                value[index] = scrubbed;
              } catch {
                tainted = true;
              }
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
  const verify = (candidate: object, depth: number): void => {
    if (depth > MAX_ERROR_SCRUB_DEPTH) {
      beyondDepth = true;
      return;
    }
    if (verified.has(candidate)) {
      return;
    }
    verified.add(candidate);
    const record = candidate as Record<string, unknown>;
    const keys = new Set<string>([...ERROR_SURFACE_KEYS, ...ownEnumerableKeys(candidate)]);
    for (const key of keys) {
      const read = readErrorField(record, key);
      if (!read.readable) {
        tainted = true;
        continue;
      }
      const value = read.value;
      if (typeof value === "string") {
        if (scrubText(value) !== value) {
          tainted = true;
        }
        continue;
      }
      if (!value || typeof value !== "object") {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") {
            if (scrubText(entry) !== entry) {
              tainted = true;
            }
          } else if (entry && typeof entry === "object") {
            verify(entry, depth + 1);
          }
        }
        continue;
      }
      verify(value, depth + 1);
    }
  };
  try {
    visit(error, 0);
    verify(error, 0);
    // The formatter surface (`${error}`) reads name/message through any
    // custom toString; it must be clean too.
    const formatted = formatErrorText(error);
    if (formatted !== undefined && scrubText(formatted) !== formatted) {
      tainted = true;
    }
  } catch {
    tainted = true;
  }
  if (!tainted && !beyondDepth) {
    return error;
  }
  return buildSanitizedReplacement(error, scrubText) as T;
}

function formatErrorText(error: object): string | undefined {
  try {
    // The tool boundary stringifies non-Error throws (`toStructuredErrorObject`),
    // so observe what a consumer's formatter would produce for either shape.
    if (error instanceof Error) {
      return error.toString();
    }
    return JSON.stringify(error) ?? undefined;
  } catch {
    return undefined;
  }
}

function readErrorString(pick: () => unknown): string | undefined {
  try {
    const value = pick();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function errorRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

/**
 * Build a provably clean Error for objects that cannot be scrubbed in place.
 * Every string passes the mask, the structure is fresh data-only output, and
 * no getter or accessor of the original survives, so later reads cannot
 * regenerate a secret.
 */
function buildSanitizedReplacement(error: object, scrubText: (text: string) => string): Error {
  const record = error as Record<string, unknown>;
  const message = readErrorString(() => record.message);
  const serialized = readErrorString(() => JSON.stringify(error));
  const formatted = formatErrorText(error);
  const maskedMessage =
    message !== undefined
      ? scrubText(message)
      : serialized !== undefined
        ? scrubText(serialized)
        : formatted !== undefined
          ? scrubText(formatted)
          : "";
  const replacement = new Error(maskedMessage || WITHHELD_ERROR_MESSAGE);
  const stack = readErrorString(() => record.stack);
  if (stack) {
    replacement.stack = scrubText(stack);
  }
  const name = readErrorString(() => record.name);
  if (name) {
    replacement.name = scrubText(name);
  }
  for (const key of ["status", "code"] as const) {
    const read = readErrorField(record, key);
    if (!read.readable) {
      continue;
    }
    if (typeof read.value === "number" || typeof read.value === "boolean") {
      errorRecord(replacement)[key] = read.value;
    } else if (typeof read.value === "string" && read.value.length > 0) {
      errorRecord(replacement)[key] = scrubText(read.value);
    }
  }
  const cause = readErrorField(record, "cause");
  if (cause.readable && cause.value && typeof cause.value === "object") {
    (replacement as { cause?: unknown }).cause = projectScrubbedValue(
      cause.value,
      scrubText,
      new WeakSet(),
      1,
    );
  }
  const details = readErrorField(record, "details");
  if (details.readable && details.value && typeof details.value === "object") {
    errorRecord(replacement).details = projectScrubbedValue(
      details.value,
      scrubText,
      new WeakSet(),
      1,
    );
  }
  return replacement;
}

function projectScrubbedValue(
  value: unknown,
  scrubText: (text: string) => string,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    // Functions, symbols, and undefined cannot carry a masked payload into the
    // replacement; drop them rather than retain a live secret-bearing surface.
    return undefined;
  }
  if (depth > MAX_ERROR_SCRUB_DEPTH || seen.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => projectScrubbedValue(entry, scrubText, seen, depth + 1));
  }
  if (value instanceof Error) {
    const source = errorRecord(value);
    const message = readErrorString(() => value.message);
    const copy = new Error(message !== undefined ? scrubText(message) : WITHHELD_ERROR_MESSAGE);
    const stack = readErrorString(() => value.stack);
    if (stack) {
      copy.stack = scrubText(stack);
    }
    const name = readErrorString(() => value.name);
    if (name) {
      copy.name = scrubText(name);
    }
    const cause = readErrorField(source, "cause");
    if (cause.readable && cause.value && typeof cause.value === "object") {
      (copy as { cause?: unknown }).cause = projectScrubbedValue(
        cause.value,
        scrubText,
        seen,
        depth + 1,
      );
    }
    const copyRecord = errorRecord(copy);
    for (const key of ownEnumerableKeys(value)) {
      const read = readErrorField(source, key);
      if (!read.readable) {
        continue;
      }
      copyRecord[key] = projectScrubbedValue(read.value, scrubText, seen, depth + 1);
    }
    return copy;
  }
  const projected: Record<string, unknown> = {};
  for (const key of ownEnumerableKeys(value)) {
    const read = readErrorField(value as Record<string, unknown>, key);
    if (!read.readable) {
      continue;
    }
    projected[key] = projectScrubbedValue(read.value, scrubText, seen, depth + 1);
  }
  return projected;
}

function scrubValueWith<T>(value: T, scrubText: (text: string) => string): T {
  const seen = new WeakSet<object>();
  const scrub = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return scrubText(candidate);
    }
    if (typeof candidate === "function" || typeof candidate === "symbol") {
      // Coercion can expose the secret; JSON-shaped tool results never need them.
      return undefined;
    }
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    if (seen.has(candidate)) {
      // Returning the original here would re-attach an unscrubbed live object
      // to the result; a value-free placeholder keeps the output provably clean.
      return CIRCULAR_PLACEHOLDER;
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
