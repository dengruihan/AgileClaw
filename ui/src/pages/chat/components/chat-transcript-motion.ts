// Consumer-side view of the bounded shell geometry motions that resize the
// chat column. The dock owner publishes one start/end per motion
// (right-dock-motion.ts); the two remaining gestures have no JS owner and only
// publish their own local transition (navigation rail width, chat sidebar
// region tracks). Consumers pause maintenance measurement for the window and
// reconcile once when the last gesture settles: intermediate eased widths must
// not drive row re-measurement, follow correction, or marquee measurement.
// Nothing is emitted per frame, and overlapping gestures aggregate into one
// active window until every one of them has ended.
import type { Virtualizer } from "@tanstack/virtual-core";
import { subscribeRightDockMotion } from "../../../components/right-dock-motion.ts";
import type { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { measureTranscriptRow, retainedTranscriptRowSize } from "./chat-transcript-geometry.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptViewportRect } from "./chat-transcript-viewport-rect.ts";

type GridTransitionSignal = { property: string; selector: string };

/** Local width transitions owned purely by CSS. */
const GRID_TRANSITIONS: readonly GridTransitionSignal[] = [
  { property: "width", selector: ".shell-nav" },
  { property: "grid-template-columns", selector: ".sidebar-region" },
];

// A lost transitionend (hidden pane, reduced-motion flip mid-flight) must not
// leave consumers quiesced: every started transition is bounded by its own
// clock plus the settle grace the region owner already uses.
const SETTLE_GRACE_MS = 150;
const WATCHDOG_FALLBACK_MS = 400;

const listeners = new Set<(active: boolean) => void>();
const activeDocks = new Set<string>();
const activeGridTransitions = new Map<Element, Set<string>>();
/** Cancel → replacement confirmations, one bounded frame per element+property. */
const cancelConfirmations = new Map<Element, Map<string, number>>();
const watchdogs = new Map<Element, Map<string, number>>();
let installed = false;
let notifiedActive = false;

export function isShellGeometryMotionActive(): boolean {
  return activeDocks.size > 0 || activeGridTransitions.size > 0;
}

/**
 * Notifies `listener` when the aggregate window opens and closes. The tracking
 * itself is process-wide: a consumer that subscribes mid-window reads the live
 * state from `isShellGeometryMotionActive()` instead of waiting for a start it
 * missed.
 */
export function subscribeShellGeometryMotion(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  install();
  return () => {
    listeners.delete(listener);
  };
}

function notifyIfChanged(): void {
  const active = isShellGeometryMotionActive();
  if (active === notifiedActive) {
    return;
  }
  notifiedActive = active;
  for (const listener of Array.from(listeners)) {
    listener(active);
  }
}

/**
 * Tracks gestures for the lifetime of the module: consumers come and go, and a
 * consumer that only reads the state (a composer anchor update, a layout owner)
 * must still see a gesture it never subscribed to.
 */
function install(): void {
  if (installed || typeof document === "undefined") {
    return;
  }
  installed = true;
  document.addEventListener("transitionrun", handleTransitionStart, true);
  document.addEventListener("transitionstart", handleTransitionStart, true);
  document.addEventListener("transitionend", handleTransitionEnd, true);
  document.addEventListener("transitioncancel", handleTransitionEnd, true);
  subscribeRightDockMotion((event) => {
    if (event.phase === "start") {
      activeDocks.add(event.prefix);
    } else {
      activeDocks.delete(event.prefix);
    }
    notifyIfChanged();
  });
}

function gridSignalFor(target: EventTarget | null, property: string): GridTransitionSignal | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return (
    GRID_TRANSITIONS.find(
      (signal) => signal.property === property && target.matches(signal.selector),
    ) ?? null
  );
}

/** Transition events carry `propertyName`; a plain Event fixture has none. */
function transitionProperty(event: Event): string {
  const property = Reflect.get(event, "propertyName");
  return typeof property === "string" ? property : "";
}

function handleTransitionStart(event: Event): void {
  const property = transitionProperty(event);
  if (!gridSignalFor(event.target, property) || !(event.target instanceof Element)) {
    return;
  }
  const target = event.target;
  // A replacement transition after a cancel is the same gesture: keep the
  // window open instead of publishing a false settle between the two runs.
  cancelPendingCancelConfirmation(target, property);
  let properties = activeGridTransitions.get(target);
  if (properties?.has(property)) {
    // A reversal or retarget restarts the clock but keeps the window open.
    armWatchdog(target, property);
    return;
  }
  if (!properties) {
    properties = new Set();
    activeGridTransitions.set(target, properties);
  }
  properties.add(property);
  armWatchdog(target, property);
  notifyIfChanged();
}

function handleTransitionEnd(event: Event): void {
  const target = event.target;
  const property = transitionProperty(event);
  if (event.type === "transitioncancel") {
    // A cancelled transition is usually replaced by a new run of the same
    // property in the next task (a reversal). Hold the window open for one
    // frame and settle only when no replacement arrived.
    scheduleCancelConfirmation(target, property);
    return;
  }
  endGridTransition(target, property);
}

function confirmCancelKey(target: Element): Map<string, number> {
  let frames = cancelConfirmations.get(target);
  if (!frames) {
    frames = new Map();
    cancelConfirmations.set(target, frames);
  }
  return frames;
}

function scheduleCancelConfirmation(target: EventTarget | null, property: string): void {
  if (!(target instanceof Element)) {
    return;
  }
  const properties = activeGridTransitions.get(target);
  if (!properties?.has(property)) {
    return;
  }
  const frames = confirmCancelKey(target);
  if (frames.has(property)) {
    return;
  }
  // One bounded confirmation step, never a per-frame loop: the replacement run
  // clears it, otherwise the next frame is the real settle.
  frames.set(
    property,
    requestAnimationFrame(() => {
      frames.delete(property);
      if (frames.size === 0) {
        cancelConfirmations.delete(target);
      }
      endGridTransition(target, property);
    }),
  );
}

function cancelPendingCancelConfirmation(target: Element, property: string): void {
  const frames = cancelConfirmations.get(target);
  const frame = frames?.get(property);
  if (frame === undefined) {
    return;
  }
  cancelAnimationFrame(frame);
  frames?.delete(property);
  if (frames?.size === 0) {
    cancelConfirmations.delete(target);
  }
}

function endGridTransition(target: EventTarget | null, property: string): void {
  if (!(target instanceof Element)) {
    return;
  }
  const properties = activeGridTransitions.get(target);
  if (!properties?.delete(property)) {
    return;
  }
  clearWatchdog(target, property);
  if (properties.size === 0) {
    activeGridTransitions.delete(target);
  }
  notifyIfChanged();
}

function armWatchdog(target: Element, property: string): void {
  clearWatchdog(target, property);
  let timers = watchdogs.get(target);
  if (!timers) {
    timers = new Map();
    watchdogs.set(target, timers);
  }
  timers.set(
    property,
    window.setTimeout(
      () => endGridTransition(target, property),
      transitionWindowMs(target, property) + SETTLE_GRACE_MS,
    ),
  );
}

function clearWatchdog(target: Element, property: string): void {
  const timers = watchdogs.get(target);
  const timer = timers?.get(property);
  if (timer === undefined) {
    return;
  }
  clearTimeout(timer);
  timers?.delete(property);
  if (timers?.size === 0) {
    watchdogs.delete(target);
  }
}

/** A computed CSS time token (`200ms`, `0.2s`) in milliseconds. */
function cssTimeMs(token: string | undefined): number {
  const raw = token?.trim() ?? "";
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return raw.endsWith("ms") ? value : value * 1000;
}

/** The transition clock the browser will take for this property, in ms. */
function transitionWindowMs(target: Element, property: string): number {
  if (typeof getComputedStyle !== "function") {
    return WATCHDOG_FALLBACK_MS;
  }
  const style = getComputedStyle(target);
  const properties = style.transitionProperty.split(",").map((value) => value.trim());
  const index = properties.indexOf(property);
  if (index < 0) {
    return WATCHDOG_FALLBACK_MS;
  }
  const token = (list: string) => list.split(",")[index]?.trim();
  // Computed transition times are CSS time tokens: `200ms` or `0.2s`.
  const duration = cssTimeMs(token(style.transitionDuration));
  const delay = cssTimeMs(token(style.transitionDelay));
  const window = duration + delay;
  return window > 0 ? window : WATCHDOG_FALLBACK_MS;
}

type TranscriptMotionQuiesceOwner = {
  readonly connected: boolean;
  /** One settle pass, after the final box has been written. */
  requestUpdate(): unknown;
};

/**
 * Per-transcript quiesce for one window: the eased intermediate widths hold
 * their committed row sizes and end-follow corrections, and one deferred pass
 * reconciles the settled geometry. Reader scroll, keyboard, touch, message
 * reveal, prepend anchoring, and streamed rows stay live throughout.
 */
export class TranscriptMotionQuiesce {
  private active = false;
  private settleFrame: number | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly endAnchor: TranscriptEndAnchor,
    private readonly layout: TranscriptLayoutOwner,
    private readonly viewport: TranscriptViewportRect,
    private readonly owner: TranscriptMotionQuiesceOwner,
  ) {}

  get motionActive(): boolean {
    return this.active;
  }

  /** Row sizes stay committed while the window is open; settle re-measures. */
  measureRow(
    element: HTMLElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
  ): number {
    return this.active
      ? retainedTranscriptRowSize(element, instance)
      : measureTranscriptRow(element, entry, instance);
  }

  connect(): void {
    this.detach = subscribeShellGeometryMotion((active) => {
      if (!this.owner.connected) {
        return;
      }
      if (active) {
        this.begin();
      } else {
        this.settle();
      }
    });
    if (isShellGeometryMotionActive()) {
      this.begin();
    }
  }

  disconnect(): void {
    this.detach?.();
    this.detach = null;
    this.active = false;
    this.viewport.setMotionActive(false);
    if (this.settleFrame !== null) {
      cancelAnimationFrame(this.settleFrame);
      this.settleFrame = null;
    }
  }

  private begin(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    if (this.settleFrame !== null) {
      cancelAnimationFrame(this.settleFrame);
      this.settleFrame = null;
    }
    // Keep the reader's rest edge so settle restores a following reader with
    // one correction instead of chasing each eased width.
    this.endAnchor.capture(this.viewport.scrollElement);
    this.viewport.setMotionActive(true);
  }

  private settle(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (this.settleFrame !== null) {
      return;
    }
    // Let the settled frame commit before measuring it; the chat region owner
    // commits its final geometry in this frame too.
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = null;
      if (!this.owner.connected) {
        return;
      }
      this.layout.flushPublish();
      this.viewport.settleMotion();
      // The host's update path reconciles the end anchor once the settled box
      // and its row measurements have committed.
      this.owner.requestUpdate();
    });
  }
}

install();
