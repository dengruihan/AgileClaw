/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSlot, setSidebarOpen, type SidebarLayout } from "../sidebar-layout.ts";
import { SidebarRegionMotion } from "./chat-sidebar-region-motion.ts";

// jsdom has no media queries or computed transitions; supply those platform
// facts so the lifecycle runs its real timer/listener logic under fake time.
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    transitionDuration: "0.2s",
  } as CSSStyleDeclaration);
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPEN_LAYOUT = openSlot({ columns: [] }, "detail");
const CLOSED_LAYOUT = setSidebarOpen(OPEN_LAYOUT, false);
// The shared clock reads 200ms + 150ms grace = a 350ms settle deadline.
const DEADLINE_MS = 350;

function createMotion() {
  const invalidate = vi.fn();
  const onSettle = vi.fn();
  const motion = new SidebarRegionMotion(invalidate);
  const region = document.createElement("div");
  const base = {
    region,
    narrow: false,
    availableWidth: 1_400,
    scope: "agent:main:main",
    onSettle,
  };
  const reconcile = (layout: SidebarLayout, overrides: Partial<typeof base> = {}) =>
    motion.reconcile({ ...base, ...overrides, layout });
  // First commit adopts the open presentation; the ready gate arms on rAF.
  reconcile(OPEN_LAYOUT);
  vi.advanceTimersByTime(20);
  return { motion, region, invalidate, onSettle, reconcile };
}

function gridTransitionEnd(region: HTMLElement): void {
  region.dispatchEvent(
    new TransitionEvent("transitionend", {
      propertyName: "grid-template-columns",
      bubbles: true,
    }),
  );
}

describe("chat sidebar region motion settle lifecycle", () => {
  it("keeps the original closing deadline when ordinary updates reconcile the same closed target", () => {
    const { motion, invalidate, onSettle, reconcile } = createMotion();
    reconcile(CLOSED_LAYOUT);
    expect(motion.motionActive).toBe(true);
    expect(motion.presentationLayout).toEqual(OPEN_LAYOUT);

    // Ordinary closing-phase commits (fresh layout objects, same closed
    // target) must not postpone the watchdog when transitionend is lost.
    for (let update = 0; update < 10; update += 1) {
      vi.advanceTimersByTime(30);
      reconcile(structuredClone(CLOSED_LAYOUT));
      expect(motion.motionActive).toBe(true);
      expect(motion.presentationLayout).toEqual(OPEN_LAYOUT);
    }
    // t=320ms: before the original 20+350ms deadline, after every re-arm a
    // resetting implementation would have pushed it out to t+350ms.
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onSettle, "original watchdog settles despite repeated reconciles").toHaveBeenCalledTimes(
      1,
    );
    expect(invalidate).toHaveBeenCalled();
    expect(motion.motionActive).toBe(false);
    expect(motion.presentationLayout).toEqual(CLOSED_LAYOUT);
    expect(motion.regionClasses(CLOSED_LAYOUT, false)).toBe("");

    reconcile(structuredClone(CLOSED_LAYOUT));
    expect(motion.motionActive).toBe(false);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("still settles once on the preserved transitionend listener during closing", () => {
    const { motion, region, onSettle, reconcile } = createMotion();
    reconcile(CLOSED_LAYOUT);
    for (let update = 0; update < 5; update += 1) {
      vi.advanceTimersByTime(20);
      reconcile(structuredClone(CLOSED_LAYOUT));
    }
    gridTransitionEnd(region);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(motion.motionActive).toBe(false);
    gridTransitionEnd(region);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("re-arms the deadline on a genuine reversal and preserves it again afterwards", () => {
    const { motion, onSettle, reconcile } = createMotion();
    reconcile(CLOSED_LAYOUT);
    vi.advanceTimersByTime(100);
    reconcile(OPEN_LAYOUT);
    expect(motion.motionActive).toBe(true);
    // The reversal restarted the clock: the original closing deadline no
    // longer applies, the opening one (t=120+350) does.
    vi.advanceTimersByTime(260);
    expect(onSettle).not.toHaveBeenCalled();
    expect(motion.motionActive).toBe(true);
    vi.advanceTimersByTime(100);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(motion.regionClasses(OPEN_LAYOUT, false)).toBe("sidebar-region--open");

    reconcile(CLOSED_LAYOUT);
    vi.advanceTimersByTime(30);
    reconcile(structuredClone(CLOSED_LAYOUT));
    vi.advanceTimersByTime(DEADLINE_MS - 30 - 10);
    expect(onSettle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20);
    expect(onSettle).toHaveBeenCalledTimes(2);
    expect(motion.motionActive).toBe(false);
  });

  it("moves the settle listener and deadline when the region element changes", () => {
    const { motion, region, onSettle, reconcile } = createMotion();
    reconcile(CLOSED_LAYOUT);
    vi.advanceTimersByTime(50);
    const replacement = document.createElement("div");
    reconcile(structuredClone(CLOSED_LAYOUT), { region: replacement });
    gridTransitionEnd(region);
    expect(onSettle).not.toHaveBeenCalled();
    gridTransitionEnd(replacement);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(motion.motionActive).toBe(false);
  });
});
