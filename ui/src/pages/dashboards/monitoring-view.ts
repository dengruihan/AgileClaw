import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import type { MonitoringInventory, MonitoringRow } from "./monitoring-data.ts";
import {
  monitoringKind,
  monitoringName,
  monitoringPlatform,
  monitoringShortId,
  monitoringStatus,
} from "./monitoring-labels.ts";
import type { MonitoringTelemetrySample } from "./monitoring-telemetry.ts";
import { renderMonitoringVitals } from "./monitoring-vitals.ts";

registerSystemsEnglish();

/** Facts the mounted owner publishes; the region renders them without reading the Gateway. */
export type MonitoringViewState = {
  inventory: MonitoringInventory | null;
  rows: MonitoringRow[];
  loading: boolean;
  error: string | null;
  connected: boolean;
  sampledAtMs: number | null;
  telemetryHistory: (id: string) => readonly MonitoringTelemetrySample[];
  refresh: (intent?: "automatic" | "manual") => Promise<void>;
};

const KIND_LABEL_KEYS = {
  host: "systems.host",
  worker: "systems.worker",
  node: "systems.node",
} as const;

const KIND_ORDER = { host: 0, node: 1, worker: 2 } as const;

function monitoredRows(state: MonitoringViewState): MonitoringRow[] {
  return state.rows.toSorted((left, right) => {
    const statusOrder =
      Number(right.environment.status === "available") -
      Number(left.environment.status === "available");
    return (
      statusOrder ||
      KIND_ORDER[monitoringKind(left)] - KIND_ORDER[monitoringKind(right)] ||
      monitoringName(left).localeCompare(monitoringName(right))
    );
  });
}

function renderMachine(state: MonitoringViewState, row: MonitoringRow) {
  const kind = monitoringKind(row);
  const platform = monitoringPlatform(row);
  // Gateway ids are opaque `worker:<uuid>` values; short fragments tell same-profile
  // workers apart. Plain ids already name themselves.
  const shortId =
    kind === "worker" && row.environment.id.includes(":")
      ? monitoringShortId(row.environment.id)
      : null;
  const meta = [t(KIND_LABEL_KEYS[kind]), platform ?? shortId].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  return html`<article
    class="dashboards-monitoring__machine"
    data-monitoring-machine=${row.environment.id}
    data-status=${row.environment.status}
  >
    <div class="dashboards-monitoring__machine-head">
      <i class="dashboards-monitoring__dot" aria-hidden="true"></i>
      <h3 class="dashboards-monitoring__machine-name">${monitoringName(row)}</h3>
      <span class="dashboards-monitoring__machine-status">${monitoringStatus(row)}</span>
    </div>
    <div class="dashboards-monitoring__machine-meta">${meta.join(" · ")}</div>
    ${renderMonitoringVitals(row, state)}
  </article>`;
}

function renderSkeletonBody() {
  return html`<div class="dashboards-monitoring__body" aria-busy="true">
    <span class="sr-only" role="status">${t("systems.loading")}</span>
    <div class="dashboards-monitoring__list" aria-hidden="true" inert>
      ${[0, 1].map(
        () => html`<div class="dashboards-monitoring__machine">
          <div class="skeleton skeleton-line dashboards-monitoring__skeleton-title"></div>
          <div class="skeleton skeleton-line skeleton-line--medium"></div>
          <div class="dashboards-monitoring__vital-row">
            ${[0, 1, 2].map(
              () => html`<div class="skeleton dashboards-monitoring__skeleton-tile"></div>`,
            )}
          </div>
        </div>`,
      )}
    </div>
  </div>`;
}

/** The dashboards page owns the controller; this region only renders its published facts. */
export function renderMonitoring(state: MonitoringViewState | undefined) {
  if (!state) {
    return html``;
  }
  const rows = monitoredRows(state);
  const online = rows.filter((row) => row.environment.status === "available").length;
  const summary = [`${online} ${t("systems.online")}`];
  if (rows.length > online) {
    summary.push(`${rows.length - online} ${t("systems.offline")}`);
  }
  const auxiliaryErrors = Object.values(state.inventory?.errors ?? {});
  return html`<section
    class="dashboards-monitoring"
    aria-label=${t("systems.title")}
    data-monitoring
  >
    <header class="dashboards-monitoring__header">
      <div>
        <h2>${t("systems.title")}</h2>
        ${
          state.inventory
            ? html`<p class="dashboards-monitoring__summary">${summary.join(" · ")}</p>`
            : nothing
        }
      </div>
      <div class="dashboards-monitoring__actions">
        <button
          type="button"
          class="dashboards-monitoring__refresh"
          aria-label=${t("systems.refresh")}
          title=${t("systems.refresh")}
          ?disabled=${state.loading || !state.connected}
          @click=${() => void state.refresh("manual")}
        >
          ${icons.refresh}
        </button>
      </div>
    </header>
    ${
      state.error
        ? html`<div
            class="dashboards-monitoring__callout dashboards-monitoring__callout--error"
            role="alert"
          >
            ${state.error}
          </div>`
        : nothing
    }
    ${
      state.inventory && !state.connected
        ? html`<div class="dashboards-monitoring__callout" role="status">
            ${t("systems.offlineGateway")}
          </div>`
        : nothing
    }
    ${
      auxiliaryErrors.length
        ? html`<details class="dashboards-monitoring__callout">
            <summary>${t("systems.errors")}</summary>
            ${auxiliaryErrors.map((error) => html`<p>${error}</p>`)}
          </details>`
        : nothing
    }
    ${
      state.inventory === null
        ? state.error
          ? null
          : renderSkeletonBody()
        : rows.length === 0
          ? html`<p class="dashboards-monitoring__empty" role="status">${t("systems.empty")}</p>`
          : html`<div class="dashboards-monitoring__list">
              ${rows.map((row) => renderMachine(state, row))}
            </div>`
    }
  </section>`;
}
