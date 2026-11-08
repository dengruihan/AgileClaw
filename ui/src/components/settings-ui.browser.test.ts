import { html, render, type LitElement } from "lit";
import { expect, it, vi } from "vitest";
import "../test-helpers/load-styles.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.ts";
import {
  renderSettingsSegmented,
  renderSettingsToggle,
  renderSettingsToggleRow,
} from "./settings-ui.ts";
import "./settings-save-indicator.ts";
import startupStyles from "../styles.css?inline";

it("animates Applying before lazy settings styles load", async () => {
  const container = document.createElement("div");
  // Keep lazy route keyframes from masking a missing startup animation owner.
  const root = container.attachShadow({ mode: "open" });
  document.body.append(container);
  try {
    render(
      html`<style>
          ${startupStyles}
        </style>
        <openclaw-settings-save-indicator
          .props=${
            {
              status: "idle",
              lastError: null,
              needsApply: true,
              applying: true,
              applyDisabled: false,
              onRetry: vi.fn(),
              onSave: vi.fn(),
              onReload: vi.fn(),
              onApply: vi.fn(),
            } satisfies SettingsSaveIndicatorProps
          }
        ></openclaw-settings-save-indicator>`,
      root,
    );
    const indicator = root.querySelector<LitElement>("openclaw-settings-save-indicator")!;
    await indicator.updateComplete;
    const spinner = indicator.querySelector<SVGElement>(".settings-save-indicator__spinner svg")!;
    const animations = spinner.getAnimations();
    expect(animations.length).toBeGreaterThan(0);
    const animation = animations[0]!;
    const duration = Number(animation.effect!.getComputedTiming().duration);
    expect(duration).toBeGreaterThan(0);
    animation.pause();
    animation.currentTime = duration / 4;
    const transform = new DOMMatrixReadOnly(getComputedStyle(spinner).transform);
    expect(transform.a).toBeCloseTo(0);
    expect(transform.b).toBeCloseTo(1);
  } finally {
    render(null, root);
    container.remove();
  }
});

it("restores segmented controls after fieldset busy state while preserving disabled options", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = vi.fn();
  const draw = (busy: boolean, disabled = false) =>
    render(
      html`<fieldset ?disabled=${busy}>
        ${renderSettingsSegmented({
          value: "first",
          disabled,
          ariaLabel: "Schedule",
          options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
            { value: "locked", label: "Locked", disabled: true },
          ],
          onChange,
        })}
      </fieldset>`,
      container,
    );
  const disabledStates = () =>
    [...container.querySelectorAll("wa-radio")].map((radio) => radio.getAttribute("aria-disabled"));
  try {
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
    draw(true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    draw(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(disabledStates()).toEqual(["true", "true", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("second", expect.any(HTMLElement)),
    );
    onChange.mockClear();
    draw(true, true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    draw(false, true);
    await expect.poll(disabledStates).toEqual(["true", "true", "true"]);
    container.querySelector<HTMLElement>('wa-radio[value="second"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    await expect.poll(disabledStates).toEqual(["false", "false", "true"]);
  } finally {
    render(null, container);
    container.remove();
  }
});

type ToggleRowFixture = {
  container: HTMLDivElement;
  draw: (options?: { checked?: boolean; disabled?: boolean }) => HTMLElement;
  switchElement: () => HTMLElement & { checked: boolean };
};

function toggleRowFixture(options: {
  onChange: (checked: boolean) => boolean | void;
  onAct?: (checked: boolean) => void;
}): ToggleRowFixture {
  const container = document.createElement("div");
  document.body.append(container);
  const state = { checked: false, disabled: false };
  // The fixture plays the owning page: accepted toggles move the committed
  // prop and re-render (live() re-asserts it); rejections leave the prop.
  const handleChange = (checked: boolean) => {
    const result = options.onChange(checked);
    if (result !== false) {
      state.checked = checked;
      draw();
    }
    return result;
  };
  const draw = () =>
    render(
      html`${renderSettingsToggleRow({
        title: "Browser enabled",
        checked: state.checked,
        disabled: state.disabled,
        onChange: handleChange,
        onAct: options.onAct,
      })}`,
      container,
    );
  const drawOnce = (initial: { checked?: boolean; disabled?: boolean } = {}) => {
    state.checked = initial.checked ?? false;
    state.disabled = initial.disabled ?? false;
    draw();
    return container;
  };
  return {
    container,
    draw: drawOnce,
    switchElement: () => container.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!,
  };
}

it("commits one dragged toggle flip with onAct before onChange", async () => {
  const { userEvent } = await import("vitest/browser");
  const onAct = vi.fn();
  const onChange = vi.fn();
  const changes: boolean[] = [];
  const f = toggleRowFixture({
    onAct,
    onChange: (checked) => {
      changes.push(checked);
      onChange(checked);
    },
  });
  f.draw({ checked: false });
  const switchElement = f.switchElement();
  try {
    await userEvent.click(switchElement);
    expect(switchElement.checked).toBe(true);
    expect(changes).toEqual([true]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith(true);
    expect(onAct.mock.invocationCallOrder[0]).toBeLessThan(onChange.mock.invocationCallOrder[0]!);
    // A second physical click keeps flipping exactly once per gesture.
    await userEvent.click(switchElement);
    expect(switchElement.checked).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onAct).toHaveBeenCalledTimes(2);
  } finally {
    render(null, f.container);
    f.container.remove();
  }
});

it("restores the switch when the dragged change is rejected", async () => {
  const { userEvent } = await import("vitest/browser");
  const changes: boolean[] = [];
  const f = toggleRowFixture({
    onChange: (checked) => {
      changes.push(checked);
      return false;
    },
  });
  f.draw({ checked: false });
  const switchElement = f.switchElement();
  try {
    await userEvent.click(switchElement);
    expect(changes).toEqual([true]);
    expect(switchElement.checked).toBe(false);
    await expect
      .poll(
        () =>
          switchElement.shadowRoot!.querySelector<HTMLElement>('[part~="thumb"]')!.style.translate,
      )
      .toBe("");
  } finally {
    render(null, f.container);
    f.container.remove();
  }
});

it("keeps the whole-row click path toggling with onAct before onChange", async () => {
  const { userEvent } = await import("vitest/browser");
  const onAct = vi.fn();
  const onChange = vi.fn();
  const f = toggleRowFixture({ onAct, onChange });
  f.draw({ checked: false });
  let changeEvents = 0;
  f.switchElement().addEventListener("change", () => {
    changeEvents += 1;
  });
  try {
    await userEvent.click(f.container.querySelector<HTMLElement>(".settings-row__title")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith(true);
    expect(onAct.mock.invocationCallOrder[0]).toBeLessThan(onChange.mock.invocationCallOrder[0]!);
    // The row path moves the committed prop through the owner's re-render
    // (live() applies it) without producing a switch change event.
    expect(f.switchElement().checked).toBe(true);
    expect(changeEvents).toBe(0);
  } finally {
    render(null, f.container);
    f.container.remove();
  }
});

it("keeps disabled settings toggles inert", async () => {
  const { userEvent } = await import("vitest/browser");
  const onChange = vi.fn();
  const f = toggleRowFixture({ onChange });
  f.draw({ checked: false, disabled: true });
  const switchElement = f.switchElement();
  try {
    await userEvent.click(switchElement);
    expect(switchElement.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    render(null, f.container);
    f.container.remove();
  }
});

it("keeps bare settings toggles draggable through their change contract", async () => {
  const { userEvent } = await import("vitest/browser");
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = vi.fn();
  try {
    render(
      html`${renderSettingsToggle({
        checked: false,
        ariaLabel: "Watcher",
        onChange,
      })}`,
      container,
    );
    const switchElement = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!;
    await userEvent.click(switchElement);
    expect(switchElement.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  } finally {
    render(null, container);
    container.remove();
  }
});
