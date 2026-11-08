import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  DASHBOARD_DOCUMENT_ELEMENT,
  ensureCustomElementDefined,
} from "../../app/lazy-custom-element.ts";
import { completePanelRefresh, failPanelRefresh } from "../../components/panel-refresh-status.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  loadInstalledMarketplacePresets,
  orderMarketplacePresets,
  saveInstalledMarketplacePresets,
  type MarketplacePresetId,
} from "./marketplace-presets.ts";
import type { MarketplaceState } from "./marketplace-view.ts";
import { MonitoringController } from "./monitoring-controller.ts";
import { dashboardsRouteData } from "./route.ts";
import {
  renderDashboards,
  type DashboardGalleryFilters,
  type DashboardsRouteData,
} from "./view.ts";

const MONITORING_POLL_INTERVAL_MS = 15_000;

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;
  @property({ type: Boolean }) presented = true;

  @state() private filters: DashboardGalleryFilters = {
    query: "",
    ownerId: "",
    sort: "updated",
  };
  @state() private previewError: string | null = null;
  @state() private installedPresets: readonly MarketplacePresetId[] = [];
  @state() private marketplaceOpen = false;

  private observedSessions?: ApplicationContext["sessions"];
  private observedScopeId?: string | null;
  private marketplaceGatewayUrl = "";
  private unsubscribeList?: () => void;
  private data?: DashboardsRouteData;
  private listGeneration = 0;
  private monitoring?: MonitoringController;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => {
        this.bindList();
        return agentSelection.subscribe(() => this.bindList());
      },
    )
    .watchStore(() => this.monitoring);

  private readonly poll = new PollController(
    this,
    MONITORING_POLL_INTERVAL_MS,
    () => void this.monitoring?.refresh(),
    false,
    "visible",
  );

  constructor() {
    super();
    void this.poll;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncMonitoringLifecycle();
    void ensureCustomElementDefined(
      DASHBOARD_DOCUMENT_ELEMENT.tagName,
      DASHBOARD_DOCUMENT_ELEMENT.loadModule,
    )
      .then(() => this.requestUpdate())
      .catch((error: unknown) => {
        this.previewError = formatUiError(error);
      });
  }

  override disconnectedCallback() {
    this.listGeneration += 1;
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.observedSessions = undefined;
    this.observedScopeId = undefined;
    this.monitoring?.setPresented(false);
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.data = this.routeData;
    }
    this.syncMarketplaceScope();
    this.bindMonitoring();
    this.syncMonitoringLifecycle();
    this.bindList();
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("presented")) {
      this.monitoring?.setPresented(this.presented && this.isConnected);
    }
  }

  private get systemMonitoringInstalled(): boolean {
    return this.installedPresets.includes("system-monitoring");
  }

  /**
   * One monitoring owner per mounted dashboards page, and only while its preset
   * is installed. Removal, disconnect, or a credential/recovery-scope revision
   * retires the owner that captured the retired presentation.
   */
  private bindMonitoring(): void {
    const context = this.context;
    if (!context || !this.systemMonitoringInstalled) {
      this.retireMonitoring();
      return;
    }
    // The route is not scope-keyed, so an in-place credential/recovery-scope
    // revision must replace the owner that captured the retired scope.
    const scope = gatewayPresentationScope(context.gateway);
    if (this.monitoring?.context !== context || this.monitoring.scope !== scope) {
      this.retireMonitoring();
      this.monitoring = new MonitoringController(context);
    }
    // A queued update can still flush after the element leaves the document;
    // presenting there would restart reads nothing can retire.
    this.monitoring.setPresented(this.presented && this.isConnected);
  }

  private retireMonitoring(): void {
    this.monitoring?.setPresented(false);
    this.monitoring = undefined;
  }

  /** Installation owns the poll loop: no preset installed means no monitoring polling. */
  private syncMonitoringLifecycle(): void {
    if (this.systemMonitoringInstalled && this.isConnected) {
      this.poll.start();
    } else {
      this.poll.stop();
    }
  }

  /** Installed presets are device-local presentation state stored per Gateway origin. */
  private syncMarketplaceScope(): void {
    const gatewayUrl = this.context?.gateway.connection.gatewayUrl ?? "";
    if (gatewayUrl === this.marketplaceGatewayUrl) {
      return;
    }
    this.marketplaceGatewayUrl = gatewayUrl;
    this.installedPresets = loadInstalledMarketplacePresets(gatewayUrl);
    this.marketplaceOpen = false;
  }

  private commitPresets(next: readonly MarketplacePresetId[]): void {
    this.installedPresets = orderMarketplacePresets(next);
    saveInstalledMarketplacePresets(this.marketplaceGatewayUrl, this.installedPresets);
  }

  private marketplaceState(): MarketplaceState {
    return {
      open: this.marketplaceOpen,
      installed: this.installedPresets,
      openMarketplace: () => {
        this.marketplaceOpen = true;
      },
      closeMarketplace: () => {
        this.marketplaceOpen = false;
      },
      install: (id) => {
        if (!this.installedPresets.includes(id)) {
          this.commitPresets([...this.installedPresets, id]);
        }
      },
      uninstall: (id) => {
        if (this.installedPresets.includes(id)) {
          this.commitPresets(this.installedPresets.filter((preset) => preset !== id));
        }
      },
    };
  }

  private bindList(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const scopeId = context.agentSelection.state.scopeId?.trim() || null;
    if (sessions === this.observedSessions && scopeId === this.observedScopeId) {
      return;
    }
    this.unsubscribeList?.();
    this.observedSessions = sessions;
    this.observedScopeId = scopeId;
    const query = dashboardSessionListQuery(context.agentSelection.state.scopeId);
    const apply = (snapshot: ReturnType<typeof sessions.listSnapshot>) => {
      if (
        this.context !== context ||
        this.observedSessions !== sessions ||
        this.observedScopeId !== scopeId ||
        (!snapshot.result && !snapshot.error && this.data?.result)
      ) {
        return;
      }
      this.data = dashboardsRouteData(context, snapshot);
      this.requestUpdate();
      this.completeList(context, sessions, scopeId, query, snapshot);
    };
    this.unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (!snapshot.result && !snapshot.loading && context.gateway.snapshot.phase === "connected") {
      void sessions.refreshList({ ...query, force: true });
    }
  }

  private completeList(
    context: ApplicationContext,
    sessions: ApplicationContext["sessions"],
    scopeId: string | null,
    query: ReturnType<typeof dashboardSessionListQuery>,
    snapshot: ReturnType<ApplicationContext["sessions"]["listSnapshot"]>,
  ): void {
    const initialResult = snapshot.result;
    const generation = ++this.listGeneration;
    const gatewayScope = this.gateway.capture();
    if (!initialResult?.hasMore || snapshot.loading || snapshot.error || !gatewayScope) {
      return;
    }
    const isCurrent = () =>
      this.context === context &&
      this.observedSessions === sessions &&
      this.observedScopeId === scopeId &&
      this.listGeneration === generation &&
      this.gateway.isCurrent(gatewayScope);
    void fetchPagedSessionRows({
      initialResult,
      list: (offset) => sessions.list({ ...query, offset }),
      isCurrent,
      missingResultError: "dashboard enumeration returned no result",
      stalledPaginationError: "dashboard enumeration did not advance",
      incompletePaginationError: "dashboard enumeration was incomplete",
    })
      .then((rows) => {
        if (!rows || !isCurrent()) {
          return;
        }
        this.data = dashboardsRouteData(context, {
          ...snapshot,
          result: {
            ...initialResult,
            count: rows.length,
            hasMore: false,
            nextOffset: null,
            sessions: rows,
          },
        });
        this.requestUpdate();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        const status = failPanelRefresh(completePanelRefresh(), error, context.gateway.snapshot);
        this.data = dashboardsRouteData(context, { ...snapshot, error: status.error });
        this.requestUpdate();
      });
  }

  override render() {
    return renderDashboards(
      this.data,
      this.filters,
      {
        onQueryChange: (query) => {
          this.filters = { ...this.filters, query };
        },
        onOwnerChange: (ownerId) => {
          this.filters = { ...this.filters, ownerId };
        },
        onSortChange: (sort) => {
          this.filters = { ...this.filters, sort };
        },
        onNavigate: this.context?.navigate,
      },
      this.context?.gateway.snapshot,
      this.previewError,
      this.systemMonitoringInstalled ? this.monitoring : undefined,
      this.marketplaceState(),
    );
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
