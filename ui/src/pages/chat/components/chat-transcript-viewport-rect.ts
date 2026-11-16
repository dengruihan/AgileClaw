import { observeElementRect, type Rect, type Virtualizer } from "@tanstack/virtual-core";
import {
  resolveTranscriptScrollMargin,
  syncScrollMargin,
  type PositionRailGutterController,
} from "./chat-transcript-geometry.ts";
import { unscaledBorderBox } from "./chat-transcript-layout-owner.ts";

type ViewportRectOwner = {
  getScrollElement(): HTMLDivElement | null;
  getHeaderHeight(): number;
  positionRail: Pick<PositionRailGutterController, "read" | "sync">;
  commitComposerResize(): void;
  measureConnectedRows(): boolean;
  queueRowMeasure(): void;
  onViewportResize(): void;
  requestUpdate(): void;
};

type RailGeometry = NonNullable<ReturnType<PositionRailGutterController["read"]>>;

type ViewportObserver = {
  instance: Virtualizer<HTMLDivElement, HTMLElement>;
  callback: (rect: Rect) => void;
  delivered: boolean;
};

function sameDimension(previous: number | null | undefined, next: number): boolean {
  return previous != null && Math.abs(previous - next) < 0.5;
}

/** Delivers each viewport geometry once, including pane and sidebar pre-measurement. */
export class TranscriptViewportRect {
  private observedWidth: number | null = null;
  private observedHeight: number | null = null;
  private syncRect: (() => void) | null = null;
  private observer: ViewportObserver | null = null;
  private motionActive = false;
  private pendingMotionRect: { rect: Rect; scrollMargin: number } | null = null;
  private stagedRail: RailGeometry | null = null;
  private railFrame: number | null = null;

  constructor(private readonly owner: ViewportRectOwner) {}

  /** The element currently under observation (rows and scroll range owner). */
  get scrollElement(): HTMLDivElement | null {
    return this.observer?.instance.scrollElement ?? null;
  }

  recordMeasuredWidth(width: number): void {
    this.observedWidth = Math.round(width);
  }

  sync(): void {
    this.syncRect?.();
  }

  /**
   * A shell geometry motion owns the column width. Its intermediate eased boxes
   * must not drive a row re-measure, rail sync, or follow correction, so each
   * observation is held instead of delivered.
   */
  setMotionActive(active: boolean): void {
    this.motionActive = active;
  }

  /**
   * Delivers the box observed while the motion ran, once. The caller owns the
   * single post-motion reconcile; returns false when no delivery was owed.
   */
  settleMotion(): boolean {
    this.motionActive = false;
    const pending = this.pendingMotionRect;
    const observer = this.observer;
    this.pendingMotionRect = null;
    if (!pending || !observer) {
      return false;
    }
    this.deliver(observer, pending.rect, pending.scrollMargin, true);
    return true;
  }

  readonly observe = (
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
    callback: (rect: Rect) => void,
  ): (() => void) => {
    const observer: ViewportObserver = { instance, callback, delivered: false };
    const deliverRect = (rect: Rect) => {
      // Hidden tabs and detached faces retain their last measurable geometry.
      if (instance.scrollElement !== this.owner.getScrollElement() || !rect.width || !rect.height) {
        return;
      }
      const scrollMargin = resolveTranscriptScrollMargin(
        instance.scrollElement,
        this.owner.getHeaderHeight(),
      );
      if (this.motionActive) {
        this.pendingMotionRect = { rect, scrollMargin };
        return;
      }
      this.deliver(observer, rect, scrollMargin, false);
    };
    const syncRect = () => {
      const element = instance.scrollElement;
      if (element?.getClientRects().length) {
        const rect = unscaledBorderBox(element);
        // Match virtual-core's observer normalization, including exact half-pixels.
        deliverRect({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    this.observer = observer;
    this.syncRect = syncRect;
    const cleanup = observeElementRect(instance, deliverRect);
    return () => {
      cleanup?.();
      if (this.syncRect === syncRect) {
        this.syncRect = null;
      }
      if (this.observer === observer) {
        this.observer = null;
      }
      this.cancelStagedRail();
    };
  };

  private deliver(
    observer: ViewportObserver,
    rect: Rect,
    scrollMargin: number,
    settled: boolean,
  ): void {
    const { instance, callback } = observer;
    // Sidebar commits can measure rows before the virtualizer gets its rect.
    if (
      !settled &&
      observer.delivered &&
      scrollMargin === instance.options.scrollMargin &&
      sameDimension(this.observedWidth, rect.width) &&
      sameDimension(this.observedHeight, rect.height) &&
      sameDimension(instance.scrollRect?.width, rect.width) &&
      sameDimension(instance.scrollRect?.height, rect.height)
    ) {
      return;
    }
    observer.delivered = true;
    const railGeometry = this.owner.positionRail.read();
    this.owner.commitComposerResize();
    const widthChanged =
      this.observedWidth !== null && !sameDimension(this.observedWidth, rect.width);
    const heightChanged =
      this.observedHeight !== null && !sameDimension(this.observedHeight, rect.height);
    this.observedWidth = rect.width;
    this.observedHeight = rect.height;
    // The host supplies only the header height already compensated by its render.
    syncScrollMargin(instance, scrollMargin);
    callback(rect);
    if (settled) {
      // The settle frame already carries the unmount/layout of the gesture, so
      // the rewrapped rows are measured in the queued scan that follows it; a
      // synchronous scan here stacks another forced layout into that frame.
      this.owner.queueRowMeasure();
    } else if (widthChanged) {
      // Preserve offscreen estimates; connected resizeItem measurements own scroll compensation.
      this.owner.measureConnectedRows();
      this.owner.queueRowMeasure();
    }
    if (settled) {
      if (railGeometry) {
        this.stagePositionRail(railGeometry);
      }
    } else {
      this.owner.positionRail.sync(railGeometry);
    }
    if (widthChanged || heightChanged) {
      this.owner.onViewportResize();
      this.owner.requestUpdate();
    }
  }

  /**
   * The settled rail write is its own frame: the settle delivery already shares
   * a task with the pane/conversation commit, and writing the inherited rail
   * width there restyles the transcript subtree in that same commit. The
   * captured geometry is final, so no read follows the write.
   */
  private stagePositionRail(geometry: RailGeometry): void {
    this.stagedRail = geometry;
    if (this.railFrame !== null) {
      return;
    }
    this.railFrame = requestAnimationFrame(() => {
      this.railFrame = null;
      const pending = this.stagedRail;
      this.stagedRail = null;
      if (pending) {
        this.owner.positionRail.sync(pending, { force: true });
      }
    });
  }

  private cancelStagedRail(): void {
    if (this.railFrame !== null) {
      cancelAnimationFrame(this.railFrame);
      this.railFrame = null;
    }
    this.stagedRail = null;
  }
}
