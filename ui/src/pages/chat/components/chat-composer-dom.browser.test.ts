import { afterEach, expect, it } from "vitest";
import { replaceComposerPopoverAnchor } from "./chat-composer-dom.ts";

const VIEWPORT_INSET_PX = 28;
const MAX_HEIGHT_PROPERTY = "--chat-composer-popover-max-height";

let anchor: HTMLElement | null = null;

afterEach(() => {
  replaceComposerPopoverAnchor(anchor);
  anchor = null;
  document.body.replaceChildren();
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextFrame();
  }
}

function maxHeight(el: HTMLElement): string {
  return el.style.getPropertyValue(MAX_HEIGHT_PROPERTY);
}

function placedBox(style: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `position: absolute; left: 0; ${style}`;
  document.body.append(el);
  return el;
}

it("re-measures a box that moved while its own same-size RO delivery was pending", async () => {
  const el = placedBox("top: 100px; width: 100px; height: 40px");
  anchor = replaceComposerPopoverAnchor(null, el);
  // The owner's queued frame measures top=100 first; this callback runs before
  // the ResizeObserver's initial delivery for the same frame, so the delivered
  // border box keeps that size while the composer has already moved.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      expect(maxHeight(el)).toBe(`${100 - VIEWPORT_INSET_PX}px`);
      el.style.top = "300px";
      resolve();
    });
  });
  await settleFrames(3);
  expect(maxHeight(el)).toBe(`${300 - VIEWPORT_INSET_PX}px`);
});

it("corrects a re-observed composer translated before its initial delivery", async () => {
  const el = placedBox("top: 765px; width: 768px; height: 112px");
  anchor = replaceComposerPopoverAnchor(null, el);
  await settleFrames(3);
  expect(maxHeight(el)).toBe(`${765 - VIEWPORT_INSET_PX}px`);
  const before = el.getBoundingClientRect();

  // Disconnect and re-observe, as a composer remount does: the initial delivery
  // repeats the border box the owner already measured. Re-observing from its
  // own task keeps that delivery after the next frame's measurement, where the
  // owner has recorded the box the translation then invalidates.
  await nextTask();
  replaceComposerPopoverAnchor(anchor);
  anchor = replaceComposerPopoverAnchor(null, el);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      expect(maxHeight(el)).toBe(`${765 - VIEWPORT_INSET_PX}px`);
      el.style.transform = "translateY(200px)";
      resolve();
    });
  });
  await settleFrames(3);
  const moved = el.getBoundingClientRect();
  expect(moved.top).toBe(before.top + 200);
  expect(moved.width).toBe(before.width);
  expect(moved.height).toBe(before.height);
  expect(maxHeight(el)).toBe(`${965 - VIEWPORT_INSET_PX}px`);
});
