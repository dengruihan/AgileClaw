/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRightDockMotion, endRightDockMotion } from "../../../components/right-dock-motion.ts";
import {
  isShellGeometryMotionActive,
  subscribeShellGeometryMotion,
} from "./chat-transcript-motion.ts";

function transition(type: "transitionend" | "transitionrun" | "transitionstart", property: string) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: property });
  return event;
}

function mountGrid(selector: "shell-nav" | "sidebar-region"): HTMLElement {
  const element = document.createElement("div");
  element.className = selector === "shell-nav" ? "shell-nav" : "sidebar-region";
  document.body.append(element);
  return element;
}

afterEach(() => {
  endRightDockMotion("assistant");
  endRightDockMotion("terminal");
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("shell geometry motion window", () => {
  it("notifies one window per dock motion and stays open through a reversal", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeShellGeometryMotion((active) => events.push(active));
    beginRightDockMotion("assistant", "opening");
    // A reversal retargets an already running window; consumers must not see a
    // second start and re-measure the intermediate geometry.
    beginRightDockMotion("assistant", "closing");
    expect(events).toEqual([true]);
    endRightDockMotion("assistant");
    expect(events).toEqual([true, false]);
    expect(isShellGeometryMotionActive()).toBe(false);
    unsubscribe();
  });

  it("keeps the window open until every moving dock has settled", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeShellGeometryMotion((active) => events.push(active));
    beginRightDockMotion("assistant", "opening");
    beginRightDockMotion("terminal", "opening");
    endRightDockMotion("assistant");
    expect(events).toEqual([true]);
    expect(isShellGeometryMotionActive()).toBe(true);
    endRightDockMotion("terminal");
    expect(events).toEqual([true, false]);
    unsubscribe();
  });

  it("tracks the local grid transitions of the navigation rail and chat region", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeShellGeometryMotion((active) => events.push(active));
    const nav = mountGrid("shell-nav");
    const region = mountGrid("sidebar-region");
    // A transitionstart repeats for the same gesture; the window opens once.
    nav.dispatchEvent(transition("transitionrun", "width"));
    nav.dispatchEvent(transition("transitionstart", "width"));
    expect(events).toEqual([true]);
    nav.dispatchEvent(transition("transitionend", "width"));
    expect(events).toEqual([true, false]);

    region.dispatchEvent(transition("transitionrun", "grid-template-columns"));
    region.dispatchEvent(transition("transitionend", "grid-template-columns"));
    expect(events).toEqual([true, false, true, false]);

    // Gestures that do not resize the chat column must not quiesce measurement.
    nav.dispatchEvent(transition("transitionrun", "opacity"));
    region.dispatchEvent(transition("transitionrun", "opacity"));
    expect(events).toEqual([true, false, true, false]);
    expect(isShellGeometryMotionActive()).toBe(false);
    unsubscribe();
  });

  it.each([
    { delay: "0s", duration: "0.2s", expected: 350 },
    { delay: "0s", duration: "200ms", expected: 350 },
    { delay: "50ms", duration: "0.2s", expected: 400 },
  ])(
    "bounds a lost transitionend by the browser clock ($duration + $delay)",
    ({ delay, duration, expected }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.stubGlobal("getComputedStyle", () => ({
        transitionDelay: delay,
        transitionDuration: duration,
        transitionProperty: "width",
      }));
      const events: boolean[] = [];
      const unsubscribe = subscribeShellGeometryMotion((active) => events.push(active));
      mountGrid("shell-nav").dispatchEvent(transition("transitionrun", "width"));
      expect(events).toEqual([true]);
      // The grace window alone must not settle a phone-width rail gesture.
      vi.advanceTimersByTime(150);
      expect(events).toEqual([true]);
      vi.advanceTimersByTime(expected - 150 - 1);
      expect(events).toEqual([true]);
      vi.advanceTimersByTime(2);
      expect(events).toEqual([true, false]);
      expect(isShellGeometryMotionActive()).toBe(false);
      unsubscribe();
    },
  );

  it("bounds a gesture whose transitionend never arrives", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events: boolean[] = [];
    const unsubscribe = subscribeShellGeometryMotion((active) => events.push(active));
    mountGrid("shell-nav").dispatchEvent(transition("transitionrun", "width"));
    expect(events).toEqual([true]);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([true, false]);
    expect(isShellGeometryMotionActive()).toBe(false);
    unsubscribe();
  });

  it("lets a consumer that subscribes mid-window read the live state", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const nav = mountGrid("shell-nav");
    const detached: boolean[] = [];
    const unsubscribe = subscribeShellGeometryMotion((active) => detached.push(active));
    nav.dispatchEvent(transition("transitionrun", "width"));
    unsubscribe();
    nav.dispatchEvent(transition("transitionend", "width"));
    // A detached consumer keeps no notification path into a closed window.
    expect(detached).toEqual([true]);

    nav.dispatchEvent(transition("transitionrun", "width"));
    const late: boolean[] = [];
    const resubscribe = subscribeShellGeometryMotion((active) => late.push(active));
    // Tracking is process-wide, so the late consumer sees the gesture it missed.
    expect(isShellGeometryMotionActive()).toBe(true);
    nav.dispatchEvent(transition("transitionend", "width"));
    expect(late).toEqual([false]);
    expect(isShellGeometryMotionActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    resubscribe();
  });
});
