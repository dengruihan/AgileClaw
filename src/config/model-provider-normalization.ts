/** Normalizes display names for the provider-name uniqueness contract. */
export function normalizeModelProviderName(name: string): string {
  return name.trim().toLowerCase();
}

/** Normalizes an HTTP base URL for provider/model duplicate detection. */
export function normalizeModelProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return trimmed.replace(/\/+$/u, "");
  }
}

/** Builds a stable duplicate key for a model at one effective provider URL. */
export function buildProviderModelDedupKey(baseUrl: string, modelId: string): string {
  return JSON.stringify([normalizeModelProviderBaseUrl(baseUrl), modelId.trim()]);
}
