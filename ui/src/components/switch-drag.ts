// Pointer drag adapter for Web Awesome switches. Lets the thumb track the
// pointer like a physical lever while it is held, then commits one final
// checked state (and one change event) on release. Short gestures keep native
// click parity; keyboard, focus, and the template's change/rollback contract
// are untouched. Attached through a Lit element part so every consumer gets
// the behavior and its cleanup for free.
import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";

export type SwitchDragOptions = {
  /** Latest committed pole from the owning template (its props.checked). */
  checked: () => boolean;
  /** Runs synchronously during direct activation for effects gated on user activation. */
  onAct?: (checked: boolean) => void;
};

type DraggableSwitch = HTMLElement & { checked: boolean; disabled?: boolean };

// Pointer travel below which a release stays a click (toggles like a tap).
const TAP_RADIUS_PX = 4;
// The thumb moves at this fraction of pointer travel: a weighty lever, not a
// 1:1 cursor. Clamped to the track poles so the lever always reaches them.
const DRAG_RESISTANCE = 0.9;
// Releases moving faster than this commit the pole they are moving toward.
const FLICK_SPEED_PX_PER_MS = 0.5;
const FLICK_WINDOW_MS = 90;

type DragGeometry = {
  thumb: HTMLElement;
  /** Signed offset (px) of the thumb from the track center at engage time. */
  startOffset: number;
  /** Signed offset of the checked pole; the off pole mirrors it. */
  checkedOffset: number;
  /** Distance from track center to each pole. */
  travelHalf: number;
};

type DragGesture = DragGeometry & {
  pointerId: number;
  startPointerX: number;
};

class SwitchDragDirective extends AsyncDirective {
  private element: DraggableSwitch | null = null;
  private attached = false;
  private options: SwitchDragOptions | null = null;
  private gesture: DragGesture | null = null;
  private samples: Array<{ t: number; x: number }> = [];
  private snapFrame = 0;
  private blockTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || this.gesture !== null) {
      return;
    }
    const element = this.element;
    if (!element || element.disabled) {
      return;
    }
    const geometry = this.measure(element);
    if (!geometry) {
      // No rendered track (unregistered, hidden, or upstream markup change):
      // leave the native click path fully intact.
      return;
    }
    if (this.snapFrame) {
      cancelAnimationFrame(this.snapFrame);
      this.snapFrame = 0;
    }
    this.gesture = { ...geometry, pointerId: event.pointerId, startPointerX: event.clientX };
    this.samples = [{ t: event.timeStamp, x: event.clientX }];
    // Retarget the rest of the gesture (and its trailing click) to this element,
    // so a release over the row cannot reach the row's click handler.
    this.disarmClickBlocker();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (tests) have no active pointer to capture.
    }
    // The stylesheet animates `translate`; while tracking, the thumb must be
    // 1:1. Document ::part() rules outrank a plain inline declaration (the
    // material in base.css gives the cap its own spring transition), so the
    // suppression itself needs the important declaration.
    geometry.thumb.style.setProperty("transition", "none", "important");
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    element.addEventListener("lostpointercapture", this.onLostPointerCapture);
    element.addEventListener("focusout", this.onFocusOut);
    window.addEventListener("blur", this.onWindowBlur);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    this.recordSample(event.timeStamp, event.clientX);
    const offset = this.clampOffset(gesture, event.clientX - gesture.startPointerX);
    gesture.thumb.style.translate = `${offset.toFixed(2)}px`;
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.gesture && event.pointerId === this.gesture.pointerId) {
      this.settle(event.clientX, event.timeStamp);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (this.gesture && event.pointerId === this.gesture.pointerId) {
      this.settle(null, event.timeStamp);
    }
  };

  private readonly onLostPointerCapture = () => {
    // Capture is lost after pointerup too; only an unreleased capture cancels.
    if (this.gesture !== null) {
      this.settle(null, 0);
    }
  };

  private readonly onFocusOut = () => {
    if (this.gesture !== null) {
      this.settle(null, 0);
    }
  };

  private readonly onWindowBlur = () => {
    if (this.gesture !== null) {
      this.settle(null, 0);
    }
  };

  // One-shot capture-phase blocker for the release's trailing click: label
  // forwarding would toggle the switch a second time, and a release outside
  // the switch retargets the click here only while capture is held. Scoped to
  // this element and disarmed after the gesture's task, so other switches,
  // keyboard activation, and later clicks stay native.
  private readonly blockTrailingClick = (event: MouseEvent) => {
    this.disarmClickBlocker();
    event.preventDefault();
    event.stopPropagation();
  };

  render(_options: SwitchDragOptions) {
    return nothing;
  }

  override update(part: ElementPart, [options]: [SwitchDragOptions]) {
    const element = part.element as DraggableSwitch;
    if (element !== this.element) {
      this.detachAll();
      this.element = element;
    }
    this.options = options;
    this.attachIfNeeded();
    return nothing;
  }

  protected override disconnected() {
    this.detachAll();
  }

  protected override reconnected() {
    // AsyncDirective update() does not rerun on reconnection; restore the
    // binding from the retained element.
    this.attachIfNeeded();
  }

  private attachIfNeeded() {
    const element = this.element;
    if (!element || this.attached || !this.isConnected) {
      return;
    }
    // Pan-y keeps vertical touch scrolling on the page while horizontal
    // touches drag the lever; effective touch-action is read at touch start,
    // so it must be in place before any gesture.
    element.style.touchAction = "pan-y";
    element.addEventListener("pointerdown", this.onPointerDown);
    this.attached = true;
  }

  private detachAll() {
    if (this.gesture && this.element) {
      this.settle(null, 0);
    }
    this.disarmClickBlocker();
    if (this.element && this.attached) {
      this.element.removeEventListener("pointerdown", this.onPointerDown);
      this.element.style.touchAction = "";
    }
    this.attached = false;
  }

  private measure(element: DraggableSwitch): DragGeometry | null {
    const thumb = element.shadowRoot?.querySelector<HTMLElement>('[part~="thumb"]');
    const control = element.shadowRoot?.querySelector<HTMLElement>('[part~="control"]');
    if (!thumb || !control) {
      return null;
    }
    const thumbBox = thumb.getBoundingClientRect();
    if (thumbBox.width <= 0) {
      return null;
    }
    // Poles are fixed by the track's own width/height — the exact values the
    // shadow CSS feeds into `translate: calc((width - height) / 2)` — and by
    // direction, never by the thumb's animated position: a grab mid-snap must
    // not record the in-flight offset as a pole (it used to invert them).
    const controlStyles = getComputedStyle(control);
    const width = Number.parseFloat(controlStyles.width);
    const height = Number.parseFloat(controlStyles.height);
    const travelHalf = Math.abs(width - height) / 2;
    if (!(travelHalf > 0)) {
      return null;
    }
    const checkedOffset = controlStyles.direction === "rtl" ? -travelHalf : travelHalf;
    const controlBox = control.getBoundingClientRect();
    const startOffset =
      thumbBox.left + thumbBox.width / 2 - (controlBox.left + controlBox.width / 2);
    return {
      checkedOffset,
      startOffset,
      thumb,
      travelHalf,
    };
  }

  private recordSample(t: number, x: number) {
    this.samples.push({ t, x });
    while (this.samples.length > 2 && t - this.samples[1]!.t >= FLICK_WINDOW_MS) {
      this.samples.shift();
    }
  }

  private releaseSpeed(samples: Array<{ t: number; x: number }>, releaseT: number): number {
    // The window is measured back from the release: a stationary hold between
    // the last move and the pointerup must not inherit the earlier velocity.
    const windowStart = releaseT - FLICK_WINDOW_MS;
    const oldest = samples.find((sample) => sample.t >= windowStart);
    const newest = samples[samples.length - 1];
    if (!oldest || !newest || newest === oldest) {
      return 0;
    }
    const dt = newest.t - oldest.t;
    return dt > 0 ? (newest.x - oldest.x) / dt : 0;
  }

  private clampOffset(gesture: DragGeometry, pointerTravel: number): number {
    const offset = gesture.startOffset + pointerTravel * DRAG_RESISTANCE;
    return Math.min(gesture.travelHalf, Math.max(-gesture.travelHalf, offset));
  }

  private decidePole(
    gesture: DragGesture,
    element: DraggableSwitch,
    endX: number,
    releaseT: number,
  ): boolean {
    const dx = endX - gesture.startPointerX;
    const speed = this.releaseSpeed(this.samples, releaseT);
    if (Math.abs(dx) < TAP_RADIUS_PX && Math.abs(speed) < FLICK_SPEED_PX_PER_MS) {
      // Press without meaningful motion: mirror the native click toggle.
      return !element.checked;
    }
    if (Math.abs(speed) >= FLICK_SPEED_PX_PER_MS) {
      return speed > 0 === gesture.checkedOffset > 0;
    }
    const offset = this.clampOffset(gesture, dx);
    const plusDistance = gesture.travelHalf - offset;
    const minusDistance = offset + gesture.travelHalf;
    if (plusDistance === minusDistance) {
      // Dead center: keep the committed pole.
      return element.checked;
    }
    return plusDistance < minusDistance === gesture.checkedOffset > 0;
  }

  /** Ends the gesture: endX/endT are the release pointer position and time, or
   * null to cancel. The samples survive until the pole verdict is made. */
  private settle(endX: number | null, releaseT: number) {
    const gesture = this.gesture;
    const element = this.element;
    this.gesture = null;
    if (this.snapFrame) {
      cancelAnimationFrame(this.snapFrame);
      this.snapFrame = 0;
    }
    if (element) {
      element.removeEventListener("pointermove", this.onPointerMove);
      element.removeEventListener("pointerup", this.onPointerUp);
      element.removeEventListener("pointercancel", this.onPointerCancel);
      element.removeEventListener("lostpointercapture", this.onLostPointerCapture);
      element.removeEventListener("focusout", this.onFocusOut);
      window.removeEventListener("blur", this.onWindowBlur);
      if (gesture) {
        try {
          element.releasePointerCapture(gesture.pointerId);
        } catch {
          // Capture already ended (pointerup, cancel, or element removal).
        }
      }
    }
    this.armClickBlocker();
    if (!gesture || !element) {
      this.samples = [];
      return;
    }
    const { thumb } = gesture;
    let target: boolean | null = null;
    if (endX !== null && !element.disabled) {
      // The release itself is the freshest velocity sample; decide the pole
      // while the samples are still alive.
      this.samples.push({ t: releaseT, x: endX });
      target = this.decidePole(gesture, element, endX, releaseT);
    }
    this.samples = [];
    if (target === null) {
      // Restore the committed pole; the stylesheet owns the settle animation
      // (and reduced-motion timing) again from here on.
      thumb.style.transition = "";
      thumb.style.translate = "";
      return;
    }
    const changed = element.checked !== target;
    // Re-enable the stylesheet transition and park the thumb on the target
    // pole in the same recalc, so the snap animates from the released
    // position. Both survive a synchronous rollback below.
    thumb.style.transition = "";
    thumb.style.translate = `${(target ? gesture.checkedOffset : -gesture.checkedOffset).toFixed(2)}px`;
    if (changed) {
      element.checked = target;
    }
    if (target !== (this.options?.checked() ?? element.checked)) {
      this.options?.onAct?.(target);
    }
    if (changed) {
      // Same contract as the native click path: one bubbling change the
      // owning template consumes (and may roll back).
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
    // Drop the parked override once the class-owned pole takes over.
    this.snapFrame = requestAnimationFrame(() => {
      this.snapFrame = 0;
      if (this.gesture === null) {
        thumb.style.translate = "";
      }
    });
  }

  private armClickBlocker() {
    const element = this.element;
    if (!element) {
      return;
    }
    this.disarmClickBlocker();
    element.addEventListener("click", this.blockTrailingClick, true);
    this.blockTimer = setTimeout(() => {
      this.blockTimer = null;
      element.removeEventListener("click", this.blockTrailingClick, true);
    }, 0);
  }

  private disarmClickBlocker() {
    if (this.blockTimer) {
      clearTimeout(this.blockTimer);
      this.blockTimer = null;
    }
    this.element?.removeEventListener("click", this.blockTrailingClick, true);
  }
}

export const switchDrag = directive(SwitchDragDirective);
