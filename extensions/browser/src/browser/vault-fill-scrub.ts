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
  // No active secret for this target: return the ordinary result unchanged.
  // The bounded projection (including its array cap) only applies while a
  // fill secret must be masked.
  if (!targetId || !hasActiveVaultFill(targetId)) {
    return value;
  }
  return scrubValueWith(value, (text) => scrubVaultFillText(targetId, text));
}

/** Mask every active fill secret in a deep value. */
export function scrubVaultFillValueAll<T>(value: T): T {
  if (allFillSecrets().length === 0) {
    return value;
  }
  return scrubValueWith(value, scrubVaultFillTextAll);
}

const MAX_ERROR_SCRUB_DEPTH = 8;
const MAX_ERROR_PROTOTYPE_DEPTH = 16;
const MAX_PROJECTED_ARRAY_ENTRIES = 1024;
const CIRCULAR_PLACEHOLDER = "[Circular]";
const WITHHELD_ERROR_MESSAGE =
  "Browser error withheld: the original error was replaced because it could not be proven free of an active vault fill value.";
const WITHHELD_RESULT_TEXT = "[withheld: active vault fill protection]";
const WITHHELD_SCRUB_RESULT: Readonly<Record<string, unknown>> = Object.freeze({
  content: Object.freeze([Object.freeze({ type: "text", text: WITHHELD_RESULT_TEXT })]),
  details: Object.freeze({ withheld: "vault_fill_protection" }),
});

/**
 * Scrub a thrown browser-tool error of every active fill secret, regardless of
 * `logging.redact`. While any secret applies, the original live object is
 * never rethrown: getters, custom `toString`/`toJSON`, prototypes, proxy traps,
 * and class identity can all regenerate or expose a value on a later read, so
 * the result is always a fresh inert Error whose fields are data-only copies
 * with every string and property name masked. The whole projection is bounded
 * at this boundary: any trap, revoked proxy, or unexpected failure while
 * secrets apply fails closed to a fixed value-free Error — never the thrown
 * value and never thrown error text. With no active secret the thrown value is
 * returned unchanged. Route failures are thrown before any target is proven,
 * so their text is treated like an aggregate result.
 */
export function scrubVaultFillError<T>(error: T): T {
  if (allFillSecrets().length === 0) {
    return error;
  }
  try {
    return inertErrorProjection(error, scrubVaultFillTextAll);
  } catch {
    return new Error(WITHHELD_ERROR_MESSAGE) as T;
  }
}

/** Scrub a thrown error with one tab's active fill secrets. */
export function scrubVaultFillErrorForTarget<T>(targetId: string | undefined, error: T): T {
  if (!targetId || !hasActiveVaultFill(targetId)) {
    return error;
  }
  try {
    return inertErrorProjection(error, (text) => scrubVaultFillText(targetId, text));
  } catch {
    return new Error(WITHHELD_ERROR_MESSAGE) as T;
  }
}

function inertErrorProjection<T>(error: T, scrubText: (text: string) => string): T {
  if (typeof error === "string") {
    const scrubbed = scrubText(error);
    return (scrubbed === error ? error : new Error(scrubbed)) as T;
  }
  if (typeof error === "symbol") {
    // A symbol's description is readable through String() coercion.
    return new Error(WITHHELD_ERROR_MESSAGE) as T;
  }
  if (typeof error === "function") {
    // A root function keeps its live formatter behavior; only a fresh inert
    // error may be rethrown while any secret applies.
    return new Error(WITHHELD_ERROR_MESSAGE) as T;
  }
  if (!error || typeof error !== "object") {
    return error;
  }
  return buildInertError(error, scrubText) as T;
}

/**
 * Read a field only through its own data-property descriptor. Accessors are
 * dropped unread: invoking an untrusted getter — even once — is exactly the
 * stateful-formatter surface that must not influence or survive the scrub.
 */
function readOwnDataField(target: object, key: string): { present: boolean; value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { present: false, value: undefined };
    }
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false, value: undefined };
  }
}

function ownEnumerableDataKeys(target: object): string[] {
  let keys: string[];
  try {
    keys = Object.keys(target);
  } catch {
    // A hostile ownKeys trap (or revoked proxy) makes enumeration unreliable:
    // fail closed at the public boundary rather than projecting an empty shell.
    throw SCRUB_UNREADABLE;
  }
  // Individual descriptor failures just drop that field; the enumeration
  // itself already succeeded.
  return keys.filter((key) => readOwnDataField(target, key).present);
}

/**
 * Internal marker for "the value cannot be structurally inspected" (revoked
 * proxy, hostile prototype/ownKeys trap). Thrown to the public scrub boundary,
 * which fails closed to a fixed value-free Error/result; it is value-free by
 * construction and never exposed to callers.
 */
class ScrubUnreadableError extends Error {
  constructor() {
    super("vault fill scrub could not inspect the value");
    this.name = "ScrubUnreadableError";
  }
}
const SCRUB_UNREADABLE = new ScrubUnreadableError();

/**
 * Structural Error check that never goes through `instanceof` (whose
 * `Symbol.hasInstance` path invokes a proxy's getPrototypeOf trap). A trap
 * failure or revoked proxy makes the value unreadable: the whole scrub fails
 * closed at the public boundary instead of guessing a shape.
 */
function hasErrorPrototype(value: object): boolean {
  try {
    let proto: object | null = Object.getPrototypeOf(value);
    for (let steps = 0; proto && steps < MAX_ERROR_PROTOTYPE_DEPTH; steps += 1) {
      if (proto === Error.prototype) {
        return true;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  } catch {
    throw SCRUB_UNREADABLE;
  }
}

/**
 * `Array.isArray` throws on a revoked proxy; a failure means the value cannot
 * be proven array-shaped, so the whole scrub fails closed at the boundary.
 */
function isArrayValue(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    throw SCRUB_UNREADABLE;
  }
}

/**
 * Define a projected field as an own data property. An assignment would route
 * a "__proto__"-shaped key through the Object prototype setter and let it
 * mutate (or collide with) inherited members of the fresh projection; masked
 * keys must stay plain data.
 */
function setInertField(target: Record<string, unknown>, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // An un-definable key is dropped with its value; the rest stays inert.
  }
}

function buildInertError(error: object, scrubText: (text: string) => string): Error {
  const projected = projectInertValue(error, scrubText, new WeakSet(), 0);
  if (
    typeof projected === "object" &&
    projected !== null &&
    Object.getPrototypeOf(projected) === Error.prototype
  ) {
    // Only this module's own `new Error` copies reach here with that
    // prototype; the cast narrows the structural check back to Error.
    return projected as Error;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    serialized = undefined;
  }
  // The projection is already inert data; masking again only guards the JSON
  // syntax around it.
  const replacement = new Error(
    serialized !== undefined ? scrubText(serialized) : WITHHELD_ERROR_MESSAGE,
  );
  (replacement as { cause?: unknown }).cause = projected;
  return replacement;
}

/**
 * Build a data-only masked copy: primitives pass through (strings masked),
 * functions and symbols are dropped, accessors are never read, property names
 * are masked exactly like values, and every object becomes a fresh plain
 * structure or Error copy with own data properties. No later read, formatter,
 * or serializer can regenerate a value from the result.
 */
function projectInertValue(
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
    // Functions and symbols cannot be carried as inert data.
    return undefined;
  }
  if (depth > MAX_ERROR_SCRUB_DEPTH || seen.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }
  seen.add(value);
  if (isArrayValue(value)) {
    // Length and entries come from own data descriptors only: a direct
    // `value.length` read or `.map()` would invoke proxy/accessor behavior.
    const lengthRead = readOwnDataField(value, "length");
    const length =
      typeof lengthRead.value === "number" &&
      Number.isFinite(lengthRead.value) &&
      lengthRead.value > 0
        ? Math.min(Math.floor(lengthRead.value), MAX_PROJECTED_ARRAY_ENTRIES)
        : 0;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const read = readOwnDataField(value, String(index));
      copy.push(
        read.present ? projectInertValue(read.value, scrubText, seen, depth + 1) : undefined,
      );
    }
    return copy;
  }
  if (hasErrorPrototype(value)) {
    const message = readOwnDataField(value, "message");
    const copy = new Error(
      typeof message.value === "string" && message.value.length > 0
        ? scrubText(message.value)
        : WITHHELD_ERROR_MESSAGE,
    );
    const stack = readOwnDataField(value, "stack");
    if (typeof stack.value === "string" && stack.value.length > 0) {
      copy.stack = scrubText(stack.value);
    }
    const name = readOwnDataField(value, "name");
    if (typeof name.value === "string" && name.value.length > 0) {
      copy.name = scrubText(name.value);
    }
    const cause = readOwnDataField(value, "cause");
    if (cause.present && cause.value !== null && cause.value !== undefined) {
      (copy as { cause?: unknown }).cause = projectInertValue(
        cause.value,
        scrubText,
        seen,
        depth + 1,
      );
    }
    const copyRecord = copy as unknown as Record<string, unknown>;
    for (const key of ownEnumerableDataKeys(value)) {
      if (key === "message" || key === "stack" || key === "name" || key === "cause") {
        // Already projected above; a second pass would hit the cycle guard.
        continue;
      }
      const projected = projectInertValue(
        readOwnDataField(value, key).value,
        scrubText,
        seen,
        depth + 1,
      );
      // Dropping a function (for example a custom `toString`) must remove the
      // key entirely; assigning undefined would shadow prototype behavior.
      if (projected !== undefined) {
        setInertField(copyRecord, scrubText(key), projected);
      }
    }
    return copy;
  }
  const projected: Record<string, unknown> = {};
  for (const key of ownEnumerableDataKeys(value)) {
    const entry = projectInertValue(readOwnDataField(value, key).value, scrubText, seen, depth + 1);
    if (entry !== undefined) {
      setInertField(projected, scrubText(key), entry);
    }
  }
  return projected;
}

function scrubValueWith<T>(value: T, scrubText: (text: string) => string): T {
  // Result scrubbing uses the same guarded data-descriptor projection as the
  // error path — never `Object.entries`, `.map()`, or live reads that could
  // invoke getters or proxy traps on the untrusted result. The whole scrub is
  // bounded at this public boundary: any trap, revoked proxy, or unexpected
  // failure fails closed to a fixed value-free withheld result instead of
  // throwing untrusted text at the tool boundary.
  try {
    return projectInertValue(value, scrubText, new WeakSet(), 0) as T;
  } catch {
    return WITHHELD_SCRUB_RESULT as T;
  }
}
