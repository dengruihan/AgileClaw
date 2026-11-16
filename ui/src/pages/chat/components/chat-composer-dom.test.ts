/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRightDockMotion, endRightDockMotion } from "../../../components/right-dock-motion.ts";
import { replaceComposerPopoverAnchor } from "./chat-composer-dom.ts";

const VIEWPORT_INSET_PX = 28;

function frameClock() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  return {
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}

function composerAt(top: () => number) {
  const composer = document.createElement("div");
  document.body.append(composer);
  let reads = 0;
  composer.getBoundingClientRect = () => {
    reads += 1;
    return new DOMRect(0, top(), 100, 40);
  };
  return {
    composer,
    reads: () => reads,
    height: () => composer.style.getPropertyValue("--chat-composer-popover-max-height"),
  };
}

async function flushMutations() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  endRightDockMotion("assistant");
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("composer popover anchor during shell motion", () => {
  it("holds the mount measurement and resize feedback, then updates once at settle", () => {
    const clock = frameClock();
    let top = 500;
    const probe = composerAt(() => top);
    beginRightDockMotion("assistant", "opening");

    const anchor = replaceComposerPopoverAnchor(null, probe.composer);
    try {
      clock.flush();
      // The composer box eases with the column; measuring it here forces a
      // layout per frame, so nothing is measured while the gesture runs.
      expect(probe.reads()).toBe(0);
      expect(probe.height()).toBe("");

      top = 300;
      window.dispatchEvent(new Event("resize"));
      clock.flush();
      expect(probe.reads()).toBe(0);

      // The settle is one delivery through the queued frame, not a second
      // synchronous read next to a pending frame.
      endRightDockMotion("assistant");
      expect(probe.reads()).toBe(0);
      clock.flush();
      expect(probe.reads()).toBe(1);
      expect(probe.height()).toBe(`${300 - VIEWPORT_INSET_PX}px`);
      clock.flush();
      expect(probe.reads()).toBe(1);
    } finally {
      replaceComposerPopoverAnchor(anchor);
    }
  });

  it("measures a menu the reader opens mid-gesture and corrects it once at settle", async () => {
    const clock = frameClock();
    let top = 500;
    const probe = composerAt(() => top);
    beginRightDockMotion("assistant", "opening");

    const anchor = replaceComposerPopoverAnchor(null, probe.composer);
    try {
      clock.flush();
      expect(probe.reads()).toBe(0);

      top = 320;
      const menu = document.createElement("div");
      probe.composer.append(menu);
      // The menu's own open toggle is reader intent, not maintenance geometry.
      menu.setAttribute("open", "");
      await flushMutations();
      expect(probe.reads()).toBe(1);
      expect(probe.height()).toBe(`${320 - VIEWPORT_INSET_PX}px`);

      top = 280;
      // The intent read cancels the queued maintenance frame; the settle is one
      // further delivery, so the same gesture measures the final box once.
      endRightDockMotion("assistant");
      expect(probe.reads()).toBe(1);
      clock.flush();
      expect(probe.reads()).toBe(2);
      expect(probe.height()).toBe(`${280 - VIEWPORT_INSET_PX}px`);
      clock.flush();
      expect(probe.reads()).toBe(2);
    } finally {
      replaceComposerPopoverAnchor(anchor);
    }
  });

  it("delivers the settle once when a maintenance frame is already queued", () => {
    const clock = frameClock();
    let top = 500;
    const probe = composerAt(() => top);
    beginRightDockMotion("assistant", "opening");
    const anchor = replaceComposerPopoverAnchor(null, probe.composer);
    try {
      clock.flush();
      expect(probe.reads()).toBe(0);

      // A resize queues the maintenance frame; the gesture gate holds it and
      // records the owed measurement.
      window.dispatchEvent(new Event("resize"));
      clock.flush();
      expect(probe.reads()).toBe(0);

      // The settle reuses that frame instead of reading synchronously beside it.
      top = 300;
      endRightDockMotion("assistant");
      expect(probe.reads()).toBe(0);
      clock.flush();
      expect(probe.reads()).toBe(1);
      expect(probe.height()).toBe(`${300 - VIEWPORT_INSET_PX}px`);
      clock.flush();
      expect(probe.reads()).toBe(1);
    } finally {
      replaceComposerPopoverAnchor(anchor);
    }
  });

  it("stops watching the gesture when the composer is replaced", () => {
    const clock = frameClock();
    const probe = composerAt(() => 500);
    beginRightDockMotion("assistant", "opening");
    const anchor = replaceComposerPopoverAnchor(null, probe.composer);
    clock.flush();
    replaceComposerPopoverAnchor(anchor);

    window.dispatchEvent(new Event("resize"));
    clock.flush();
    endRightDockMotion("assistant");
    expect(probe.reads()).toBe(0);
    probe.composer.remove();
  });
});
