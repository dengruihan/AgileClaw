import { afterEach, expect, it } from "vitest";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  replaceComposerPopoverAnchor,
} from "./chat-composer-dom.ts";
import { isShellGeometryMotionActive } from "./chat-transcript-motion.ts";

const VIEWPORT_INSET_PX = 28;
const MAX_HEIGHT_PROPERTY = "--chat-composer-popover-max-height";

let anchor: HTMLElement | null = null;
let textarea: HTMLTextAreaElement | null = null;

afterEach(() => {
  replaceComposerPopoverAnchor(anchor);
  anchor = null;
  if (textarea) {
    disconnectTextareaOverflowObserver(textarea);
    textarea = null;
  }
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

// A real CSS width transition on the element the motion owner watches. The
// transition run/start/end events are the production gesture signal.
function widthTransitionHost(style: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "shell-nav";
  el.style.cssText = `position: absolute; left: 0; top: 0; transition: width 200ms linear; ${style}`;
  document.body.append(el);
  return el;
}

function runningWidthTransition(host: HTMLElement): CSSTransition | undefined {
  return host
    .getAnimations()
    .find(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.transitionProperty === "width",
    );
}

async function startWidthTransition(host: HTMLElement, width: number): Promise<CSSTransition> {
  void host.getBoundingClientRect();
  host.style.width = `${width}px`;
  const animation = runningWidthTransition(host);
  if (!animation) {
    throw new Error("width transition did not start");
  }
  // The browser dispatches transitionrun/transitionstart in the next update.
  await nextFrame();
  return animation;
}

async function finishTransition(animation: CSSTransition): Promise<void> {
  await animation.finished.catch(() => undefined);
  await settleFrames(2);
}

function instanceAccessor(
  name: string,
  receiver: HTMLElement,
  onRead: () => void,
): { configurable: true; get: () => number } {
  let proto: object | null = Object.getPrototypeOf(receiver);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor?.get) {
      const read = descriptor.get.bind(receiver);
      return {
        configurable: true,
        get() {
          onRead();
          return read() as number;
        },
      };
    }
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error(`missing ${name} accessor`);
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

it("settles a same-size move made during a real nav width transition", async () => {
  const el = placedBox("top: 765px; width: 768px; height: 112px");
  anchor = replaceComposerPopoverAnchor(null, el);
  // Every initial delivery (owner frame plus the first RO) has completed.
  await settleFrames(4);
  expect(maxHeight(el)).toBe(`${765 - VIEWPORT_INSET_PX}px`);

  const nav = widthTransitionHost("width: 258px; height: 20px");
  let deliveries = 0;
  const probe = new ResizeObserver(() => {
    deliveries += 1;
  });
  probe.observe(el, { box: "border-box" });
  await settleFrames(2);
  deliveries = 0;
  const animation = await startWidthTransition(nav, 120);
  try {
    expect(isShellGeometryMotionActive()).toBe(true);
    await settleFrames(2);
    // Same size, new top: ResizeObserver reports no size change, so the move
    // itself produces no delivery that could owe a measurement.
    el.style.top = "665px";
  } finally {
    await finishTransition(animation);
  }
  await settleFrames(4);
  probe.disconnect();
  expect(deliveries).toBe(0);
  expect(maxHeight(el)).toBe(`${665 - VIEWPORT_INSET_PX}px`);
});

it("holds textarea maintenance through a real transition and reconciles the settled width", async () => {
  const host = widthTransitionHost("width: 400px");
  const el = document.createElement("textarea");
  el.style.cssText =
    "display: block; width: 100%; box-sizing: border-box; padding: 4px; " +
    "font: 12px/16px monospace; min-height: 32px; max-height: 150px";
  el.value = "wrap the draft ".repeat(14);
  host.append(el);
  textarea = el;

  let frame = 0;
  let trackFrames = true;
  const countFrame = () => {
    if (!trackFrames) {
      return;
    }
    frame += 1;
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
  const railAnimating = () =>
    host
      .getAnimations()
      .some(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "width" &&
          animation.playState === "running",
      );
  const reads: Array<{
    animating: boolean;
    frame: number;
    input: boolean;
    kind: string;
    width: number;
  }> = [];
  let inputDispatch = false;
  const record = (kind: string, width: number) => {
    reads.push({ animating: railAnimating(), frame, input: inputDispatch, kind, width });
  };
  const originalRect = el.getBoundingClientRect.bind(el);
  el.getBoundingClientRect = () => {
    const rect = originalRect();
    record("rect", rect.width);
    return rect;
  };
  Object.defineProperty(
    el,
    "scrollHeight",
    instanceAccessor("scrollHeight", el, () => record("scrollHeight", 0)),
  );
  Object.defineProperty(
    el,
    "clientHeight",
    instanceAccessor("clientHeight", el, () => record("clientHeight", 0)),
  );

  observeTextareaOverflow(el);
  await settleFrames(3);
  adjustTextareaHeight(el);
  await settleFrames(2);
  const restHeight = Number.parseFloat(el.style.height);
  expect(restHeight).toBeGreaterThan(0);

  reads.length = 0;
  const animation = await startWidthTransition(host, 240);
  try {
    expect(isShellGeometryMotionActive()).toBe(true);
    await settleFrames(2);
    // The eased column changes the box every frame; maintenance must not read it.
    expect(reads.filter((read) => read.animating && !read.input)).toEqual([]);
    // Direct typing stays immediate inside the gesture.
    inputDispatch = true;
    el.value += " more";
    el.dispatchEvent(new Event("input"));
    inputDispatch = false;
    expect(reads.some((read) => read.animating && read.input && read.kind === "scrollHeight")).toBe(
      true,
    );
  } finally {
    await finishTransition(animation);
  }
  await settleFrames(4);

  const settledWidth = originalRect().width;
  const rectsAfter = reads.filter((read) => !read.animating && read.kind === "rect");
  // The settle reconcile plus at most the final ResizeObserver delivery.
  expect(rectsAfter.length).toBeGreaterThanOrEqual(1);
  expect(rectsAfter.length).toBeLessThanOrEqual(2);
  for (const read of rectsAfter) {
    expect(Math.abs(read.width - settledWidth)).toBeLessThan(0.5);
  }
  expect(Number.parseFloat(el.style.height)).toBeGreaterThan(restHeight);

  // Disconnect detaches the gesture subscription and the pending frame: a later
  // transition reads and writes nothing.
  reads.length = 0;
  disconnectTextareaOverflowObserver(el);
  textarea = null;
  const second = await startWidthTransition(host, 120);
  try {
    await settleFrames(2);
  } finally {
    await finishTransition(second);
  }
  await settleFrames(3);
  trackFrames = false;
  expect(reads).toEqual([]);
});
