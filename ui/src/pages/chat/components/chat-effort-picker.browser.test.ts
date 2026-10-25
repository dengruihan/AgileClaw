import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveChatFastModeSelectState,
  type ChatFastModeSelectState,
} from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";

let host: HTMLDivElement | undefined;

afterEach(() => {
  if (host) {
    render(nothing, host);
    host.remove();
    host = undefined;
  }
  document.documentElement.removeAttribute("data-theme-mode");
});

async function fixture(
  levels: Array<string | { id: string; label: string }>,
  value: string,
  inherited = false,
  fastMode?: ChatFastModeSelectState,
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  const onFastModeSelect = vi.fn(async () => undefined);
  render(
    renderChatEffortPicker({
      disabled: false,
      thinkingDisabled: false,
      sessionKey: "effort-preview",
      thinking: resolveChatThinkingSelectState({
        catalog: [],
        sessionKey: "effort-preview",
        sessionsResult: null,
        session: {
          thinkingLevel: inherited ? undefined : value,
          thinkingDefault: inherited ? value : "low",
          thinkingLevels: levels.map((level) =>
            typeof level === "string" ? { id: level, label: level } : level,
          ),
        },
      }),
      fastMode: fastMode ?? {
        active: false,
        currentOverride: "",
        disabled: true,
        label: "Off",
        nextValue: "on",
        supported: false,
      },
      onFastModeSelect,
      onThinkingSelect,
    }),
    host,
  );
  host.querySelector("details")!.open = true;
  await host.querySelector("wa-popup")!.updateComplete;
  return {
    input: host.querySelector<HTMLInputElement>("input[type=range]")!,
    onThinkingSelect,
    onFastModeSelect,
  };
}

function sliderLayers(input: HTMLInputElement) {
  const slider = input.closest<HTMLElement>(".chat-controls__reasoning-slider")!;
  return {
    slider,
    boost: slider.querySelector<HTMLElement>(".chat-controls__reasoning-boost")!,
    groove: slider.querySelector<HTMLElement>(".chat-controls__reasoning-groove")!,
    fill: slider.querySelector<HTMLElement>(".chat-controls__reasoning-fill")!,
    knob: slider.querySelector<HTMLElement>(".chat-controls__reasoning-knob")!,
  };
}

function appearance(input: HTMLInputElement) {
  const { boost, groove } = sliderLayers(input);
  const boostStyle = getComputedStyle(boost);
  return {
    wash: boostStyle.opacity === "1" ? boostStyle.backgroundImage : "none",
    glow: getComputedStyle(groove).boxShadow,
  };
}

// The boost wash and glow fade between states; wait for the layer to reach the
// state the input's data-effort-boost attribute asks for before comparing.
async function settledAppearance(input: HTMLInputElement) {
  const { boost } = sliderLayers(input);
  const boosted = input.dataset.effortBoost === "max" || input.dataset.effortBoost === "ultra";
  await vi.waitFor(() => expect(getComputedStyle(boost).opacity).toBe(boosted ? "1" : "0"));
  return appearance(input);
}

describe("effort bar colour and flow", () => {
  it("keeps speed names accessible without chip labels and only exposes entitled choices", async () => {
    const state = (mode: boolean | "ultrafast", tiers?: string[], supportsFastMode = true) =>
      resolveChatFastModeSelectState({
        activeRunId: null,
        connected: true,
        gatewayAvailable: true,
        loading: false,
        sending: false,
        stream: null,
        sessionsResult: null,
        currentModelOverride: "openai/model",
        fastModeTarget: { model: "model", modelProvider: "openai", fastMode: mode },
        catalog: [
          {
            id: "model",
            name: "Model",
            provider: "openai",
            available: true,
            supportsFastMode,
            serviceTiers: tiers,
          },
        ],
      });
    await fixture(["low", "medium", "high"], "high", false, state(false));
    expect(host!.querySelector("summary")!.textContent?.trim()).toBe("High");
    expect(host!.querySelectorAll("[data-chat-speed-option]")).toHaveLength(2);
    expect(host!.textContent).not.toContain("higher usage");
    const { onFastModeSelect } = await fixture(
      ["low", "medium", "high"],
      "high",
      false,
      state("ultrafast", ["priority", "ultrafast"]),
    );
    expect(host!.querySelector("summary")!.textContent?.trim()).toBe("High");
    expect(host!.querySelector("summary")!.getAttribute("aria-label")).toContain(
      "High · Ultrafast",
    );
    expect(host!.querySelector("summary")!.title).toBe("High · Ultrafast");
    expect(
      [...host!.querySelectorAll("[data-chat-speed-option]")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Standard", "Fast", "Ultrafast"]);
    const ultra = host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!;
    expect(ultra.getAttribute("aria-checked")).toBe("true");
    ultra.focus();
    ultra.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(onFastModeSelect).toHaveBeenLastCalledWith("on", "effort-preview");
    const standard = host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="off"]')!;
    standard.click();
    expect(onFastModeSelect).toHaveBeenLastCalledWith("off", "effort-preview");
    await fixture(
      ["low", "medium", "high"],
      "high",
      false,
      state("ultrafast", ["priority", "ultrafast"], false),
    );
    expect(host!.querySelector('[data-chat-speed-option="ultrafast"]')).toBeNull();
    expect(host!.querySelector('[data-chat-speed-option="on"]')).toBeNull();
    await fixture(["low", "medium", "high"], "high", false, state("ultrafast"));
    expect(host!.querySelector('[data-chat-speed-option="ultrafast"]')).toBeNull();
    expect(host!.querySelector("summary")!.getAttribute("aria-label")).not.toContain("Ultrafast");
    expect(host!.querySelector('[data-chat-speed-option="on"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it.each(["dark", "light"])("highlights the highest discrete effort in %s mode", async (theme) => {
    document.documentElement.dataset.themeMode = theme;
    for (const maximum of ["high", "xhigh", "max"]) {
      const levels = ["off", "low", maximum, "adaptive", "ultra"];
      const { input } = await fixture(levels, maximum);
      const maximumStyle = appearance(input);
      expect(maximumStyle.wash).toContain("linear-gradient");
      expect(maximumStyle.glow).not.toBe("none");
      expect(appearance((await fixture(levels, maximum, true)).input)).toEqual(maximumStyle);
      const ultraStyle = appearance((await fixture(levels, "ultra")).input);
      expect(ultraStyle.wash).toContain("linear-gradient");
      expect(ultraStyle.wash).not.toBe(maximumStyle.wash);
      expect(ultraStyle.glow).not.toBe(maximumStyle.glow);
      for (const value of ["off", "low", "adaptive", "unsupported"]) {
        expect(appearance((await fixture(levels, value)).input)).toEqual({
          wash: "none",
          glow: "none",
        });
      }
    }
    expect(appearance((await fixture(["off", "on"], "on")).input)).toEqual({
      wash: "none",
      glow: "none",
    });
    for (const id of ["low", "high"]) {
      const { input } = await fixture(["off", { id, label: "on" }, "ultra"], id);
      expect(appearance(input)).toEqual({ wash: "none", glow: "none" });
    }
  });

  it("ends the fill at the knob's center on every stop", async () => {
    const levels = ["off", "low", "medium", "high"];
    const { input } = await fixture(levels, "high");
    const { slider, fill, knob } = sliderLayers(input);
    const fillStyle = getComputedStyle(fill);
    const knobStyle = getComputedStyle(knob);
    expect(fillStyle.transitionProperty).toContain("width");
    expect(fillStyle.transitionDuration).toContain("0.3s");
    expect(knobStyle.transitionProperty).toContain("left");
    expect(knobStyle.transitionDuration).toContain("0.3s");
    const knobWidth = knob.getBoundingClientRect().width;
    const sliderLeft = slider.getBoundingClientRect().left;
    const sliderWidth = slider.clientWidth;
    for (const [index] of levels.entries()) {
      input.value = String(index);
      input.dispatchEvent(new Event("input"));
      const fraction = index / (levels.length - 1);
      const expected = sliderWidth * fraction + knobWidth / 2 - knobWidth * fraction;
      await vi.waitFor(() => {
        expect(Math.abs(fill.getBoundingClientRect().width - expected)).toBeLessThanOrEqual(1.5);
        const knobCenter =
          knob.getBoundingClientRect().left + knob.getBoundingClientRect().width / 2;
        expect(Math.abs(knobCenter - (sliderLeft + expected))).toBeLessThanOrEqual(1.5);
      });
    }
  });

  it("previews colour without committing and restores the committed level on cancel or blur", async () => {
    const { input, onThinkingSelect } = await fixture(["low", "max", "ultra"], "max", true);
    const maximumStyle = await settledAppearance(input);
    for (const resetEvent of ["pointercancel", "blur"]) {
      input.value = "2";
      input.dispatchEvent(new Event("input"));
      expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(appearance(input)).not.toEqual(maximumStyle);
      expect(onThinkingSelect).not.toHaveBeenCalled();
      input.dispatchEvent(new Event(resetEvent));
      expect(input.value).toBe("1");
      expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
      expect(await settledAppearance(input)).toEqual(maximumStyle);
    }
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    expect(appearance(input)).not.toEqual(maximumStyle);
    await vi.waitFor(() => expect(appearance(input)).toEqual({ wash: "none", glow: "none" }));
    input.dispatchEvent(new Event("change"));
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
    expect(await settledAppearance(input)).toEqual(maximumStyle);
  });
});
