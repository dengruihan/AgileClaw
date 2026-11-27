const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** Reader space kept clear beside a fit-width canvas so pages never touch the edge. */
const FIT_INSET_PX = 8;

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)) * 1_000) / 1_000;
}

/**
 * Fixed-size Office canvas with viewer zoom.
 *
 * One page (or slide) is laid out once at its declared size in CSS pixels and
 * only then scaled, so a narrower reader never rewraps its text: the panel
 * width changes the scale, never the line breaks. The controller owns the
 * zoom mode and the single `--office-canvas-scale` custom property; canvases
 * apply it with a transform on the page box, and their layout wrappers size
 * themselves from the same property.
 */
export class OfficeFixedCanvasController {
  private host: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private frame: number | null = null;
  private canvasWidth = 0;
  private scale = 1;
  private fit = true;
  private applied = Number.NaN;
  private notified = "";

  constructor(private readonly onChange: () => void) {}

  get percent(): number {
    return Math.round(this.scale * 100);
  }

  get fitWidth(): boolean {
    return this.fit;
  }

  get scaleValue(): number {
    return this.scale;
  }

  get canZoomIn(): boolean {
    return this.scale < MAX_SCALE - 0.001;
  }

  get canZoomOut(): boolean {
    return this.scale > MIN_SCALE + 0.001;
  }

  /** Rebind to the current reader after a render, reconnect, or preview change. */
  sync(host: HTMLElement | null, canvasWidth: number): void {
    if (host !== this.host) {
      this.disconnectObserver();
      this.host = host;
      // A new reader owns a new element that has not received the property yet.
      this.applied = Number.NaN;
      if (host && typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.schedule());
        this.observer.observe(host);
      }
    }
    this.canvasWidth = Math.max(canvasWidth, 0);
    if (this.fit) {
      this.fitToHost(true);
    } else {
      this.apply(true);
    }
  }

  disconnect(): void {
    this.disconnectObserver();
    this.host = null;
  }

  zoomIn(): void {
    this.setScale(this.scale * ZOOM_STEP);
  }

  zoomOut(): void {
    this.setScale(this.scale / ZOOM_STEP);
  }

  actualSize(): void {
    this.setScale(1);
  }

  fitToWidth(): void {
    this.fit = true;
    this.fitToHost();
  }

  private setScale(value: number): void {
    this.fit = false;
    this.scale = clampScale(value);
    this.apply();
  }

  private fitToHost(defer = false): void {
    const width = this.host?.clientWidth ?? 0;
    // jsdom and other non-layout environments expose no reader box; the page
    // then keeps its declared size instead of collapsing to the minimum.
    this.scale =
      width > 0 && this.canvasWidth > 0 ? clampScale((width - FIT_INSET_PX) / this.canvasWidth) : 1;
    this.apply(defer);
  }

  private apply(defer = false): void {
    const host = this.host;
    if (!host) {
      return;
    }
    if (this.applied !== this.scale) {
      host.style.setProperty("--office-canvas-scale", String(this.scale));
      this.applied = this.scale;
    }
    const state = `${this.fit ? "fit" : "manual"}:${this.percent}`;
    if (state === this.notified) {
      return;
    }
    this.notified = state;
    // A fit recomputed from the render cycle cannot schedule another update in
    // the same cycle; the label catches up on the next microtask instead.
    if (defer && typeof queueMicrotask === "function") {
      queueMicrotask(() => this.onChange());
      return;
    }
    this.onChange();
  }

  private schedule(): void {
    if (this.frame !== null) {
      return;
    }
    if (typeof requestAnimationFrame === "undefined") {
      if (this.fit) {
        this.fitToHost();
      }
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.fit) {
        this.fitToHost();
      }
    });
  }

  private disconnectObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.frame !== null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.frame);
      }
      this.frame = null;
    }
  }
}
