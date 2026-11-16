import {
  sidebarDock,
  SIDEBAR_NARROW_BREAKPOINT_PX,
  type SidebarLayout,
} from "../sidebar-layout.ts";

type SidebarRegionMotionPhase = "idle" | "opening" | "closing";

const MOTION_SETTLE_GRACE_MS = 150;

function motionSupported(): boolean {
  // Platforms without the motion-preference API (jsdom fixtures) keep the
  // instant presentation; reduced motion snaps by product contract.
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function transitionDurationMs(region: HTMLElement): number {
  const raw = getComputedStyle(region).transitionDuration.split(",")[0]?.trim() ?? "0s";
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return raw.endsWith("ms") ? value : value * 1000;
}

/**
 * Open/close motion lifecycle for one chat sidebar region. The region runtime
 * drives reconcile() after each layout commit; the pane template reads
 * regionClasses() in the same commit that flips the layout, so the motion
 * classes land atomically with the grid change and no intermediate style
 * recalc can swallow the transition start. Closing holds the open presentation
 * (snapshot layout + --open) until the tracks finish easing to zero, keeping
 * panel content visible and mounted; settling invalidates the pane so the
 * natural closed classes replace the hold. One local grid-template-columns
 * transition on the shared shell clock — no inherited animated carrier and no
 * per-frame JS (M186).
 */
export class SidebarRegionMotion {
  private phase: SidebarRegionMotionPhase = "idle";
  private presentedOpen = false;
  private initialized = false;
  private ready = false;
  private scope: string | null = null;
  private lastLiveLayout: SidebarLayout = { columns: [] };
  private closingLayout: SidebarLayout | null = null;
  private settleTimer: number | null = null;
  private settleListeners: AbortController | null = null;
  private onSettle: (() => void) | null = null;

  constructor(private readonly invalidate: () => void) {}

  get motionActive(): boolean {
    return this.phase !== "idle";
  }

  get presentationLayout(): SidebarLayout {
    return this.closingLayout ?? this.lastLiveLayout;
  }

  private eligible(layout: SidebarLayout, collapsed: boolean): boolean {
    return (
      sidebarDock(layout) === "right" &&
      !collapsed &&
      layout.expanded !== true &&
      this.ready &&
      motionSupported()
    );
  }

  /**
   * The template initializes the lifecycle because the region runtime is lazy:
   * on the first open of an empty region the element upgrades only after the
   * open commit, and its first reconcile must see the closed presentation as
   * the baseline, not the already-open layout.
   */
  private ensureInitialized(layout: SidebarLayout): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.presentedOpen = layout.open === true;
    this.lastLiveLayout = layout;
    // Boot and restored presentations never animate; arm after first paint.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        this.ready = true;
      });
    } else {
      this.ready = true;
    }
  }

  /** Template-side class emission; reads the last reconciled phase. */
  regionClasses(layout: SidebarLayout, collapsed: boolean): string {
    this.ensureInitialized(layout);
    const open = layout.open === true;
    if (!this.eligible(layout, collapsed)) {
      return open ? "sidebar-region--open" : "";
    }
    if (this.phase === "idle" && open === this.presentedOpen) {
      return open ? "sidebar-region--open" : "";
    }
    // An edge or reversal always carries the motion transition; closing holds
    // the open presentation while the tracks ease back to zero.
    const closing = !open;
    return `sidebar-region--open sidebar-region--motion${
      closing ? " sidebar-region--closing" : ""
    }`;
  }

  reconcile(params: {
    region: HTMLElement | null;
    layout: SidebarLayout;
    narrow: boolean;
    availableWidth: number;
    scope: string;
    onSettle: () => void;
  }): void {
    const { region, layout, scope } = params;
    this.onSettle = params.onSettle;
    const collapsed =
      params.narrow ||
      (params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY) <
        SIDEBAR_NARROW_BREAKPOINT_PX;
    const open = layout.open === true;
    this.ensureInitialized(layout);
    this.scope ??= scope;
    const previousPresentation = this.presentationLayout;
    const eligible = this.eligible(layout, collapsed);
    if (scope !== this.scope) {
      // A different session's layout is a context switch, not a user toggle.
      this.scope = scope;
      this.snap(open);
    } else if (open === this.presentedOpen) {
      if (this.phase !== "idle") {
        if (!eligible || !region) {
          this.snap(open);
        } else if (this.phase === "closing" && open) {
          this.begin(region, "opening", null);
        } else if (!this.settleListeners) {
          this.armSettle(region);
        }
      }
    } else if (eligible && region) {
      this.begin(region, open ? "opening" : "closing", open ? null : previousPresentation);
    } else {
      this.snap(open);
    }
    this.lastLiveLayout = layout;
  }

  private begin(
    region: HTMLElement,
    phase: SidebarRegionMotionPhase,
    closingLayout: SidebarLayout | null,
  ): void {
    this.phase = phase;
    this.closingLayout = closingLayout;
    this.presentedOpen = true;
    this.armSettle(region);
  }

  private snap(open: boolean): void {
    const wasActive = this.phase !== "idle";
    this.cancelSettle();
    this.phase = "idle";
    this.closingLayout = null;
    this.presentedOpen = open;
    if (wasActive) {
      this.onSettle?.();
      this.invalidate();
    }
  }

  private armSettle(region: HTMLElement): void {
    this.cancelSettle();
    const listeners = new AbortController();
    this.settleListeners = listeners;
    region.addEventListener(
      "transitionend",
      (event) => {
        if (event.target === region && event.propertyName === "grid-template-columns") {
          this.settle();
        }
      },
      { signal: listeners.signal },
    );
    // The watchdog also settles projections whose transition never runs
    // (hidden pane, reduced-motion flip mid-flight, lost transitionend).
    this.settleTimer = window.setTimeout(
      () => this.settle(),
      transitionDurationMs(region) + MOTION_SETTLE_GRACE_MS,
    );
  }

  private settle(): void {
    if (this.phase === "idle") {
      return;
    }
    const open = this.phase === "opening";
    this.cancelSettle();
    this.phase = "idle";
    this.closingLayout = null;
    this.presentedOpen = open;
    this.onSettle?.();
    this.invalidate();
  }

  private cancelSettle(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.settleListeners?.abort();
    this.settleListeners = null;
  }

  dispose(): void {
    this.cancelSettle();
    this.phase = "idle";
    this.closingLayout = null;
    this.onSettle = null;
  }
}
