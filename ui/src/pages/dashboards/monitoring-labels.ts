import { t } from "../../i18n/index.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import type { MonitoringRow } from "./monitoring-data.ts";

export function monitoringName(row: MonitoringRow): string {
  const named =
    row.gatewaySystemInfo?.machineName ?? row.environment.label ?? row.node?.displayName;
  if (named) {
    return named;
  }
  if (row.environment.id === "gateway") {
    return t("systems.host");
  }
  const worker = row.environment.worker;
  if (worker) {
    // A worker is best known by the session placed on it; otherwise by its
    // provider profile, matching the chat placement label.
    const placed = row.sessions.find((relation) => relation.kind === "placement")?.session;
    if (placed) {
      return placed.displayName ?? placed.label ?? placed.key;
    }
    if (worker.profileId) {
      return `${worker.providerId} · ${worker.profileId}`;
    }
  }
  return row.environment.id;
}

/** Short, stable fragment of a Gateway-owned id for telling same-profile workers apart. */
export function monitoringShortId(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1, id.lastIndexOf(":") + 7);
}

export function monitoringKind(row: MonitoringRow): "host" | "worker" | "node" {
  return row.environment.id === "gateway"
    ? "host"
    : row.environment.type === "node"
      ? "node"
      : "worker";
}

export function monitoringStatus(row: MonitoringRow): string {
  return t(
    row.environment.status === "available"
      ? "systems.online"
      : row.environment.status === "unavailable"
        ? "systems.offline"
        : "systems.statuses." + row.environment.status,
  );
}

export function monitoringPlatform(row: MonitoringRow): string | undefined {
  const platform = row.gatewaySystemInfo?.osLabel ?? row.environment.platform ?? row.node?.platform;
  return platform ? prettifyPlatform(platform, row.node?.deviceFamily) : undefined;
}
