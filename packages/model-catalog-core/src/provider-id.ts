import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";

export function normalizeProviderId(provider: string): string {
  return normalizeLowercaseStringOrEmpty(provider);
}

/** Normalize provider ID before manifest-owned auth alias lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderId(provider);
}

export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(entries)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}

/** Fallback key for an endpoint whose host yields nothing usable. */
const CUSTOM_ENDPOINT_ID_FALLBACK = "custom";

/** Lowercases and slugs a requested provider key; non-ASCII input can empty it. */
export function normalizeEndpointId(raw: string): string {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Builds a stable custom provider id from an endpoint URL host and port. */
export function buildEndpointIdFromUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname.replace(/[^a-z0-9]+/gi, "-"));
    const port = url.port ? `-${url.port}` : "";
    const candidate = `custom-${host}${port}`;
    return normalizeEndpointId(candidate) || CUSTOM_ENDPOINT_ID_FALLBACK;
  } catch {
    return CUSTOM_ENDPOINT_ID_FALLBACK;
  }
}

/** Existing provider keys mapped to the base URL stored under each one. */
export function endpointIdOccupancy(
  providers: Record<string, unknown> | undefined,
): Map<string, string | undefined> {
  const occupied = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(providers ?? {})) {
    const id = normalizeProviderId(key);
    if (!id) {
      continue;
    }
    const baseUrl = asNullableRecord(value)?.baseUrl;
    occupied.set(id, typeof baseUrl === "string" && baseUrl ? baseUrl : undefined);
  }
  return occupied;
}

export type EndpointIdClaim = {
  /** Endpoint-derived or explicitly requested key to claim. */
  seed: string;
  /** Occupancy of existing provider keys, from `endpointIdOccupancy`. */
  occupied: ReadonlyMap<string, string | undefined>;
  /** Keys owned elsewhere (bundled overlays, plugin capabilities) that no claim may take. */
  isReserved?: (candidate: string) => boolean;
  /**
   * Re-onboarding rule: reuse the seed when the entry already serves this endpoint.
   * Omit it to claim a key that nothing uses yet, even against the same base URL.
   */
  reclaimSeed?: (occupiedBaseUrl: string | undefined) => boolean;
};

export type ClaimedEndpointId = {
  providerId: string;
  /** Set when the seed was unavailable and the claim carries a numeric suffix. */
  renamedFrom?: string;
};

/**
 * Claims one `models.providers` config key. Keys stay lowercase ASCII and are
 * derived from the endpoint, never from a display name, so a renamed provider
 * keeps the identity its model, credential, and secret references use.
 */
export function claimEndpointId(params: EndpointIdClaim): ClaimedEndpointId {
  const seed = normalizeEndpointId(params.seed) || CUSTOM_ENDPOINT_ID_FALLBACK;
  const taken = (candidate: string) =>
    params.occupied.has(candidate) || (params.isReserved?.(candidate) ?? false);
  if (taken(seed)) {
    if (!params.isReserved?.(seed) && params.reclaimSeed?.(params.occupied.get(seed))) {
      return { providerId: seed };
    }
    let suffix = 2;
    let candidate = `${seed}-${suffix}`;
    while (taken(candidate)) {
      suffix += 1;
      candidate = `${seed}-${suffix}`;
    }
    return { providerId: candidate, renamedFrom: seed };
  }
  return { providerId: seed };
}
