import type { VaultFillOrigin } from "./vault-fill-types.js";
import { VaultError } from "./vault-types.js";

export type VaultFillOriginMismatch = "origin_mismatch" | "subdomain_mismatch" | "insecure_origin";

const DEFAULT_PORTS: Record<"https" | "http", number> = { https: 443, http: 80 };

function readPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser port is invalid.");
  }
  return value;
}

/**
 * Canonicalize an origin reported by the local browser. Node's URL parser
 * converts IDN hostnames to their A-label (punycode) form, so the result is the
 * same representation the vault stores.
 */
export function normalizeObservedFillOrigin(input: {
  scheme: unknown;
  host: unknown;
  port: unknown;
}): VaultFillOrigin {
  const scheme = input.scheme;
  if (scheme !== "https" && scheme !== "http") {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser scheme is invalid.");
  }
  if (typeof input.host !== "string" || input.host.length === 0 || input.host.length > 253) {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser host is invalid.");
  }
  const port = readPort(input.port);
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${input.host}:${String(port)}`);
  } catch {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser origin is invalid.");
  }
  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser origin is invalid.");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host.length > 253 || host.includes("*")) {
    throw new VaultError("VAULT_INVALID_INPUT", "Observed browser host is invalid.");
  }
  return { scheme, host, port };
}

export function normalizeStoredFillOrigin(input: {
  scheme: "https" | "http";
  host: string;
  port: number;
}): VaultFillOrigin {
  return normalizeObservedFillOrigin(input);
}

export function fillOriginKey(origin: VaultFillOrigin): string {
  return `${origin.scheme}://${origin.host}:${String(origin.port)}`;
}

export function formatFillOrigin(origin: VaultFillOrigin): string {
  const defaultPort = DEFAULT_PORTS[origin.scheme];
  return origin.port === defaultPort
    ? `${origin.scheme}://${origin.host}`
    : `${origin.scheme}://${origin.host}:${String(origin.port)}`;
}

function isSubdomainOf(candidate: string, parent: string): boolean {
  return candidate !== parent && candidate.endsWith(`.${parent}`);
}

/**
 * Compare the observed origin with the entry's exact origin. Scheme, host, and
 * port are always compared exactly; subdomain relation is only reported as a
 * distinct rejection so the operator/agent can see that no implicit widening
 * happened.
 */
export function compareFillOrigin(
  entry: VaultFillOrigin,
  observed: VaultFillOrigin,
): "match" | VaultFillOriginMismatch {
  const normalizedEntry = normalizeStoredFillOrigin(entry);
  const normalizedObserved = normalizeObservedFillOrigin(observed);
  if (normalizedObserved.scheme === "http" && normalizedEntry.scheme !== "http") {
    return "insecure_origin";
  }
  if (
    isSubdomainOf(normalizedObserved.host, normalizedEntry.host) ||
    isSubdomainOf(normalizedEntry.host, normalizedObserved.host)
  ) {
    return "subdomain_mismatch";
  }
  return normalizedEntry.scheme === normalizedObserved.scheme &&
    normalizedEntry.host === normalizedObserved.host &&
    normalizedEntry.port === normalizedObserved.port
    ? "match"
    : "origin_mismatch";
}
