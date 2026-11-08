import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceDrawerDrag } from "./marketplace-drawer-drag.ts";

/**
 * The page calls cancel() from disconnectedCallback while a gesture is live.
 * That path must be cleanup-only: no settle or arrive timer may survive it,
 * because its callbacks would only mutate the detached nodes being torn down.
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
  const tab = document.createElement("button");
  tab.style.width = "20px";
  document.body.append(tab);
  return tab;
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

describe("MarketplaceDrawerDrag cancel", () => {
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
    const tab = mountTriggerFixture();
    tab.addEventListener("pointerdown", (event) => drag.triggerPointerDown(event));

    tab.dispatchEvent(pointerEvent("pointerdown", { clientX: 1400 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1350 }));
    expect(host.beginPreview).toHaveBeenCalledTimes(1);

    drag.cancel();
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
    const { handle } = mountDrawerFixture();
    handle.addEventListener("pointerdown", (event) => drag.drawerHandlePointerDown(event));

    handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 1000 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 1100 }));

    drag.cancel();
    vi.advanceTimersByTime(1_000);
    expect(host.closeMarketplace).not.toHaveBeenCalled();
    expect(host.openFromDrag).not.toHaveBeenCalled();
  });
});
