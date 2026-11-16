import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";
import "./resizable-divider.ts";

type DockLayoutHost = ReactiveControllerHost & { readonly isConnected: boolean };

type DockLayoutControllerOptions<TDock extends DockPanelPlacement> = {
  layout: DockPanelLayoutStore<TDock>;
  reservationPrefix: string;
  isAvailable: () => boolean;
  isFullscreen?: () => boolean;
  maxWidth?: () => number;
  reserveViewport?: boolean;
  onResize?: () => void;
  /** The dock's outer panel, used to observe the real width transition. */
  panelElement?: () => Element | null;
};

export class DockLayoutController<TDock extends DockPanelPlacement> implements ReactiveController {
  open = false;
  dock: TDock;
  height: number;
  width: number;

  private suppressed = false;
  private persistedOpen = false;
  private motionDirection: "opening" | "closing" | undefined;
  private motionWidthPx: number | undefined;
  private motionContentWidthPx: number | undefined;
  private motionHidden = false;
  private motionFrame: number | undefined;
  private motionGeneration = 0;
  private motionReservationDeferred = false;
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, this.options.layout.maxHeight());
    const width = Math.min(this.width, this.maxWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    this.height = height;
    this.width = width;
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  };

  constructor(
    private readonly host: DockLayoutHost,
    private readonly options: DockLayoutControllerOptions<TDock>,
  ) {
    this.dock = options.layout.defaults.dock;
    this.height = options.layout.defaults.height;
    this.width = options.layout.defaults.width;
    host.addController(this);
  }

  hostConnected(): void {
    if (this.isFullscreen()) {
      this.open = this.options.isAvailable();
      return;
    }
    const layout = this.options.layout.load();
    this.persistedOpen = layout.open;
    this.open = layout.open && this.options.isAvailable();
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = Math.min(layout.width, this.maxWidth());
    window.addEventListener("resize", this.onViewportResize);
  }

  hostDisconnected(): void {
    window.removeEventListener("resize", this.onViewportResize);
    this.cancelMotion();
    this.clearReservation();
  }

  /**
   * The panel stays mounted until the real width/opacity transition finishes,
   * so the frame has something to animate out. All other state readers still
   * see `open` immediately.
   */
  get renderVisible(): boolean {
    return this.open || this.motionDirection === "closing";
  }

  /** Motion presentation harness classes; empty at rest. */
  get motionClassName(): string {
    if (!this.motionDirection) {
      return "";
    }
    return this.motionHidden
      ? "dock-panel--motion dock-panel--motion-hidden"
      : "dock-panel--motion";
  }

  /**
   * The inline size for a right/bottom dock. During the right-dock motion the
   * width comes from the animation state instead of the settled preference, and
   * the content width keeps the target size (ZCode's temporary
   * `--side-pane-content-width`).
   */
  panelStyle(dock: "bottom" | "right", height: number, width: number): string {
    if (dock === "bottom") {
      return `height:${height}px`;
    }
    if (this.motionDirection) {
      return `width:${this.motionWidthPx ?? width}px;--oc-dock-content-width:${
        this.motionContentWidthPx ?? width
      }px`;
    }
    return `width:${width}px`;
  }

  setOpen(open: boolean, persist = true): void {
    if (open === this.open && this.motionDirection) {
      // A repeated request for the state the motion is already heading toward
      // must not collapse the temporary frame into the settled size.
      if (persist) {
        this.persist();
      }
      this.host.requestUpdate();
      return;
    }
    const animate = open !== this.open && this.canAnimateOpenClose();
    const hadPanel = Boolean(this.options.panelElement?.());
    this.open = open;
    if (animate) {
      this.beginMotion(open, hadPanel);
    } else {
      this.cancelMotion();
      this.syncReservation();
    }
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  hideWithoutPersisting(): void {
    this.setOpen(false, false);
  }

  /** Hide during route takeovers without losing the persisted open preference.
   * Suppression blocks automatic restores, but explicit opens still win.
   * Returns true when the caller must resume its surface after the takeover. */
  setSuppressed(suppressed: boolean): boolean {
    if (this.suppressed === suppressed) {
      return false;
    }
    this.suppressed = suppressed;
    if (suppressed) {
      this.hideWithoutPersisting();
      return false;
    }
    return this.restoreOpenState();
  }

  restoreOpenState(): boolean {
    if (
      this.suppressed ||
      !this.options.isAvailable() ||
      this.open ||
      (!this.isFullscreen() && !this.persistedOpen)
    ) {
      return false;
    }
    this.setOpen(true, false);
    return true;
  }

  setDock(dock: TDock, persist = true): void {
    this.cancelMotion();
    this.dock = dock;
    this.syncReservation();
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  persist(): void {
    this.persistedOpen = this.open;
    this.options.layout.save({
      open: this.open,
      dock: this.dock,
      height: this.height,
      width: this.width,
    });
  }

  syncReservation(): void {
    // The motion commits the reservation together with the panel width on its
    // target frame; incidental updates during the transition must not move the
    // plate early.
    if (this.motionReservationDeferred || !this.reservesViewport()) {
      return;
    }
    const visible = this.options.isAvailable() && this.open;
    const root = document.documentElement.style;
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-bottom`,
      visible && this.dock === "bottom" ? `${this.height}px` : "0px",
    );
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-right`,
      visible && this.dock === "right" ? `${this.width}px` : "0px",
    );
  }

  private resize(event: CustomEvent<{ splitRatio: number }>): void {
    const horizontal = this.dock === "bottom";
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const size = Math.min(maximum, Math.max(minimum, (1 - event.detail.splitRatio) * this.size()));
    if (horizontal) {
      this.height = size;
    } else {
      this.width = size;
    }
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  }

  private size(): number {
    return this.dock === "bottom" ? window.innerHeight : window.innerWidth;
  }

  renderResizer(classPrefix: string, label: string): TemplateResult | typeof nothing {
    if (this.isFullscreen() || this.dock === "main") {
      return nothing;
    }
    const horizontal = this.dock === "bottom";
    const size = this.size();
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const current = horizontal ? this.height : this.width;
    return html`<resizable-divider
      class="${classPrefix}-resizer ${classPrefix}-resizer--${this.dock}"
      .orientation=${horizontal ? "horizontal" : "vertical"}
      .label=${label}
      .splitRatio=${1 - current / size}
      .minRatio=${1 - maximum / size}
      .maxRatio=${1 - minimum / size}
      .measureRatio=${() => 1 - (horizontal ? this.height : this.width) / this.size()}
      .measureSize=${() => this.size()}
      @resize=${(event: CustomEvent<{ splitRatio: number }>) => this.resize(event)}
      @resize-end=${() => this.persist()}
    ></resizable-divider>`;
  }

  /**
   * ZCode animates only the explicit open/close of a right-docked side pane on
   * a viewport-reserving desktop host. Bottom docks, fullscreen, embedded hosts,
   * and reduced motion snap.
   */
  private canAnimateOpenClose(): boolean {
    return (
      this.dock === "right" &&
      this.reservesViewport() &&
      this.options.isAvailable() &&
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
      typeof Element !== "undefined" &&
      typeof Element.prototype.getAnimations === "function"
    );
  }

  private beginMotion(opening: boolean, hadPanel: boolean): void {
    this.cancelMotionFrame();
    const generation = ++this.motionGeneration;
    const width = this.width;
    // A reversal continues from the panel's current rendered width; only a
    // fresh mount starts at zero.
    const currentWidth = hadPanel
      ? this.options.panelElement?.()?.getBoundingClientRect().width
      : undefined;
    this.motionDirection = opening ? "opening" : "closing";
    this.motionWidthPx = currentWidth ?? (opening ? 0 : width);
    this.motionContentWidthPx = width;
    this.motionHidden = opening;
    this.motionReservationDeferred = true;
    // Let the opening frame mount at zero width / zero opacity first; the next
    // frame commits the target and both transitions run from that frame.
    void this.host.updateComplete.then(() => {
      if (generation !== this.motionGeneration) {
        return;
      }
      this.motionFrame = window.requestAnimationFrame(() => {
        this.motionFrame = undefined;
        if (generation !== this.motionGeneration) {
          return;
        }
        this.motionWidthPx = opening ? width : 0;
        this.motionHidden = !opening;
        // The reserved shell area and the panel edge change in the same frame,
        // so the plate and the dock move on one clock.
        this.motionReservationDeferred = false;
        this.syncReservation();
        this.host.requestUpdate();
        void this.host.updateComplete.then(() => this.watchMotion(generation));
      });
    });
  }

  private watchMotion(generation: number): void {
    if (generation !== this.motionGeneration) {
      return;
    }
    const element = this.options.panelElement?.();
    const animations =
      element && typeof CSSTransition !== "undefined"
        ? element
            .getAnimations()
            .filter(
              (animation): animation is CSSTransition =>
                animation instanceof CSSTransition &&
                (animation.transitionProperty === "width" ||
                  animation.transitionProperty === "opacity"),
            )
        : [];
    if (animations.length === 0) {
      this.finishMotion(generation);
      return;
    }
    // Completion and cancellation both settle through the real transitions;
    // no timer guesses the end.
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() =>
      this.finishMotion(generation),
    );
  }

  private finishMotion(generation: number): void {
    if (generation !== this.motionGeneration) {
      return;
    }
    this.clearMotionState();
    this.syncReservation();
    this.host.requestUpdate();
  }

  private cancelMotion(): void {
    this.motionGeneration += 1;
    this.cancelMotionFrame();
    this.clearMotionState();
  }

  private cancelMotionFrame(): void {
    if (this.motionFrame !== undefined) {
      window.cancelAnimationFrame(this.motionFrame);
      this.motionFrame = undefined;
    }
  }

  private clearMotionState(): void {
    this.motionReservationDeferred = false;
    this.motionDirection = undefined;
    this.motionWidthPx = undefined;
    this.motionContentWidthPx = undefined;
    this.motionHidden = false;
  }

  private clearReservation(): void {
    if (!this.reservesViewport()) {
      return;
    }
    const root = document.documentElement.style;
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-bottom`, "0px");
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-right`, "0px");
  }

  // Only a standalone dock owns its panel's viewport reservation. Embedded, fullscreen,
  // and inline hosts are laid out by their parent, and the standalone dock of the same
  // panel can be open at the same time, so they neither reserve nor clear its properties.
  private reservesViewport(): boolean {
    return (
      this.options.reserveViewport !== false &&
      !this.isFullscreen() &&
      !(this.host instanceof HTMLElement && this.host.hasAttribute("embedded"))
    );
  }

  private isFullscreen(): boolean {
    return this.options.isFullscreen?.() === true;
  }

  private maxWidth(): number {
    return Math.max(
      this.options.layout.minWidth,
      Math.min(
        this.options.layout.maxWidth(),
        this.options.maxWidth?.() ?? Number.POSITIVE_INFINITY,
      ),
    );
  }
}
