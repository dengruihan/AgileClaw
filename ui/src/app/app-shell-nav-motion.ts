import { isMobileNavLayout } from "./mobile-nav-layout.ts";

type RouteStateSignal = {
  readonly location?: {
    readonly pathname?: string;
    readonly search?: string;
    readonly hash?: string;
  };
};

/** The router facts a motion needs to notice a real SPA navigation. */
type RouterRouteSignal = {
  getState(): RouteStateSignal;
  subscribeSelector(
    selector: (state: RouteStateSignal) => string,
    listener: (next: string) => void,
    equal?: (previous: string, next: string) => boolean,
  ): () => boolean;
};

export interface ShellNavMotionHost {
  readonly isConnected: boolean;
  readonly updateComplete: Promise<boolean>;
  readonly routeState: { readonly routeId?: string };
  readonly runtime?: { readonly router?: RouterRouteSignal };
  readonly navDrawerOpen?: boolean;
  desktopNavigationExpanded?: boolean;
  readonly context?: {
    readonly navigation: {
      readonly snapshot: { readonly navCollapsed: boolean };
      update(patch: { navCollapsed: boolean }): void;
    };
  };
  querySelector(selectors: string): Element | null;
  closeNavDrawer?(options?: { restoreFocus?: boolean }): void;
}

export type ShellNavMotionIntent = {
  collapsed: boolean;
  /** Applies the navigation state; runs at the barely visible handoff. */
  apply: (collapsed: boolean) => void;
  /** Runs when the motion rests, including the instant fallback path. */
  settle?: (collapsed: boolean) => void;
};

const SHELL_SELECTOR = ".shell";
const NAV_SELECTOR = ".shell-nav";
const CONTENT_SELECTOR = "#control-ui-main";
const ASSISTANT_SELECTOR = "openclaw-assistant-panel";
// Shadow-root dock surfaces whose inline start follows the navigation width.
// Right-anchored docks own a viewport edge and never move on a nav toggle, so
// they are skipped instead of animated.
const DOCK_PANELS = [
  ["openclaw-terminal-panel", ".tp"],
  ["openclaw-browser-panel", ".bp"],
  ["openclaw-desktop-panel", ".bp"],
  ["openclaw-link-reader-panel", ".bp"],
] as const;

const DEFAULT_DURATION_MS = 200;
const DEFAULT_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
// The single relayout sits inside the fade. The outgoing surface travels this
// share of the distance while it fades out; the incoming surface covers the
// rest while it fades back in, so the visible position stays continuous across
// the faint handoff.
const OUTGOING_TRAVEL = 0.45;
// A reversal that already relaid out first fades the current surface out from
// wherever it is, then brings the restored layout back in.
const REVERSE_OUT_MS = 60;
// Opacity drops on the first frames instead of lingering near full strength, so
// the hidden relayout never freezes a barely faded column on screen.
const FADE_OUT_EASE = "cubic-bezier(0.2, 0.85, 0.35, 1)";
// The handoff keeps a faint ghost instead of clearing the plate: the shell
// relayout (and its first-time layer raster on real GPUs) can hold one frame for
// tens of milliseconds, and a fully transparent column would flash the plate.
// The relayout is unreadable at this opacity, and the reveal starts from here.
const HANDOFF_OPACITY = 0.12;
const ANIMATION_PREFIX = "shell-nav-";
const SLIDE_ANIMATION = `${ANIMATION_PREFIX}slide`;
const OUT_ANIMATION = `${ANIMATION_PREFIX}out`;
const IN_ANIMATION = `${ANIMATION_PREFIX}in`;
const RETURN_ANIMATION = `${ANIMATION_PREFIX}return`;

type VisualState = { readonly opacity: number; readonly x: number };

type ActiveMotion = {
  readonly intent: ShellNavMotionIntent;
  readonly surfaces: readonly HTMLElement[];
  readonly inDuration: number;
  readonly ease: string;
  readonly routeId: string | undefined;
  readonly finalCollapsed: boolean;
  animations: readonly Animation[];
  readonly slide: Animation;
  routeUnsubscribe?: () => boolean;
};

/**
 * Couples the chat column and the moving dock surfaces to one desktop nav
 * toggle clock with live DOM animation only.
 *
 * There is exactly one unavoidable relayout: the shell grid track snaps to the
 * other navigation width, and every in-flow chat component (header, transcript,
 * composer) reflows with it. Instead of snapshotting the old frame, the owner
 * fades the outgoing surfaces out while translating them a share of the way,
 * applies the navigation state at the faint handoff, then fades the new
 * layout back in while it finishes the translation. Only opacity and transform
 * animate, so the layout runs once, input, selection, focus, and scrolling stay
 * native throughout, and no overlay ever covers a control.
 *
 * Docks whose inline start follows the nav width take part in the same clock;
 * right-anchored docks are zero-delta and stay untouched. A toggle during the
 * motion retargets from the current opacity/position: before the relayout the
 * surfaces simply return to rest, after it they fade out from the current frame,
 * restore the other layout at the faint handoff, and fade back in from the same
 * screen position. Mobile drawers, reduced motion, and engines without the Web
 * Animations API keep the instant snap.
 */
export class ShellNavMotionOwner {
  private generation = 0;
  private active: ActiveMotion | undefined;
  private navStylesHeld = false;
  private navTransition = "";
  private navVisibility = "";

  constructor(private readonly host: ShellNavMotionHost) {}

  /**
   * The navigation state the in-flight motion is heading toward. The context
   * store applies that state only at the hidden handoff, so a toggle during the
   * motion must flip this pending intent instead of reading the stale snapshot
   * (a second flip would otherwise read as the same direction and never
   * reverse).
   */
  private pendingNavigationState(): boolean | undefined {
    return this.active?.finalCollapsed;
  }

  /**
   * Runs the desktop navigation toggle. The store applies its state only at the
   * hidden handoff, so a toggle during the motion flips the pending intent
   * instead of reading the stale snapshot, and focus returns to the caller once
   * the collapsed layout settles (unless the user moved focus into the page).
   */
  runDesktopToggle(options: { dismissTransientMenus: () => void; restoreFocus: () => void }): void {
    const host = this.host;
    const pending = this.pendingNavigationState();
    const collapsed =
      pending === undefined
        ? host.navDrawerOpen ||
          !(host.context?.navigation.snapshot.navCollapsed && !host.desktopNavigationExpanded)
        : !pending;
    this.toggle({
      collapsed,
      apply: (next) => {
        host.desktopNavigationExpanded = false;
        if (next) {
          options.dismissTransientMenus();
        }
        host.closeNavDrawer?.();
        host.context?.navigation.update({ navCollapsed: next });
      },
      settle: (next) => {
        if (!next) {
          return;
        }
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          host.querySelector(NAV_SELECTOR)?.contains(active)
        ) {
          options.restoreFocus();
        }
      },
    });
  }

  /**
   * SPA navigation owns the next surface. Commit the pending navigation state
   * and drop every motion effect before that surface paints, in either phase.
   */
  settleRouteChange(): void {
    const motion = this.active;
    if (!motion) {
      return;
    }
    motion.intent.apply(motion.finalCollapsed);
    this.finish(this.generation);
  }

  /** Runs a desktop toggle: applies state at the hidden point, or snaps. */
  toggle(intent: ShellNavMotionIntent): void {
    const shell = this.element(SHELL_SELECTOR);
    const nav = this.element(NAV_SELECTOR);
    if (!shell || !nav || !this.canAnimate(shell)) {
      this.snap(intent);
      return;
    }
    const shellStyles = getComputedStyle(shell);
    const delta = navigationWidth(shellStyles, nav);
    const previous = this.active;
    const collapsed = intent.collapsed;
    const layoutCollapsed = shell.classList.contains("shell--nav-collapsed");
    const surfaces = delta > 0 ? this.movingSurfaces() : [];
    if (delta <= 0 || surfaces.length === 0 || (collapsed === layoutCollapsed && !previous)) {
      this.snap(intent);
      return;
    }
    // A superseded motion is replaced, not settled: its animation callbacks are
    // generation-guarded, so nothing else would release its route listener.
    previous?.routeUnsubscribe?.();
    if (previous) {
      previous.routeUnsubscribe = undefined;
    }
    const duration = readDuration(shellStyles);
    const ease = readEase(shellStyles);
    const inDuration = duration - Math.round(duration * OUTGOING_TRAVEL);
    // Signed layout offset applied at the hidden point: the collapsed column
    // starts one nav width further left.
    const moved = collapsed === layoutCollapsed ? 0 : collapsed ? -delta : delta;
    const visual = previous ? this.readVisual() : { opacity: 1, x: 0 };
    const superseded = previous?.animations ?? [];
    const generation = ++this.generation;
    const slide = this.animateSlide(nav, delta, collapsed, previous ? inDuration : duration, ease);
    previous?.slide.cancel();
    const motion: ActiveMotion = {
      intent,
      surfaces,
      inDuration,
      ease,
      routeId: this.host.routeState.routeId,
      finalCollapsed: collapsed,
      animations: [],
      slide,
    };
    this.active = motion;
    this.watchRouteChanges(motion);
    if (moved === 0) {
      // No relayout left to hide: the surfaces simply settle back to rest.
      const returning = this.animateSurfaces(
        motion,
        visual,
        { opacity: 1, x: 0 },
        inDuration,
        RETURN_ANIMATION,
      );
      this.replaceAnimations(motion, returning);
      this.cancelAll(superseded);
      void settled(returning).then(() => this.finish(generation));
      return;
    }
    if (visual.opacity > 0.001) {
      const outDuration = previous ? REVERSE_OUT_MS : duration - inDuration;
      const outTo = previous ? visual.x : visual.x + OUTGOING_TRAVEL * moved;
      const fadeOut = this.animateSurfaces(
        motion,
        visual,
        { opacity: HANDOFF_OPACITY, x: outTo },
        outDuration,
        OUT_ANIMATION,
        { ease: FADE_OUT_EASE },
      );
      this.replaceAnimations(motion, fadeOut);
      this.cancelAll(superseded);
      void settled(fadeOut).then(() => this.applyState(generation, outTo - moved, fadeOut));
      return;
    }
    // Already transparent (a held fade-out): the held animation keeps the
    // surface hidden until the incoming animation replaces it.
    this.applyState(generation, visual.x, superseded);
  }

  /** Shell disconnect/context teardown owns cleanup; no animation outlives it. */
  cancel(): void {
    this.generation += 1;
    const motion = this.active;
    this.active = undefined;
    motion?.routeUnsubscribe?.();
    this.cancelAll(motion ? [...motion.animations, motion.slide] : []);
    this.releaseNavStyles();
  }

  /**
   * A router location change is a real SPA navigation. Subscribing for the
   * motion's lifetime (no polling) lets the owner settle the pending nav state
   * and clear every effect before the destination surface paints.
   */
  private watchRouteChanges(motion: ActiveMotion): void {
    const router = this.host.runtime?.router;
    if (!router) {
      return;
    }
    const current = routeSignal(router.getState());
    motion.routeUnsubscribe = router.subscribeSelector(
      routeSignal,
      (next) => {
        if (next === current || this.active !== motion) {
          return;
        }
        motion.intent.apply(motion.finalCollapsed);
        this.finish(this.generation);
      },
      (previous, next) => previous === next,
    );
  }

  private snap(intent: ShellNavMotionIntent): void {
    this.cancel();
    const generation = this.generation;
    intent.apply(intent.collapsed);
    // The instant path still needs the host's update to commit before the
    // collapsed chrome exists; restoring focus any earlier falls back to the
    // content column. A later toggle/cancel invalidates this settle.
    void this.host.updateComplete.then(() => {
      if (generation === this.generation) {
        intent.settle?.(intent.collapsed);
      }
    });
  }

  private applyState(
    generation: number,
    incomingX: number,
    superseded: readonly Animation[],
  ): void {
    const motion = this.active;
    if (!motion || generation !== this.generation) {
      return;
    }
    if (motion.routeId !== this.host.routeState.routeId) {
      // SPA navigation owns the new surface; settle the navigation state and
      // drop the fade instead of painting a route through a half-faded column.
      motion.intent.apply(motion.intent.collapsed);
      this.finish(generation);
      return;
    }
    motion.intent.apply(motion.intent.collapsed);
    // Start the reveal in the same task as the state change: the layout commit
    // lands before this frame paints, so the relayout frame already carries the
    // incoming surface instead of an empty column.
    const entering = this.animateSurfaces(
      motion,
      { opacity: HANDOFF_OPACITY, x: incomingX },
      { opacity: 1, x: 0 },
      motion.inDuration,
      IN_ANIMATION,
    );
    this.replaceAnimations(motion, entering);
    this.cancelAll(superseded);
    void settled(entering).then(() => this.finish(generation));
  }

  private finish(generation: number): void {
    const motion = this.active;
    if (!motion || generation !== this.generation) {
      return;
    }
    this.active = undefined;
    motion.routeUnsubscribe?.();
    this.cancelAll(motion.animations);
    motion.slide.cancel();
    this.releaseNavStyles();
    motion.intent.settle?.(motion.finalCollapsed);
  }

  private animateSlide(
    nav: HTMLElement,
    delta: number,
    collapsed: boolean,
    duration: number,
    ease: string,
  ): Animation {
    if (!this.navStylesHeld) {
      this.navStylesHeld = true;
      this.navTransition = nav.style.transition;
      this.navVisibility = nav.style.visibility;
      nav.style.transition = "none";
      // The rail stays visible for the whole travel; the resting class hides
      // it when the motion settles.
      nav.style.visibility = "visible";
    }
    const from = translateX(getComputedStyle(nav).transform);
    return nav.animate(
      [
        { transform: `translateX(${from}px)` },
        { transform: `translateX(${collapsed ? -delta : 0}px)` },
      ],
      { duration, easing: ease, fill: "both", id: SLIDE_ANIMATION },
    );
  }

  private releaseNavStyles(): void {
    if (!this.navStylesHeld) {
      return;
    }
    this.navStylesHeld = false;
    const nav = this.element(NAV_SELECTOR);
    if (!nav) {
      return;
    }
    nav.style.visibility = this.navVisibility;
    // Commit the resting visibility while the transition is still suppressed;
    // restoring the declaration in the same recalc would replay the delayed
    // handoff the collapsed rule defines.
    void getComputedStyle(nav).visibility;
    nav.style.transition = this.navTransition;
  }

  private animateSurfaces(
    motion: ActiveMotion,
    from: VisualState,
    to: VisualState,
    duration: number,
    id: string,
    fade: { readonly ease?: string } = {},
  ): Animation[] {
    const fadeEase = fade.ease ?? "linear";
    const animations: Animation[] = [];
    for (const element of motion.surfaces) {
      // Movement follows the shared nav easing. Opacity is its own effect so it
      // can fade out on a quicker curve (and start the reveal a hair early)
      // while the travel stays on one clock.
      animations.push(
        element.animate(
          [{ transform: `translateX(${from.x}px)` }, { transform: `translateX(${to.x}px)` }],
          { duration, easing: motion.ease, fill: "both", id },
        ),
        element.animate([{ opacity: from.opacity }, { opacity: to.opacity }], {
          duration,
          easing: fadeEase,
          fill: "both",
          id,
        }),
      );
    }
    return animations;
  }

  private replaceAnimations(motion: ActiveMotion, animations: readonly Animation[]): void {
    const previous = motion.animations;
    motion.animations = animations;
    this.cancelAll(previous);
  }

  private cancelAll(animations: readonly Animation[] | undefined): void {
    for (const animation of animations ?? []) {
      animation.cancel();
    }
  }

  private movingSurfaces(): HTMLElement[] {
    const surfaces: HTMLElement[] = [];
    const content = this.element(CONTENT_SELECTOR);
    if (content) {
      surfaces.push(content);
    }
    for (const [tag, surface] of DOCK_PANELS) {
      const panel = this.element(tag);
      const element = panel?.shadowRoot?.querySelector(surface) ?? null;
      if (element instanceof HTMLElement && followsNavigation(element)) {
        surfaces.push(element);
      }
    }
    const assistant = this.element(ASSISTANT_SELECTOR)?.querySelector(".assistant-panel") ?? null;
    if (assistant instanceof HTMLElement && followsNavigation(assistant)) {
      surfaces.push(assistant);
    }
    return surfaces;
  }

  private readVisual(): VisualState {
    const content = this.element(CONTENT_SELECTOR);
    if (!content) {
      return { opacity: 1, x: 0 };
    }
    const styles = getComputedStyle(content);
    const opacity = Number.parseFloat(styles.opacity);
    return {
      opacity: Number.isFinite(opacity) ? opacity : 1,
      x: translateX(styles.transform),
    };
  }

  private canAnimate(shell: HTMLElement): boolean {
    return (
      this.host.isConnected &&
      typeof HTMLElement.prototype.animate === "function" &&
      !isMobileNavLayout() &&
      !shell.classList.contains("shell--mobile-nav") &&
      !shell.classList.contains("shell--embed") &&
      !(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    );
  }

  private element(selector: string): HTMLElement | null {
    const element = this.host.querySelector(selector);
    return element instanceof HTMLElement ? element : null;
  }
}

function settled(animations: readonly Animation[]): Promise<void> {
  return Promise.allSettled(animations.map((animation) => animation.finished)).then(
    () => undefined,
  );
}

function routeSignal(state: RouteStateSignal): string {
  const location = state.location;
  return `${location?.pathname ?? ""}${location?.search ?? ""}${location?.hash ?? ""}`;
}

function followsNavigation(element: HTMLElement): boolean {
  return [...element.classList].some(
    (className) => className.endsWith("--bottom") || className.endsWith("--main"),
  );
}

function readDuration(styles: CSSStyleDeclaration): number {
  // The built stylesheet minifies `200ms` to `.2s`, so parse both CSS time units.
  const value = styles.getPropertyValue("--shell-nav-slide-duration").trim();
  const match = /^(-?[\d.]+)(ms|s)?$/u.exec(value);
  const amount = Number.parseFloat(match?.[1] ?? "");
  const duration = match?.[2] === "s" ? amount * 1000 : amount;
  return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION_MS;
}

function readEase(styles: CSSStyleDeclaration): string {
  return styles.getPropertyValue("--shell-nav-slide-ease").trim() || DEFAULT_EASE;
}

function navigationWidth(styles: CSSStyleDeclaration, nav: HTMLElement): number {
  const width = Number.parseFloat(styles.getPropertyValue("--shell-nav-expanded-width"));
  if (Number.isFinite(width) && width > 0) {
    return width;
  }
  return nav.getBoundingClientRect().width;
}

function translateX(transform: string): number {
  if (!transform || transform === "none") {
    return 0;
  }
  try {
    return new DOMMatrixReadOnly(transform).m41;
  } catch {
    return 0;
  }
}
