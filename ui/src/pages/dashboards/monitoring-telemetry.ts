import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import type { MonitoringRow } from "./monitoring-data.ts";

export const MONITORING_GATEWAY_STALE_MS = 30_000;
// Nodes publish once a minute; allow a missed report before marking their data stale.
export const MONITORING_NODE_STALE_MS = 120_000;

export type HostMeasurements = Pick<
  SystemInfoResult,
  | "cpuCount"
  | "loadAverage"
  | "memoryTotalBytes"
  | "memoryFreeBytes"
  | "diskTotalBytes"
  | "diskAvailableBytes"
  | "disks"
>;

export type MonitoringTelemetrySample = {
  at: number;
  stats: HostMeasurements;
};

export function monitoringMeasurements(row: MonitoringRow): HostMeasurements | undefined {
  return row.gatewaySystemInfo ?? row.node?.hostStats;
}
