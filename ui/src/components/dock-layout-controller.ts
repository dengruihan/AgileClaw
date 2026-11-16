import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";
import {
  ensureRightDockMotionReady,
  retargetRightDockMotion,
  setRightDockWidth,
} from "./right-dock-motion.ts";
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
  private motionContentWidthPx: number | undefined;
  private motionHidden = false;
  private motionFrame: number | undefined;
  private motionGeneration = 0;
  private hasHandledInitialVisibility = false;
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, this.options.layout.maxHeight());
    const width = Math.min(this.width, this.maxWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    const widthChanged = width !== this.width;
    this.height = height;
    this.width = width;
    if (widthChanged && this.motionDirection) {
      // Native window resize never animates. Move the shared target and the
      // temporary content width to the clamped size at once and restart the
      // motion watch on the surviving opacity transition.
      this.motionContentWidthPx = width;
      setRightDockWidth(
        this.options.reservationPrefix,
        this.motionDirection === "opening" ? width : 0,
        false,
      );
      const generation = ++this.motionGeneration;
      this.host.requestUpdate();
      void this.host.updateComplete.then(() => this.watchMotion(generation));
    } else {
      this.syncReservation();
    }
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
    this.hasHandledInitialVisibility = this.open;
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = Math.min(layout.width, this.maxWidth());
    window.addEventListener("resize", this.onViewportResize);
    ensureRightDockMotionReady();
    this.syncReservation();
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

  /** Motion presentation harness class; empty at rest. */
  get motionClassName(): string {
    return this.motionDirection && this.motionHidden ? "dock-panel--motion-hidden" : "";
  }

  /**
   * The inline size for a right/bottom dock. Right widths resolve from the
   * shared registered reservation width, so the panel frame, following dock
   * offsets, and shell margin all read the same animated value. During motion
   * the content keeps the target width (ZCode's temporary
   * `--side-pane-content-width`).
   */
  panelStyle(dock: "bottom" | "right", height: number, width: number): string {
    if (dock === "bottom") {
      return `height:${height}px`;
    }
    const panelWidth = `var(--oc-${this.options.reservationPrefix}-reserve-right, ${width}px)`;
    if (this.motionDirection) {
      return `width:${panelWidth};--oc-dock-content-width:${this.motionContentWidthPx ?? width}px`;
    }
    return `width:${panelWidth}`;
  }

  setOpen(open: boolean, persist = true, options: { instant?: boolean } = {}): void {
    if (open) {
      this.hasHandledInitialVisibility = true;
    }
    if (open === this.open && this.motionDirection) {
      // A repeated request for the state the motion is already heading toward
      // must not collapse the temporary frame into the settled size.
      if (persist) {
        this.persist();
      }
      this.host.requestUpdate();
      return;
    }
    const animate = !options.instant && open !== this.open && this.canAnimateOpenClose();
    this.open = open;
    if (animate) {
      this.beginMotion(open);
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
    // The first visible mount (e.g. availability arrives after boot) snaps,
    // matching ZCode's initial visible mount; later suppression restores ease.
    const instant = !this.hasHandledInitialVisibility;
    this.setOpen(true, false, { instant });
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
    if (!this.reservesViewport()) {
      return;
    }
    const visible = this.options.isAvailable() && this.open;
    const root = document.documentElement.style;
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-bottom`,
      visible && this.dock === "bottom" ? `${this.height}px` : "0px",
    );
    // A running motion already owns the shared width target; incidental
    // updates must not snap it.
    if (!this.motionDirection) {
      setRightDockWidth(
        this.options.reservationPrefix,
        visible && this.dock === "right" ? this.width : 0,
        false,
      );
    }
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

  private beginMotion(opening: boolean): void {
    const generation = ++this.motionGeneration;
    const width = this.width;
    if (this.motionDirection) {
      this.retargetMotion(opening, generation, width);
      return;
    }
    this.cancelMotionFrame();
    this.motionDirection = opening ? "opening" : "closing";
    this.motionContentWidthPx = width;
    this.motionHidden = true;
    // One registered width drives this dock, its following siblings, and the
    // shell margin. CSS transitions it on the ZCode clock.
    setRightDockWidth(this.options.reservationPrefix, opening ? width : 0, true);
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      if (generation !== this.motionGeneration) {
        return;
      }
      if (!opening) {
        this.watchMotion(generation);
        return;
      }
      // A fresh panel mounts with the hidden class so its opacity fades in.
      this.motionFrame = window.requestAnimationFrame(() => {
        this.motionFrame = undefined;
        if (generation !== this.motionGeneration) {
          return;
        }
        this.motionHidden = false;
        this.host.requestUpdate();
        void this.host.updateComplete.then(() => this.watchMotion(generation));
      });
    });
  }

  /**
   * A reversal updates this dock's target and asks the shared owner to freeze
   * every registered right-dock width at its drawn value, then restart all of
   * them to their latest targets in the same frame. Panel widths, sibling
   * offsets, and the shell margin therefore continue on one clock.
   */
  private retargetMotion(opening: boolean, generation: number, width: number): void {
    this.cancelMotionFrame();
    this.motionDirection = opening ? "opening" : "closing";
    this.motionContentWidthPx = width;
    this.motionHidden = !opening;
    setRightDockWidth(this.options.reservationPrefix, opening ? width : 0, true);
    retargetRightDockMotion();
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => this.watchMotion(generation));
  }

  private motionAnimations(): CSSTransition[] {
    const animations: CSSTransition[] = [];
    if (typeof CSSTransition === "undefined") {
      return animations;
    }
    const widthProperty = `--oc-${this.options.reservationPrefix}-reserve-right`;
    for (const animation of document.documentElement.getAnimations()) {
      if (
        animation instanceof CSSTransition &&
        animation.transitionProperty === widthProperty &&
        animation.playState !== "finished" &&
        animation.playState !== "idle"
      ) {
        animations.push(animation);
      }
    }
    const element = this.options.panelElement?.();
    for (const animation of element?.getAnimations() ?? []) {
      if (
        animation instanceof CSSTransition &&
        animation.transitionProperty === "opacity" &&
        animation.playState !== "finished" &&
        animation.playState !== "idle"
      ) {
        animations.push(animation);
      }
    }
    return animations;
  }

  private watchMotion(generation: number): void {
    if (generation !== this.motionGeneration) {
      return;
    }
    const animations = this.motionAnimations();
    if (animations.length === 0) {
      this.finishMotion(generation);
      return;
    }
    // Completion and cancellation both settle through the real transitions.
    // A shared-owner reversal can restart a sibling's width transition, so
    // re-check for its replacement instead of settling the sibling early.
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (generation !== this.motionGeneration) {
        return;
      }
      this.watchMotion(generation);
    });
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
    this.motionDirection = undefined;
    this.motionContentWidthPx = undefined;
    this.motionHidden = false;
  }

  private clearReservation(): void {
    if (!this.reservesViewport()) {
      return;
    }
    setRightDockWidth(this.options.reservationPrefix, 0, false);
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
