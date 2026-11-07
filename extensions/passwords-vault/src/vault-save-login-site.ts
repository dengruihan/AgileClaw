export type ParsedVaultSite = {
  originScheme: "https" | "http";
  originHost: string;
  originPort: number;
};

/**
 * Parse the agent-facing `site` parameter into the vault's exact origin.
 * Accepts a full http(s) URL (path and query are ignored) or a bare
 * `host[:port]`, which defaults to https. IDN hosts normalize to A-labels the
 * same way the fill origin comparison expects.
 */
export function parseVaultSiteParam(value: string): ParsedVaultSite | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host.length > 253) {
    return undefined;
  }
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  return { originScheme: scheme, originHost: host, originPort: port };
}

export function formatVaultSiteOrigin(site: ParsedVaultSite): string {
  const defaultPort = site.originScheme === "https" ? 443 : 80;
  return site.originPort === defaultPort
    ? `${site.originScheme}://${site.originHost}`
    : `${site.originScheme}://${site.originHost}:${String(site.originPort)}`;
}
