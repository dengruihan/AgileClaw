import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { t } from "../../i18n/index.ts";
import { formatByteSize, formatTimeAgo } from "../../lib/format.ts";
import "../../components/sparkline-tile.ts";
import type { MonitoringInventory, MonitoringRow } from "./monitoring-data.ts";
import {
  MONITORING_GATEWAY_STALE_MS,
  MONITORING_NODE_STALE_MS,
  monitoringMeasurements,
  type HostMeasurements,
  type MonitoringTelemetrySample,
} from "./monitoring-telemetry.ts";
import { DASHBOARD_PANEL_IDS, type DashboardPanelId } from "./panel-catalog.ts";

/** The mounted monitoring owner supplies these facts; the renderer owns no reads. */
export type MonitoringVitalsSource = {
  connected: boolean;
  inventory: MonitoringInventory | null;
  sampledAtMs: number | null;
  telemetryHistory: (id: string) => readonly MonitoringTelemetrySample[];
};

function bytes(value: number): string {
  return formatByteSize(value, {
    style: "legacy-binary",
    separator: " ",
    maxUnit: "tera",
    fractionDigits: (size, unit) => (unit === "tera" || size < 10 ? 1 : 0),
  });
}

function metricSamples(
  history: readonly MonitoringTelemetrySample[],
  read: (stats: HostMeasurements) => number | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const { at, stats } of history) {
    const value = read(stats);
    if (value === undefined || !Number.isFinite(value)) {
      samples.length = 0;
    } else {
      samples.push({ at, value });
    }
  }
  return samples;
}

export function renderMonitoringVitals(
  row: MonitoringRow,
  source: MonitoringVitalsSource,
  panels: readonly DashboardPanelId[] = DASHBOARD_PANEL_IDS,
) {
  const stats = monitoringMeasurements(row);
  if (!stats) {
    return html`<p class="dashboards-monitoring__no-telemetry">${t("systems.noTelemetry")}</p>`;
  }
  const selected = new Set(panels);
  const observedAt = row.node?.hostStats?.updatedAtMs ?? source.sampledAtMs;
  const gatewayHost = row.environment.id === "gateway";
  const lastKnown =
    !source.connected ||
    row.environment.status !== "available" ||
    Boolean(source.inventory?.errors[gatewayHost ? "systemInfo" : "nodes"]) ||
    (observedAt !== null &&
      Date.now() - observedAt >
        (gatewayHost ? MONITORING_GATEWAY_STALE_MS : MONITORING_NODE_STALE_MS));
  const retained = source.telemetryHistory(row.environment.id);
  const history = retained.length ? retained : [{ at: observedAt ?? 0, stats }];
  // An empty volume list cannot render a disk tile, so it keeps the legacy
  // single-volume reading instead of showing an empty panel.
  const disks = stats.disks?.length ? stats.disks : undefined;
  const showDisk = selected.has("disk");
  const renderDisk = (path: string | undefined, totalBytes: number | undefined) => html`
    <openclaw-sparkline
      class="gateway-vital dashboards-monitoring__vital dashboards-monitoring__vital--disk"
      title=${path ?? nothing}
      .label=${path ? `${t("systems.disk")} ${path}` : t("systems.disk")}
      .sub=${totalBytes === undefined ? "" : `/ ${bytes(totalBytes)}`}
      .samples=${metricSamples(history, (sample) =>
        path === undefined
          ? sample.disks === undefined
            ? sample.diskAvailableBytes
            : undefined
          : sample.disks?.find((disk) => disk.path === path)?.availableBytes,
      )}
      .format=${bytes}
      .autorange=${true}
    ></openclaw-sparkline>
  `;
  return keyed(
    row.environment.id,
    html`<div class="dashboards-monitoring__vitals" data-stale=${lastKnown}>
      <div
        class="dashboards-monitoring__vital-row ${showDisk && disks && disks.length !== 1 ? "dashboards-monitoring__vital-row--volumes" : ""}"
      >
        ${
          selected.has("load")
            ? html`<openclaw-sparkline
                class="gateway-vital dashboards-monitoring__vital dashboards-monitoring__vital--load"
                .label=${t("systems.load")}
                .sub=${t("systems.cpuCount", { count: String(stats.cpuCount) })}
                .samples=${metricSamples(history, (sample) => sample.loadAverage?.[0])}
                .format=${(value: number) => value.toFixed(2)}
                .floorMax=${stats.cpuCount}
              ></openclaw-sparkline>`
            : nothing
        }
        ${
          selected.has("memory")
            ? html`<openclaw-sparkline
                class="gateway-vital dashboards-monitoring__vital dashboards-monitoring__vital--memory"
                .label=${t("systems.memory")}
                .sub=${`/ ${bytes(stats.memoryTotalBytes)}`}
                .samples=${metricSamples(
                  history,
                  (sample) => sample.memoryTotalBytes - sample.memoryFreeBytes,
                )}
                .format=${bytes}
                .floorMax=${stats.memoryTotalBytes}
              ></openclaw-sparkline>`
            : nothing
        }
        ${
          !showDisk
            ? nothing
            : disks === undefined
              ? renderDisk(undefined, stats.diskTotalBytes)
              : repeat(
                  disks,
                  (disk) => disk.path,
                  (disk) => renderDisk(disk.path, disk.totalBytes),
                )
        }
      </div>
      <div class="dashboards-monitoring__caption">
        ${
          !lastKnown && history.length < 2
            ? html`<span>${t("systems.collectingHistory")}</span>`
            : nothing
        }
        ${
          observedAt === null
            ? nothing
            : html`<span class="dashboards-monitoring__sample-time"
                >${t(lastKnown ? "systems.lastKnown" : "systems.sampled", {
                  time: formatTimeAgo(Math.max(0, Date.now() - observedAt)),
                })}</span
              >`
        }
      </div>
    </div>`,
  );
}
