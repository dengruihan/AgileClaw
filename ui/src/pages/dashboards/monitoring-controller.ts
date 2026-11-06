import { registerListener } from "../../../../src/shared/listeners.js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadMonitoringInventory,
  projectMonitoringInventory,
  type MonitoringInventory,
  type MonitoringRow,
} from "./monitoring-data.ts";
import {
  MONITORING_GATEWAY_STALE_MS,
  MONITORING_NODE_STALE_MS,
  monitoringMeasurements,
  type MonitoringTelemetrySample,
} from "./monitoring-telemetry.ts";

const TELEMETRY_SAMPLE_LIMIT = 120;

/**
 * Single owner of machine inventory and measurement history for the dashboards
 * monitoring region. Route presentation owns the mounted read lifecycle; a
 * sidebar or gallery redraw never starts a second inventory reader.
 */
export class MonitoringController {
  readonly scope;
  inventory: MonitoringInventory | null = null;
  rows: MonitoringRow[] = [];
  loading = false;
  error: string | null = null;
  sampledAtMs: number | null = null;
  private readonly telemetry = new Map<string, readonly MonitoringTelemetrySample[]>();
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle;
  private subscriptions: Array<() => void> = [];
  private request: AbortController | undefined;
  private presented = false;
  private refreshQueued?: "automatic" | "manual";

  constructor(readonly context: ApplicationContext) {
    this.scope = gatewayPresentationScope(context.gateway);
    this.lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  }

  get current(): boolean {
    return this.scope === gatewayPresentationScope(this.context.gateway);
  }

  get connected(): boolean {
    return this.current && this.context.gateway.snapshot.phase === "connected";
  }

  get needsRefresh(): boolean {
    return this.inventory === null || this.refreshQueued !== undefined;
  }

  telemetryHistory(id: string): readonly MonitoringTelemetrySample[] {
    return this.current ? (this.telemetry.get(id) ?? []) : [];
  }

  subscribe(listener: () => void): () => void {
    return registerListener(this.listeners, listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private projectRows(): void {
    this.rows =
      this.inventory && this.current
        ? projectMonitoringInventory(
            this.inventory,
            this.context.sessions.state.result?.sessions ?? [],
          )
        : [];
  }

  private recordTelemetry(gatewaySampled: boolean): void {
    const currentIds = new Set(this.rows.map((row) => row.environment.id));
    for (const id of this.telemetry.keys()) {
      if (!currentIds.has(id)) {
        this.telemetry.delete(id);
      }
    }
    for (const row of this.rows) {
      const id = row.environment.id;
      const stats = monitoringMeasurements(row);
      if (!stats) {
        this.telemetry.delete(id);
        continue;
      }
      const gatewayHost = id === "gateway";
      if (gatewayHost && !gatewaySampled) {
        continue;
      }
      const at = row.node?.hostStats?.updatedAtMs ?? this.sampledAtMs;
      if (at === null) {
        continue;
      }
      const previous = this.telemetry.get(id) ?? [];
      const last = previous.at(-1);
      // node.list can return the same report across several UI polls.
      if (last && at <= last.at) {
        continue;
      }
      const staleAfter = gatewayHost ? MONITORING_GATEWAY_STALE_MS : MONITORING_NODE_STALE_MS;
      const history = last && at - last.at <= staleAfter ? previous : [];
      this.telemetry.set(id, [...history.slice(-(TELEMETRY_SAMPLE_LIMIT - 1)), { at, stats }]);
    }
  }

  /** The dashboards route presentation owns this lifecycle; leaving it releases every read. */
  setPresented(presented: boolean): void {
    if (this.presented === presented) {
      return;
    }
    this.presented = presented;
    if (!presented) {
      for (const unsubscribe of this.subscriptions) {
        unsubscribe();
      }
      this.subscriptions = [];
      this.cancelRefresh();
      return;
    }
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => {
        const changed = this.lifecycle.transition(snapshot);
        if (!this.current) {
          this.clear();
        } else if (changed) {
          this.cancelRefresh();
          this.telemetry.clear();
          if (snapshot.phase === "connected") {
            void this.refresh();
          }
        }
        this.notify();
      }),
      this.context.gateway.subscribeEvents((event) => {
        if (
          event.event === "presence" ||
          event.event === "node.pair.resolved" ||
          event.event === "node.runnerInventory.changed" ||
          event.event === "config.changed"
        ) {
          void this.refresh();
        }
      }),
      this.context.sessions.subscribe(() => {
        this.projectRows();
        this.notify();
      }),
    ];
    if (this.lifecycle.transition(this.context.gateway.snapshot)) {
      this.telemetry.clear();
    }
    if (!this.current) {
      this.clear();
    } else {
      void this.refresh();
    }
  }

  private cancelRefresh(): void {
    this.request?.abort();
    this.request = undefined;
    this.loading = false;
    this.refreshQueued = undefined;
  }

  private clear(): void {
    this.cancelRefresh();
    this.inventory = null;
    this.rows = [];
    this.error = null;
    this.sampledAtMs = null;
    this.telemetry.clear();
  }

  async refresh(intent: "automatic" | "manual" = "automatic"): Promise<void> {
    const snapshot = this.context.gateway.snapshot;
    if (this.lifecycle.transition(snapshot)) {
      this.telemetry.clear();
    }
    const scope = this.lifecycle.capture();
    if (
      !this.presented ||
      !this.current ||
      !scope ||
      !hasOperatorReadAccess(snapshot.hello?.auth ?? null)
    ) {
      return;
    }
    const refreshIntent = this.refreshQueued === "manual" ? "manual" : intent;
    // Hidden pages and event bursts retain one refresh without cancelling useful work.
    if (this.loading || document.visibilityState === "hidden") {
      this.refreshQueued = refreshIntent;
      return;
    }
    this.cancelRefresh();
    const request = new AbortController();
    this.request = request;
    const isCurrent = () =>
      this.presented && this.current && this.request === request && this.lifecycle.isCurrent(scope);
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      const inventory = await loadMonitoringInventory(this.context.gateway, {
        signal: request.signal,
        isCurrent,
        fresh: refreshIntent === "manual",
      });
      // A retired or hidden load keeps its retry with the poll/visibility owner;
      // re-queuing here would spin on a permanently unavailable read.
      if (!inventory || !isCurrent()) {
        return;
      }
      this.inventory = inventory;
      this.projectRows();
      this.sampledAtMs = inventory.gatewaySampledAtMs;
      this.recordTelemetry(true);
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this.request = undefined;
        this.notify();
        if (this.refreshQueued) {
          void this.refresh();
        }
      }
    }
  }
}
