const targets = new Map<string, number>();
const applied = new Map<string, number>();
let readyScheduled = false;

/**
 * Right dock geometry is one shared set of STATIC reservation widths on html:
 * each dock's panel width, the following dock's right offset, and the shell
 * margin all read `--oc-<prefix>-reserve-right`. Motion runs as local
 * transitions on those consumers (panel width/right, shell margin-right),
 * gated by the inherited static `--oc-dock-motion-duration` clock, so every
 * consumer starts in the same frame and stays synchronized without an
 * inherited animated property restyling the whole tree each frame.
 * Transitions stay off until the first painted frame so restored docks do not
 * animate on boot.
 */
export function ensureRightDockMotionReady(): void {
  if (readyScheduled || typeof document === "undefined") {
    return;
  }
  readyScheduled = true;
  window.requestAnimationFrame(() => {
    document.documentElement.classList.add("dock-motion-ready");
  });
}

/** Dock order matches the sibling right-offset sums in the panel styles and
 * the shell margin: each dock's offset is the sum of the reservations before it. */
const DOCK_ORDER: readonly string[] = [
  "terminal",
  "browser",
  "desktop",
  "link-reader",
  "assistant",
];

const panelGetters = new Map<string, Set<() => Element | null>>();

/**
 * Static reservation targets are NON-INHERITED registered properties written on
 * the consumers that read them (each dock panel and the shell). Declaring them
 * on `html` would make every target change restyle the whole document, which is
 * exactly the per-toggle cost this owner must not pay.
 */
function registerReservationProperties(): void {
  if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") {
    return;
  }
  for (const prefix of DOCK_ORDER) {
    try {
      // Universal syntax without an initial value keeps the CSS `var(..., x)`
      // fallbacks meaningful for a consumer that has not been written yet,
      // while `inherits: false` keeps a target change off the document tree.
      CSS.registerProperty({ name: widthVar(prefix), syntax: "*", inherits: false });
    } catch {
      // Already registered (a second module instance or a page-level rule).
    }
  }
}

/** The targets currently written for `prefix` (drawn value while a motion retargets). */
function assignedWidth(prefix: string): number {
  return applied.get(prefix) ?? targets.get(prefix) ?? 0;
}

/**
 * Writes every known reservation target where it is read: the shell (plate
 * margin) and each registered dock panel (own width/right offsets). Values are
 * unchanged most of the time, so this is idempotent and does not invalidate.
 */
export function applyRightDockReservations(): void {
  if (typeof document === "undefined" || targets.size === 0) {
    return;
  }
  const prefixes = [...targets.keys()];
  const write = (element: Element | null) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    for (const prefix of prefixes) {
      element.style.setProperty(widthVar(prefix), `${assignedWidth(prefix)}px`);
    }
  };
  write(document.querySelector(".shell"));
  for (const getters of panelGetters.values()) {
    for (const getter of getters) {
      write(getter());
    }
  }
}

/**
 * Registers a dock's outer panel getter so the shared owner can read drawn
 * geometry on reversals. Embedded/fullscreen/bottom panels never carry the
 * var-driven inline width and are ignored by the drawn reader. Returns an
 * unregister function.
 */
export function registerRightDockPanel(prefix: string, getter: () => Element | null): () => void {
  let getters = panelGetters.get(prefix);
  if (!getters) {
    getters = new Set();
    panelGetters.set(prefix, getters);
  }
  getters.add(getter);
  applyRightDockReservations();
  return () => {
    getters.delete(getter);
    if (getters.size === 0) {
      panelGetters.delete(prefix);
    }
  };
}

export type RightDockMotionDirection = "opening" | "closing";

export type RightDockMotionEvent = {
  prefix: string;
  phase: "start" | "end";
  direction?: RightDockMotionDirection;
};

const motionListeners = new Set<(event: RightDockMotionEvent) => void>();
const activeMotions = new Map<string, RightDockMotionDirection>();

/**
 * Bounded motion lifecycle notifications for measurement-quiesce consumers
 * (transcript virtualizer/end-anchor, hover-marquee). Exactly one `start` when
 * a dock begins moving and one `end` when it settles or cancels; a reversal
 * keeps the motion active and emits nothing, and nothing is emitted per frame.
 * Multiple docks emit independent per-prefix events; consumers aggregate.
 */
export function subscribeRightDockMotion(
  listener: (event: RightDockMotionEvent) => void,
): () => void {
  motionListeners.add(listener);
  return () => {
    motionListeners.delete(listener);
  };
}

/** Marks a dock's motion active; repeated calls (reversals) are deduplicated. */
export function beginRightDockMotion(prefix: string, direction: RightDockMotionDirection): void {
  if (activeMotions.has(prefix)) {
    return;
  }
  activeMotions.set(prefix, direction);
  for (const listener of motionListeners) {
    listener({ prefix, phase: "start", direction });
  }
}

/** Marks a dock's motion settled/cancelled; only emits for an active motion. */
export function endRightDockMotion(prefix: string): void {
  if (!activeMotions.delete(prefix)) {
    return;
  }
  for (const listener of motionListeners) {
    listener({ prefix, phase: "end" });
  }
}

function widthVar(prefix: string): string {
  return `--oc-${prefix}-reserve-right`;
}

/** Properties whose transitions carry a consumer's drawn dock geometry. */
const GEOMETRY_TRANSITION_PROPERTIES: ReadonlySet<string> = new Set([
  "width",
  "right",
  "left",
  "margin-right",
]);

function isEasingGeometry(element: Element | null): boolean {
  if (
    !element ||
    typeof element.getAnimations !== "function" ||
    typeof CSSTransition === "undefined"
  ) {
    return false;
  }
  return element
    .getAnimations()
    .some(
      (animation) =>
        animation instanceof CSSTransition &&
        animation.playState === "running" &&
        GEOMETRY_TRANSITION_PROPERTIES.has(animation.transitionProperty),
    );
}

/**
 * True when every dock consumer already rests at its target: no dock is
 * mid-motion in this owner, and no panel or plate is still easing a geometry
 * property. A fresh motion can then start from the static targets directly,
 * because the interpolation start is each consumer's drawn value either way.
 * The active-motion map alone is not enough: a cancelled or completed motion
 * can leave a real local transition running for part of a frame.
 */
function dockGeometryIsSettled(): boolean {
  if (activeMotions.size > 0) {
    return false;
  }
  for (const getters of panelGetters.values()) {
    for (const getter of getters) {
      if (isEasingGeometry(getter())) {
        return false;
      }
    }
  }
  return !isEasingGeometry(document.querySelector(".shell"));
}

/**
 * Sets one dock's static target width. `animate` is false for boot/restore/
 * resize: the shared clock is suppressed for one flush so every consumer
 * (panel width, sibling offsets, shell margin) snaps to the new target
 * together instead of easing toward it.
 */
export function setRightDockWidth(prefix: string, widthPx: number, animate: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  targets.set(prefix, widthPx);
  if (applied.get(prefix) === widthPx) {
    return;
  }
  if (animate) {
    // A target change while a consumer is still drawing restarts EVERY consumer
    // from its drawn geometry on one fresh clock. Local transitions interpolate
    // each consumer independently, so leaving a moving sibling on its older
    // clock would let the margin's interpolated sum drift from the sum of the
    // drawn panel widths.
    if (!dockGeometryIsSettled()) {
      retargetRightDockMotion();
      return;
    }
    // Fresh open/close: every consumer already rests at its target, so the same
    // static write starts panel width, sibling offsets, and the plate margin on
    // one clock without an inherited-clock freeze that restyles the whole tree.
    applied.set(prefix, widthPx);
    applyRightDockReservations();
    return;
  }
  const root = document.documentElement;
  root.classList.add("dock-motion-retarget");
  applied.set(prefix, widthPx);
  applyRightDockReservations();
  // Commit the new value while the consumer transitions are suppressed.
  void root.getBoundingClientRect();
  root.classList.remove("dock-motion-retarget");
}

function rightDockedPanel(prefix: string): HTMLElement | null {
  for (const getter of panelGetters.get(prefix) ?? []) {
    const element = getter();
    if (
      element instanceof HTMLElement &&
      element.style.width.includes(widthVar(prefix)) &&
      // The computed width only tracks the reservation while a local width
      // transition owns it; overlay overrides (mobile width:auto !important)
      // and clamped boxes must fall through to the prefix-sum readers below.
      typeof element.getAnimations === "function" &&
      typeof CSSTransition !== "undefined" &&
      element
        .getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === "width",
        )
    ) {
      return element;
    }
  }
  return null;
}

/**
 * Reads each reservation's DRAWN value. Moving docks read their own panel's
 * drawn width (the local width transition interpolates the reservation).
 * Settled docks read their last committed target — their consumers are not
 * interpolating. A moving dock whose panel is not yet drawn (fresh-open mount
 * window) is recovered from a following sibling's drawn right offset or the
 * shell margin, both prefix sums over the already-known drawn values.
 */
function readDrawnWidths(): Map<string, number> {
  const known = [...targets.keys()];
  const prefixes = [
    ...DOCK_ORDER.filter((prefix) => targets.has(prefix)),
    ...known.filter((prefix) => !DOCK_ORDER.includes(prefix)),
  ];
  const drawn = new Map<string, number>();
  const panels = new Map<string, HTMLElement>();
  for (const prefix of prefixes) {
    const panel = rightDockedPanel(prefix);
    if (panel) {
      panels.set(prefix, panel);
      drawn.set(prefix, panel.getBoundingClientRect().width);
    } else if (!activeMotions.has(prefix)) {
      drawn.set(prefix, applied.get(prefix) ?? targets.get(prefix) ?? 0);
    }
  }
  const shell = document.querySelector<HTMLElement>(".shell");
  const shellStyle = shell ? getComputedStyle(shell) : null;
  const inset = shellStyle
    ? Number.parseFloat(shellStyle.getPropertyValue("--shell-plate-inset")) || 0
    : 0;
  const margin = shellStyle ? Number.parseFloat(shellStyle.marginRight) : Number.NaN;
  const valueOf = (prefix: string) => drawn.get(prefix) ?? targets.get(prefix) ?? 0;
  for (const prefix of prefixes) {
    if (drawn.has(prefix)) {
      continue;
    }
    const sibling = prefixes.slice(prefixes.indexOf(prefix) + 1).find((p) => panels.has(p));
    if (sibling) {
      const panel = panels.get(sibling)!;
      const right = Number.parseFloat(getComputedStyle(panel).right) || 0;
      const before = prefixes.slice(0, prefixes.indexOf(sibling)).filter((p) => p !== prefix);
      drawn.set(prefix, Math.max(0, right - before.reduce((sum, p) => sum + valueOf(p), 0)));
    } else if (Number.isFinite(margin)) {
      const others = prefixes.filter((p) => p !== prefix);
      drawn.set(
        prefix,
        Math.max(0, margin - inset - others.reduce((sum, p) => sum + valueOf(p), 0)),
      );
    } else {
      drawn.set(prefix, applied.get(prefix) ?? targets.get(prefix) ?? 0);
    }
  }
  return drawn;
}

/**
 * The shared one-clock restart: freezes every consumer at its drawn geometry
 * for one flush, then restarts all of them toward their latest targets on a
 * fresh 200ms ease-out clock. Used for reversals AND for any animated target
 * change, because local transitions interpolate each consumer independently —
 * without a joint restart the margin's interpolated sum would drift from the
 * sum of the drawn panel widths whenever one dock moves while another is still
 * in flight. Panel widths, sibling offsets, and the shell margin continue from
 * the actual drawn frame with no snap and no consumer on an older clock.
 */
export function retargetRightDockMotion(): void {
  if (typeof document === "undefined" || targets.size === 0) {
    return;
  }
  const root = document.documentElement;
  const drawn = readDrawnWidths();
  root.classList.add("dock-motion-retarget");
  for (const [prefix, value] of drawn) {
    applied.set(prefix, value);
  }
  applyRightDockReservations();
  void root.getBoundingClientRect();
  root.classList.remove("dock-motion-retarget");
  for (const [prefix, target] of targets) {
    applied.set(prefix, target);
  }
  applyRightDockReservations();
}

registerReservationProperties();
