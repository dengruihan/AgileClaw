/**
 * Session-scoped masking for values the vault fill broker inserted.
 *
 * This is deliberately independent of `logging.redact`: the fill executor owns
 * its own full-mask scrub so `logging.redact=off` cannot expose a filled value
 * through evaluate/text/snapshot results. Page JavaScript and co-attached CDP
 * clients can still read the DOM; this masks OpenClaw's own tool surfaces only.
 */

const DEFAULT_FILL_SCRUB_TTL_MS = 60_000;
const MASK = "***";

type FillSession = {
  secrets: string[];
  expiresAtMs: number;
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

function pruneExpired(nowMs: number): void {
  for (const [targetId, session] of sessions) {
    if (session.expiresAtMs <= nowMs) {
      sessions.delete(targetId);
    }
  }
}

export function registerVaultFillSecret(
  targetId: string,
  secret: string,
  options: { ttlMs?: number; nowMs?: number } = {},
): void {
  if (!targetId || !secret) {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_FILL_SCRUB_TTL_MS;
  const existing = sessions.get(targetId);
  sessions.set(targetId, {
    secrets: [...(existing?.secrets ?? []), ...secretVariants(secret)],
    expiresAtMs: Math.max(existing?.expiresAtMs ?? 0, nowMs + ttlMs),
  });
}

export function hasActiveVaultFill(targetId: string | undefined, nowMs = Date.now()): boolean {
  if (!targetId) {
    return false;
  }
  pruneExpired(nowMs);
  return sessions.has(targetId);
}

export function hasAnyActiveVaultFill(nowMs = Date.now()): boolean {
  pruneExpired(nowMs);
  return sessions.size > 0;
}

export function clearVaultFillSession(targetId: string | undefined): void {
  if (targetId) {
    sessions.delete(targetId);
  }
}

export function scrubVaultFillText(
  targetId: string | undefined,
  text: string,
  nowMs = Date.now(),
): string {
  if (!targetId) {
    return text;
  }
  pruneExpired(nowMs);
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

export function scrubVaultFillValue<T>(
  targetId: string | undefined,
  value: T,
  nowMs = Date.now(),
): T {
  if (!targetId) {
    return value;
  }
  pruneExpired(nowMs);
  const session = sessions.get(targetId);
  if (!session) {
    return value;
  }
  const seen = new WeakSet<object>();
  const scrub = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      return scrubVaultFillText(targetId, candidate, nowMs);
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
