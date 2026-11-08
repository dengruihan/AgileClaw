import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceDrawerDrag } from "./marketplace-drawer-drag.ts";

/**
 * Two teardown paths own timers besides the verdicts themselves:
 * - The page calls cancel() from disconnectedCallback while a gesture is
 *   live. That path must be cleanup-only: no settle or arrive timer may
 *   survive it, because its callbacks would only mutate the detached nodes
 *   being torn down.
 * - A rejected re-grab took over a pending settle (startSession cleared its
 *   timers), so the rejection must hand the gesture back to that settle
 *   instead of stranding the drawer panel or preview painted shut.
 */

function pointerEvent(
  type: string,
  fields: { pointerId?: number; clientX?: number; clientY?: number } = {},
) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: fields.clientX ?? 500 },
    clientY: { value: fields.clientY ?? 300 },
    isPrimary: { value: true },
    pointerId: { value: fields.pointerId ?? 1 },
  });
  return event;
}

function mountTriggerFixture() {
  // The trigger resolves its drag preview through the page element, so the
  // fixture mounts the same page > preview > drawer shape the page renders.
  const page = document.createElement("openclaw-dashboards-page");
  const preview = document.createElement("div");
  preview.setAttribute("data-marketplace-preview", "");
  const drawer = document.createElement("div");
  drawer.setAttribute("data-marketplace", "");
  const tab = document.createElement("button");
  tab.style.width = "20px";
  drawer.append(tab);
  preview.append(drawer);
  page.append(preview);
  document.body.append(page);
  return { tab, preview };
}

function mountDrawerFixture() {
  const panel = document.createElement("section");
  panel.className = "dashboards-marketplace__panel";
  panel.getBoundingClientRect = () =>
    ({
      width: 440,
      height: 600,
      x: 1000,
      y: 0,
      top: 0,
      right: 1440,
      bottom: 600,
      left: 1000,
      toJSON: () => ({}),
    }) as DOMRect;
  const handle = document.createElement("button");
  handle.setAttribute("data-marketplace-handle", "");
  panel.append(handle);
  document.body.append(panel);
  return { panel, handle };
}

describe("MarketplaceDrawerDrag cancel and rejected re-grabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("ends a locked trigger gesture without scheduling a settle", () => {
    const host = {
      beginPreview: vi.fn(),
      endPreview: vi.fn(),
      openFromDrag: vi.fn(),
      closeMarketplace: vi.fn(),
    };
    const drag = new MarketplaceDrawerDrag(host);
    const { tab } = mountTriggerFixture();
    tab.addEventListener("pointerdown", (event) => drag.triggerPointerDown(event));

    tab.dispatchEvent(pointerEvent("pointerdown", { clientX: 1400 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1350 }));
    expect(host.beginPreview).toHaveBeenCalledTimes(1);

    drag.cancel();
    // The defective cancel sprang the preview shut via settleBack(), which
    // scheduled the endPreview timer; no timer may survive the cleanup.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(host.endPreview).not.toHaveBeenCalled();
    expect(host.openFromDrag).not.toHaveBeenCalled();
  });

  it("ends a locked drawer gesture without scheduling a close or arrive", () => {
    const host = {
      beginPreview: vi.fn(),
      endPreview: vi.fn(),
      openFromDrag: vi.fn(),
      closeMarketplace: vi.fn(),
    };
    const drag = new MarketplaceDrawerDrag(host);
    const { panel, handle } = mountDrawerFixture();
    handle.addEventListener("pointerdown", (event) => drag.drawerHandlePointerDown(event));

    handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 1000 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1100 }));

    drag.cancel();
    // The defective cancel sprang the drawer back via settleBack(), which
    // scheduled the settle and then the arrive timer without any host
    // callback; no timer may survive the cleanup.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(host.closeMarketplace).not.toHaveBeenCalled();
    expect(host.openFromDrag).not.toHaveBeenCalled();
    expect(panel.getAttribute("data-arrived")).toBeNull();
  });

  it("hands a re-grabbed close back to its settle when the re-grab is rejected as vertical intent", () => {
    const host = {
      beginPreview: vi.fn(),
      endPreview: vi.fn(),
      openFromDrag: vi.fn(),
      closeMarketplace: vi.fn(),
    };
    const drag = new MarketplaceDrawerDrag(host);
    const { panel, handle } = mountDrawerFixture();
    handle.addEventListener("pointerdown", (event) => drag.drawerHandlePointerDown(event));

    // Start a close past half travel and release: the close verdict paints
    // the fully closed transform and schedules the unmounting settle.
    handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 1000 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1350 }));
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 1350 }));
    expect(panel.style.transform).toBe("translateX(440px)");

    // Re-grab during that settle and move mostly vertically: not a pull, so
    // the drawer must spring back open and keep the marketplace mounted —
    // not keep the closed transform whose settle timer the grab cancelled.
    handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 1350 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1350, clientY: 330 }));
    expect(panel.style.transform).toBe("");
    expect(host.closeMarketplace).not.toHaveBeenCalled();

    // The trailing pointerup and the settle pulse never close the marketplace.
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 1350, clientY: 330 }));
    vi.advanceTimersByTime(1_000);
    expect(host.closeMarketplace).not.toHaveBeenCalled();
    expect(host.openFromDrag).not.toHaveBeenCalled();
    expect(panel.getAttribute("data-arrived")).toBeNull();
  });
});
