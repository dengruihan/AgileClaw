// Real-Chromium pointer sequences for the shared switch drag adapter: thumb
// tracking, pole snapping, click parity, single-commit guarantees, native
// keyboard/click passthrough, disabled, and cancellation cleanup.
import { html, render } from "lit";
import { live } from "lit/directives/live.js";
import { expect, it, vi } from "vitest";
import "../test-helpers/load-styles.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { switchDrag } from "./switch-drag.ts";

type SwitchElement = HTMLElement & { checked: boolean };

function pointer(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
): boolean {
  return element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointermove" ? 1 : 0,
      clientX: x,
      clientY: 0,
      isPrimary: true,
      pointerId: 7,
      pointerType: "mouse",
    }),
  );
}

function parts(element: SwitchElement) {
  const thumb = element.shadowRoot!.querySelector<HTMLElement>('[part~="thumb"]')!;
  const control = element.shadowRoot!.querySelector<HTMLElement>('[part~="control"]')!;
  return { thumb, control };
}

function geometry(element: SwitchElement) {
  const { thumb, control } = parts(element);
  const thumbBox = thumb.getBoundingClientRect();
  const controlBox = control.getBoundingClientRect();
  const thumbCenterX = thumbBox.left + thumbBox.width / 2;
  const trackCenterX = controlBox.left + controlBox.width / 2;
  return {
    control,
    thumb,
    thumbCenterX,
    trackCenterX,
    travelHalf: Math.abs(thumbCenterX - trackCenterX),
  };
}

async function fixture(options: {
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => boolean | void;
  onAct?: (checked: boolean) => void;
}) {
  const committed = options.checked ?? false;
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = options.onChange ?? (() => {});
  const draw = (): SwitchElement => {
    render(
      html`<wa-switch
        class="settings-toggle"
        size="s"
        .checked=${live(committed)}
        ?disabled=${options.disabled ?? false}
        ${switchDrag({ checked: () => committed, onAct: options.onAct })}
        @change=${(event: Event) => {
          const target = event.currentTarget as HTMLElement & { checked: boolean };
          if (onChange(target.checked) === false) {
            target.checked = committed;
          }
        }}
      ></wa-switch>`,
      container,
    );
    return container.querySelector<SwitchElement>("wa-switch")!;
  };
  const element = draw();
  await element.updateComplete;
  return { container, element };
}

/** Waits one animation frame so the post-commit inline-style cleanup ran. */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

it("tracks the pointer with the thumb and commits the pole under the release", async () => {
  const onAct = vi.fn();
  const onChange = vi.fn();
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onAct,
    onChange: (checked) => {
      changes.push(checked);
      onChange(checked);
    },
  });
  const start = geometry(f.element);
  expect(start.thumbCenterX).toBeLessThan(start.trackCenterX);

  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 4);
  const tracking = geometry(f.element);
  // The thumb follows the pointer (resistance 0.9, clamped to the poles).
  expect(tracking.thumbCenterX).toBeGreaterThan(start.thumbCenterX + 2);
  expect(parts(f.element).thumb.style.transition).toBe("none");
  expect(parts(f.element).thumb.style.translate).not.toBe("");

  pointer(f.element, "pointerup", start.trackCenterX + start.travelHalf + 12);
  expect(f.element.checked).toBe(true);
  expect(onAct).toHaveBeenCalledTimes(1);
  expect(onAct).toHaveBeenCalledWith(true);
  expect(changes).toEqual([true]);
  // The snap parks on the checked pole and the inline overrides clear again.
  await nextFrame();
  expect(parts(f.element).thumb.style.translate).toBe("");
  expect(parts(f.element).thumb.style.transition).toBe("");
  await expect
    .poll(() => geometry(f.element).thumbCenterX)
    .toBeGreaterThan(start.trackCenterX + start.travelHalf - 1);
});

it("snaps back to the off pole when dragged left and released", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: true,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  expect(start.thumbCenterX).toBeGreaterThan(start.trackCenterX);

  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX - start.travelHalf);
  pointer(f.element, "pointerup", start.thumbCenterX - 3 * start.travelHalf);
  expect(f.element.checked).toBe(false);
  expect(changes).toEqual([false]);
});

it("keeps click parity for a press-and-release without pointer travel", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointerup", start.thumbCenterX + 1);
  expect(f.element.checked).toBe(true);
  expect(changes).toEqual([true]);
});

it("commits the far pole when the pointer swipes the full travel quickly", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + start.travelHalf);
  pointer(f.element, "pointermove", start.thumbCenterX + 2 * start.travelHalf);
  pointer(f.element, "pointerup", start.thumbCenterX + 2 * start.travelHalf);
  expect(f.element.checked).toBe(true);
  expect(changes).toEqual([true]);
});

it("commits by position when the pointer never recorded a move", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointerup", start.thumbCenterX + 2 * start.travelHalf);
  expect(f.element.checked).toBe(true);
  expect(changes).toEqual([true]);
});

it("suppresses exactly the trailing click of a drag release", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 10);
  pointer(f.element, "pointerup", start.thumbCenterX + 12);
  expect(f.element.checked).toBe(true);
  expect(changes).toEqual([true]);

  const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
  const blocked = f.element.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(blocked).toBe(false);
  expect(changes).toEqual([true]);
  expect(f.element.checked).toBe(true);

  // The blocker disarms after the gesture's task, so later clicks stay native.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const later = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
  expect(f.element.dispatchEvent(later)).toBe(true);
  expect(later.defaultPrevented).toBe(false);
});

it("never engages a disabled switch and aborts when disabled mid-drag", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    disabled: true,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 10);
  pointer(f.element, "pointerup", start.thumbCenterX + 12);
  expect(f.element.checked).toBe(false);
  expect(changes).toEqual([]);
  expect(parts(f.element).thumb.style.translate).toBe("");

  f.element.disabled = false;
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 10);
  f.element.disabled = true;
  pointer(f.element, "pointerup", start.thumbCenterX + 12);
  expect(f.element.checked).toBe(false);
  expect(changes).toEqual([]);
  await nextFrame();
  expect(parts(f.element).thumb.style.translate).toBe("");
});

it("cancels cleanly on pointercancel without committing", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 8);
  expect(parts(f.element).thumb.style.translate).not.toBe("");
  pointer(f.element, "pointercancel", start.thumbCenterX + 8);
  expect(f.element.checked).toBe(false);
  expect(changes).toEqual([]);
  await nextFrame();
  expect(parts(f.element).thumb.style.translate).toBe("");
  expect(parts(f.element).thumb.style.transition).toBe("");
  const after = pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointerup", start.thumbCenterX + 1);
  expect(after).toBe(true);
  expect(f.element.checked).toBe(true);
  expect(changes).toEqual([true]);
});

it("leaves the native programmatic click path untouched", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  f.element.click();
  await expect.poll(() => changes.length, { timeout: 2_000 }).toBe(1);
  expect(f.element.checked).toBe(true);
});

it("keeps native ArrowLeft/ArrowRight keyboard behavior", async () => {
  const { userEvent } = await import("vitest/browser");
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  f.element.focus();
  expect(document.activeElement).toBe(f.element);
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => changes).toEqual([true]);
  expect(f.element.checked).toBe(true);
  await userEvent.keyboard("{ArrowLeft}");
  await expect.poll(() => changes).toEqual([true, false]);
  expect(f.element.checked).toBe(false);
});

it("cleans up a live gesture when the element disconnects", async () => {
  const changes: boolean[] = [];
  const f = await fixture({
    checked: false,
    onChange: (checked) => {
      changes.push(checked);
    },
  });
  const start = geometry(f.element);
  pointer(f.element, "pointerdown", start.thumbCenterX);
  pointer(f.element, "pointermove", start.thumbCenterX + 8);
  render(null, f.container);
  f.container.remove();
  pointer(f.element, "pointerup", start.thumbCenterX + 10);
  expect(changes).toEqual([]);
  expect(parts(f.element).thumb.style.translate).toBe("");
});
