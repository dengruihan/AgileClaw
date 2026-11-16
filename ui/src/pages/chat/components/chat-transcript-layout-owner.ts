import { nothing } from "lit";
import { Directive, directive, type ElementPart } from "lit/directive.js";
import { isShellGeometryMotionActive } from "./chat-transcript-motion.ts";
import {
  publishTranscriptScroll,
  readTranscriptViewport,
} from "./chat-transcript-scroll-events.ts";

/** Match ResizeObserver's fractional border box without pane transition transforms. */
export function unscaledBorderBox(element: HTMLElement, style = getComputedStyle(element)) {
  const borderBox = style.boxSizing === "border-box";
  return {
    width:
      Number.parseFloat(style.width) +
      (borderBox
        ? 0
        : Number.parseFloat(style.paddingLeft) +
          Number.parseFloat(style.paddingRight) +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.borderRightWidth)),
    height:
      Number.parseFloat(style.height) +
      (borderBox
        ? 0
        : Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth)),
  };
}

/** The native scroll range changes only at these viewport and content writes. */
export class TranscriptLayoutOwner {
  private viewport: HTMLDivElement | null = null;
  private observers: ResizeObserver[] = [];
  private readonly rangeHeights = new WeakMap<HTMLElement, number>();
  private publishOwed = false;

  constructor(private readonly onClamp: (before: number, after: number) => void) {}

  get viewportResizePending(): boolean {
    const viewport = this.viewport;
    const slot = viewport?.parentElement;
    const height = slot?.clientHeight;
    if (!viewport || !slot || !height) {
      return false;
    }
    const style = getComputedStyle(slot);
    return (
      height !== viewport.clientHeight ||
      style.paddingTop !== viewport.style.paddingTop ||
      style.paddingBottom !== viewport.style.paddingBottom
    );
  }

  connect(viewport: HTMLDivElement | null): void {
    if (viewport === this.viewport) {
      return;
    }
    this.disconnect();
    this.viewport = viewport;
    const slot = viewport?.parentElement;
    if (!viewport || !slot) {
      return;
    }
    const resize = (entries: ResizeObserverEntry[]) => {
      const entry = entries.find((candidate) => candidate.target === slot);
      if (this.viewport === viewport && entry) {
        this.sync(entry.borderBoxSize[0]);
      }
    };
    // Padding and viewport size can change independently; neither box covers both.
    this.observers = (["content-box", "border-box"] as const).map((box) => {
      const observer = new ResizeObserver(resize);
      observer.observe(slot, { box });
      return observer;
    });
  }

  sync(size?: ResizeObserverSize): void {
    const viewport = this.viewport;
    const slot = viewport?.parentElement;
    if (!viewport?.isConnected || !slot || (!size && slot.getClientRects().length === 0)) {
      return;
    }
    const style = getComputedStyle(slot);
    const rect = size
      ? { width: size.inlineSize, height: size.blockSize }
      : unscaledBorderBox(slot, style);
    if (!rect.width || !rect.height) {
      return;
    }
    const { paddingTop, paddingBottom } = style;
    const width = `${rect.width}px`;
    const height = `${rect.height}px`;
    if (
      viewport.style.width === width &&
      viewport.style.height === height &&
      viewport.style.paddingTop === paddingTop &&
      viewport.style.paddingBottom === paddingBottom
    ) {
      return;
    }
    const before = viewport.style.height === "" ? null : viewport.scrollTop;
    viewport.style.width = width;
    viewport.style.height = height;
    viewport.style.paddingTop = paddingTop;
    viewport.style.paddingBottom = paddingBottom;
    if (before !== null) {
      this.publishResize(before);
    }
  }

  commitRange(element: HTMLElement, height: number): void {
    const previous = this.rangeHeights.get(element);
    if (previous === height) {
      return;
    }
    const shrinking =
      element.parentElement === this.viewport && previous !== undefined && height < previous;
    const before = shrinking ? this.viewport?.scrollTop : undefined;
    this.rangeHeights.set(element, height);
    element.style.height = `${height}px`;
    if (before !== undefined) {
      this.publishResize(before);
    }
  }

  private publishResize(before: number): void {
    const viewport = this.viewport;
    if (!viewport) {
      return;
    }
    // A shell geometry motion owns the intermediate boxes: they are still
    // written so the transcript follows the animation, but the resize
    // notification waits for the single settle publish.
    if (isShellGeometryMotionActive()) {
      this.publishOwed = true;
      return;
    }
    this.publishOwed = false;
    // Publish the native clamp before another measurement can move the anchor.
    const measuredViewport = readTranscriptViewport(viewport);
    const after = measuredViewport.scrollTop;
    if (before !== after) {
      this.onClamp(before, after);
    }
    publishTranscriptScroll(viewport, {
      type: "resize",
      viewport: measuredViewport,
      ...(before !== after ? { scrollCorrection: { before, after } } : {}),
    });
  }

  /** Publishes the resize a paused motion owed, once the settled box is written. */
  flushPublish(): void {
    const viewport = this.viewport;
    if (!this.publishOwed || !viewport) {
      return;
    }
    this.publishResize(viewport.scrollTop);
  }

  disconnect(): void {
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
    this.viewport = null;
  }
}

class TranscriptRangeSize extends Directive {
  render(_owner: TranscriptLayoutOwner, _height: number) {
    return nothing;
  }

  override update(part: ElementPart, [owner, height]: [TranscriptLayoutOwner, number]) {
    if (part.element instanceof HTMLElement) {
      owner.commitRange(part.element, height);
    }
    return nothing;
  }
}

export const transcriptRangeSize = directive(TranscriptRangeSize);
