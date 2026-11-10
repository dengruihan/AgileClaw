// Canonical formatting for one saved node-host Gateway candidate.
import type { NodeHostGatewayConfig } from "./config.js";

export function formatGatewayCandidateUrl(gateway: NodeHostGatewayConfig): string {
  const host = gateway.host ?? "127.0.0.1";
  const urlHost =
    host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const contextPath = gateway.contextPath
    ? gateway.contextPath.startsWith("/")
      ? gateway.contextPath
      : `/${gateway.contextPath}`
    : "";
  return `${scheme}://${urlHost}:${port}${contextPath}`;
}
