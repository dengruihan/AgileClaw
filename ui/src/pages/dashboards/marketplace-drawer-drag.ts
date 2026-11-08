/**
 * Pointer gesture owner for the marketplace drawer's pull tab and edge handle.
 * The dashboards page keeps the single open-state owner; this controller only
 * paints drag-follow transforms on the tab, the drag-preview drawer, or the
 * open drawer panel, and reports each gesture's verdict through host callbacks.
 *
 * Drawer geometry: the drawer is anchored to the viewport's right edge, so
 * open is translateX(0) and closed is translateX(+width). Opening drags left
 * and closing drags right.
 */

const LOCK_DISTANCE_PX = 5;
const DIRECTION_RATIO = 1.2;
// Pulling the closed tab first overcomes a stiff catch; the drawer then
// follows the pointer 1:1 while the tab's own travel meets end resistance.
const TRIGGER_CATCH_PX = 10;
const TAB_TRAVEL_PX = 56;
const TAB_HARD_TRAVEL_PX = 84;
const OPEN_PULL_PX = 72;
const FLICK_PX_PER_MS = 0.45;
// A flick verdict needs a still-moving gesture: a fast move followed by a
// deliberate pause must settle on position alone, not on the stale sample.
const FLICK_SAMPLE_AGE_MS = 100;
const CLOSE_RATIO = 0.5;
// Must stay >= the matching settle/landing durations in dashboards.css.
const SETTLE_WAIT_MS = 300;

const DRAG_END_EVENTS = ["pointerup", "pointercancel", "blur"] as const;

type TriggerDrag = {
  kind: "trigger";
  tab: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  locked: boolean;
  velocity: number;
  lastX: number;
  lastT: number;
};

type DrawerDrag = {
  kind: "drawer";
  handle: HTMLElement;
  panel: HTMLElement;
  width: number;
  pointerId: number;
  startX: number;
  startY: number;
  locked: boolean;
  /** Shift the panel already had when grabbed, so re-grabs stay continuous. */
  baseShift: number;
  velocity: number;
  lastX: number;
  lastT: number;
};

type DragSession = TriggerDrag | DrawerDrag;

export type MarketplaceDrawerDragHost = {
  /** Enter drag-preview: the page mounts the drawer preview for this gesture. */
  beginPreview: () => void;
  /** Leave drag-preview without opening, once the spring-shut has settled. */
  endPreview: () => void;
  /** Commit the gesture's open verdict; the page owns the modal handoff. */
  openFromDrag: () => void;
  closeMarketplace: () => void;
};

/** Effective pull after the closed catch: stiff up front, then 1:1. */
function effectivePull(rawPull: number): number {
  if (rawPull <= 0) {
    return 0;
  }
  const catchPull = Math.min(rawPull, TRIGGER_CATCH_PX) * 0.5;
  return catchPull + Math.max(rawPull - TRIGGER_CATCH_PX, 0);
}

/** The tab itself travels less than the drawer: free travel, then end resistance. */
function tabTravel(pull: number): number {
  if (pull <= TAB_TRAVEL_PX) {
    return pull;
  }
  return Math.min(TAB_TRAVEL_PX + (pull - TAB_TRAVEL_PX) * 0.3, TAB_HARD_TRAVEL_PX);
}

/** Drawer offset for a total displacement: rightward toward closed 1:1 with
 *  damping past closed, leftward past open resisted. */
function drawerShift(totalDisplacement: number, width: number): number {
  if (totalDisplacement >= 0) {
    const close = Math.min(totalDisplacement, width);
    const overrun = totalDisplacement > width ? (totalDisplacement - width) * 0.18 : 0;
    return close + overrun;
  }
  return totalDisplacement * 0.18;
}

/** The panel's live X offset, including mid-settle transition frames. */
function currentShift(panel: HTMLElement): number {
  const transform = getComputedStyle(panel).transform;
  if (!transform || transform === "none") {
    return 0;
  }
  return new DOMMatrixReadOnly(transform).m41;
}

export class MarketplaceDrawerDrag {
  private session: DragSession | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private arriveTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextClick = false;

  constructor(private readonly host: MarketplaceDrawerDragHost) {}

  /** A click that trails a locked drag is the gesture's tail, not an activation. */
  consumeDragActivation(): boolean {
    const suppressed = this.suppressNextClick;
    this.suppressNextClick = false;
    return suppressed;
  }

  triggerPointerDown(event: PointerEvent): void {
    const tab = event.currentTarget;
    if (!(tab instanceof HTMLElement) || !event.isPrimary || event.button !== 0) {
      return;
    }
    this.startSession({
      kind: "trigger",
      tab,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      locked: false,
      velocity: 0,
      lastX: event.clientX,
      lastT: event.timeStamp,
    });
  }

  drawerHandlePointerDown(event: PointerEvent): void {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement) || !event.isPrimary || event.button !== 0) {
      return;
    }
    const panel = handle.closest<HTMLElement>(".dashboards-marketplace__panel");
    const width = panel?.getBoundingClientRect().width ?? 0;
    if (!panel || width <= 0) {
      return;
    }
    this.startSession({
      kind: "drawer",
      // Capture stays on the grasped control so the trailing click and focus
      // land on the handle, not on the panel it drags.
      handle,
      panel,
      width,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      locked: false,
      baseShift: 0,
      velocity: 0,
      lastX: event.clientX,
      lastT: event.timeStamp,
    });
  }

  /** Ends any live gesture and drops every timer, listener, and capture. */
  cancel(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.arriveTimer) {
      clearTimeout(this.arriveTimer);
      this.arriveTimer = null;
    }
    const session = this.session;
    if (!session) {
      return;
    }
    // Cleanup only: a settle would just schedule timers that mutate the
    // detached nodes a disconnecting page is tearing down.
    this.releaseSession(session);
    this.session = null;
  }

  private startSession(session: DragSession): void {
    if (this.session) {
      return;
    }
    // A fresh grab takes over from any pending settle: its timers must not
    // fight the new drag's transforms or close a drawer the user re-held.
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.arriveTimer) {
      clearTimeout(this.arriveTimer);
      this.arriveTimer = null;
    }
    this.suppressNextClick = false;
    this.session = session;
    const element = session.kind === "trigger" ? session.tab : session.handle;
    this.capturePointer(element, session.pointerId);
    window.addEventListener("pointermove", this.handlePointerMove);
    for (const type of DRAG_END_EVENTS) {
      window.addEventListener(type, this.handleSessionEnd);
    }
    element.addEventListener("lostpointercapture", this.handleLostCapture);
  }

  private releaseSession(session: DragSession): void {
    const element = session.kind === "trigger" ? session.tab : session.handle;
    element.removeEventListener("lostpointercapture", this.handleLostCapture);
    window.removeEventListener("pointermove", this.handlePointerMove);
    for (const type of DRAG_END_EVENTS) {
      window.removeEventListener(type, this.handleSessionEnd);
    }
    this.releasePointer(element, session.pointerId);
  }

  /**
   * The preview drawer mounts asynchronously once the page enters drag-preview;
   * keep resolving it from the tab until Lit has rendered it.
   */
  private findPreviewPanel(tab: HTMLElement): HTMLElement | null {
    const page = tab.closest("openclaw-dashboards-page");
    return (
      page?.querySelector<HTMLElement>("[data-marketplace-preview] [data-marketplace]") ?? null
    );
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    if (!session.locked) {
      const distanceX = Math.abs(deltaX);
      const distanceY = Math.abs(deltaY);
      if (Math.max(distanceX, distanceY) < LOCK_DISTANCE_PX) {
        return;
      }
      const horizontal = distanceX >= distanceY * DIRECTION_RATIO;
      if ((session.kind === "trigger" && deltaX > 0) || !horizontal) {
        // Vertical intent or a push against the cabinet is not a pull.
        this.suppressNextClick = true;
        this.endSession(session, true);
        return;
      }
      session.locked = true;
      this.suppressNextClick = true;
      if (session.kind === "trigger") {
        session.tab.setAttribute("data-dragging", "");
        this.host.beginPreview();
      } else {
        // A re-grab during a settle must continue from where the panel
        // actually is, not from a zero the settle had already left behind.
        session.baseShift = currentShift(session.panel);
        session.panel.setAttribute("data-dragging", "");
        session.panel.removeAttribute("data-arrived");
      }
    }
    event.preventDefault();
    if (session.kind === "trigger") {
      this.paintTrigger(session, effectivePull(-deltaX));
    } else {
      this.paintDrawer(session, drawerShift(session.baseShift + deltaX, session.width));
    }
    // The release position usually equals the last move, so flick speed has to
    // roll forward from the move samples themselves.
    session.velocity =
      (event.clientX - session.lastX) / Math.max(event.timeStamp - session.lastT, 1);
    session.lastX = event.clientX;
    session.lastT = event.timeStamp;
  };

  private readonly handleSessionEnd = (event: Event): void => {
    const session = this.session;
    if (!session) {
      return;
    }
    if (event.type === "blur") {
      this.settleBack(session);
      this.endSession(session, true);
      return;
    }
    if (!("pointerId" in event) || event.pointerId !== session.pointerId) {
      return;
    }
    if (event.type !== "pointerup") {
      this.settleBack(session);
      this.endSession(session, true);
      return;
    }
    const pointer = event as PointerEvent;
    // Position decides on its own unless the gesture was still moving.
    const velocity =
      pointer.timeStamp - session.lastT <= FLICK_SAMPLE_AGE_MS ? session.velocity : 0;
    if (session.kind === "trigger") {
      const pull = effectivePull(-(pointer.clientX - session.startX));
      this.settleTrigger(session, pull >= OPEN_PULL_PX || velocity <= -FLICK_PX_PER_MS);
    } else {
      const shift = drawerShift(
        session.baseShift + (pointer.clientX - session.startX),
        session.width,
      );
      const closeProgress = Math.min(shift / session.width, 1);
      const shouldClose = closeProgress >= CLOSE_RATIO || velocity >= FLICK_PX_PER_MS;
      this.settleDrawer(session, shouldClose);
    }
    this.endSession(session, false);
  };

  private readonly handleLostCapture = (event: Event): void => {
    const session = this.session;
    if (!session || !("pointerId" in event) || event.pointerId !== session.pointerId) {
      return;
    }
    this.settleBack(session);
    this.endSession(session, true);
  };

  private paintTrigger(session: TriggerDrag, pull: number): void {
    session.tab.style.setProperty(
      "--dashboards-marketplace-pull",
      `${tabTravel(pull).toFixed(2)}px`,
    );
    session.tab.toggleAttribute("data-armed", pull >= OPEN_PULL_PX);
    const preview = this.findPreviewPanel(session.tab);
    if (preview) {
      const width = preview.getBoundingClientRect().width;
      if (width > 0) {
        const reveal = Math.min(pull, width);
        preview.style.transform = `translateX(${(width - reveal).toFixed(2)}px)`;
        preview.setAttribute("data-dragging", "");
      }
    }
  }

  private paintDrawer(session: DrawerDrag, shift: number): void {
    session.panel.style.transform = `translateX(${shift.toFixed(2)}px)`;
  }

  /** Springs the tab or drawer back without changing the page's open state. */
  private settleBack(session: DragSession): void {
    if (session.kind === "trigger") {
      this.settleTrigger(session, false);
    } else {
      this.settleDrawer(session, false);
    }
  }

  private settleTrigger(session: TriggerDrag, open: boolean): void {
    const tab = session.tab;
    tab.removeAttribute("data-dragging");
    tab.removeAttribute("data-armed");
    tab.style.removeProperty("--dashboards-marketplace-pull");
    const preview = this.findPreviewPanel(tab);
    if (preview) {
      preview.removeAttribute("data-dragging");
      const width = preview.getBoundingClientRect().width;
      // Open hands off to the page's modal landing; shut springs fully closed
      // before the page unmounts the preview.
      preview.style.transform = open ? "translateX(0px)" : `translateX(${width}px)`;
      if (!open) {
        this.settleTimer = this.replaceTimer(
          this.settleTimer,
          () => {
            this.host.endPreview();
          },
          SETTLE_WAIT_MS,
        );
      }
    }
    if (open) {
      this.host.openFromDrag();
    }
  }

  private settleDrawer(session: DrawerDrag, close: boolean): void {
    const panel = session.panel;
    panel.removeAttribute("data-dragging");
    panel.style.transform = close ? `translateX(${session.width}px)` : "";
    if (close) {
      this.settleTimer = this.replaceTimer(
        this.settleTimer,
        () => {
          panel.style.transform = "";
          this.host.closeMarketplace();
        },
        SETTLE_WAIT_MS,
      );
      return;
    }
    this.settleTimer = this.replaceTimer(
      this.settleTimer,
      () => {
        panel.setAttribute("data-arrived", "");
        this.arriveTimer = this.replaceTimer(
          this.arriveTimer,
          () => panel.removeAttribute("data-arrived"),
          420,
        );
      },
      SETTLE_WAIT_MS,
    );
  }

  private endSession(session: DragSession, canceled: boolean): void {
    if (canceled) {
      this.suppressNextClick = this.suppressNextClick || session.locked;
    }
    this.releaseSession(session);
    if (this.session === session) {
      this.session = null;
    }
  }

  private replaceTimer(
    timer: ReturnType<typeof setTimeout> | null,
    run: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> | null {
    if (timer) {
      clearTimeout(timer);
    }
    return setTimeout(run, delay);
  }

  private capturePointer(element: HTMLElement, pointerId: number): void {
    if (typeof element.setPointerCapture !== "function") {
      return;
    }
    element.setPointerCapture(pointerId);
  }

  private releasePointer(element: HTMLElement, pointerId: number): void {
    if (typeof element.releasePointerCapture !== "function") {
      return;
    }
    if (typeof element.hasPointerCapture === "function" && !element.hasPointerCapture(pointerId)) {
      return;
    }
    element.releasePointerCapture(pointerId);
  }
}
