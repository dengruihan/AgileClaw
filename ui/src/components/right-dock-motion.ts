const targets = new Map<string, number>();
const applied = new Map<string, number>();
let readyScheduled = false;

function widthVar(prefix: string): string {
  return `--oc-${prefix}-reserve-right`;
}

/**
 * Right dock geometry is one shared set of registered widths: each dock's
 * panel width, the following dock's offset, and the shell margin are all
 * derived from `--oc-<prefix>-reserve-right`. CSS transitions each width on
 * the ZCode clock, so concurrently moving docks and their siblings always
 * resolve from the same drawn frame. Transitions stay off until the first
 * painted frame so restored docks do not animate on boot.
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

/** Sets one dock's target width. `animate` is false for boot/restore/resize. */
export function setRightDockWidth(prefix: string, widthPx: number, animate: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  targets.set(prefix, widthPx);
  if (applied.get(prefix) === widthPx) {
    return;
  }
  const root = document.documentElement;
  if (!animate) {
    root.classList.add("dock-motion-retarget");
  }
  root.style.setProperty(widthVar(prefix), `${widthPx}px`);
  applied.set(prefix, widthPx);
  if (!animate) {
    // Commit the new value while the property transition is suppressed.
    void root.getBoundingClientRect();
    root.classList.remove("dock-motion-retarget");
  }
}

/**
 * A reversal freezes every registered right-dock width at its drawn value for
 * one flush, then restarts each width to its latest target. All consumers
 * (panel width, sibling offsets, shell margin) follow those same values, so no
 * controller can leave another dock's transition on a different clock.
 */
export function retargetRightDockMotion(): void {
  if (typeof document === "undefined" || targets.size === 0) {
    return;
  }
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const current = new Map<string, number>();
  for (const prefix of targets.keys()) {
    const value = Number.parseFloat(computed.getPropertyValue(widthVar(prefix)));
    current.set(prefix, Number.isFinite(value) ? value : 0);
  }
  root.classList.add("dock-motion-retarget");
  for (const [prefix, value] of current) {
    root.style.setProperty(widthVar(prefix), `${value}px`);
    applied.delete(prefix);
  }
  void root.getBoundingClientRect();
  root.classList.remove("dock-motion-retarget");
  for (const [prefix, target] of targets) {
    root.style.setProperty(widthVar(prefix), `${target}px`);
    applied.set(prefix, target);
  }
}
