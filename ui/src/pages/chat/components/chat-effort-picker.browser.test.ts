import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { renderChatEffortPanel } from "./chat-effort-picker.ts";

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
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  render(
    renderChatEffortPanel({
      sessionKey: "effort-preview",
      thinkingDisabled: false,
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
      onThinkingSelect,
    }),
    host,
  );
  return {
    input: host.querySelector<HTMLInputElement>("input[type=range]")!,
    onThinkingSelect,
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
  // The groove's accent glow is driven by the input's data-effort-boost state;
  // the resting ring is a zero-blur outline, not a glow.
  const boosted = input.dataset.effortBoost === "max" || input.dataset.effortBoost === "ultra";
  return {
    wash: boostStyle.opacity === "1" ? boostStyle.backgroundImage : "none",
    glow: boosted ? getComputedStyle(groove).boxShadow : "none",
  };
}

// The boost wash and glow fade between states; wait for the layer to reach the
// state the input's data-effort-boost attribute asks for before comparing.
// The groove's ring/glow fades in parallel and may finish a tick later, so its
// shadow must also stop changing before equality comparisons read it; the
// highlight hue crossfades the same way through its registered property.
async function settledAppearance(input: HTMLInputElement) {
  const { boost, groove } = sliderLayers(input);
  const boosted = input.dataset.effortBoost === "max" || input.dataset.effortBoost === "ultra";
  await vi.waitFor(() => expect(getComputedStyle(boost).opacity).toBe(boosted ? "1" : "0"));
  let lastShadow = "";
  let lastHighlight = "";
  await vi.waitFor(() => {
    const currentShadow = getComputedStyle(groove).boxShadow;
    const currentHighlight = getComputedStyle(boost).getPropertyValue(
      "--reasoning-boost-highlight",
    );
    const stable = currentShadow === lastShadow && currentHighlight === lastHighlight;
    lastShadow = currentShadow;
    lastHighlight = currentHighlight;
    expect(stable).toBe(true);
  });
  return appearance(input);
}

describe("effort bar colour and flow", () => {
  it.each(["dark", "light"])("highlights the highest discrete effort in %s mode", async (theme) => {
    document.documentElement.dataset.themeMode = theme;
    for (const maximum of ["high", "xhigh", "max"]) {
      const levels = ["off", "low", maximum, "adaptive", "ultra"];
      const { input } = await fixture(levels, maximum);
      const maximumStyle = await settledAppearance(input);
      expect(maximumStyle.wash).toContain("linear-gradient");
      expect(maximumStyle.glow).not.toBe("none");
      expect(await settledAppearance((await fixture(levels, maximum, true)).input)).toEqual(
        maximumStyle,
      );
      const ultraStyle = await settledAppearance((await fixture(levels, "ultra")).input);
      expect(ultraStyle.wash).toContain("linear-gradient");
      expect(ultraStyle.wash).not.toBe(maximumStyle.wash);
      expect(ultraStyle.glow).not.toBe(maximumStyle.glow);
      for (const value of ["off", "low", "adaptive", "unsupported"]) {
        expect(await settledAppearance((await fixture(levels, value)).input)).toEqual({
          wash: "none",
          glow: "none",
        });
      }
    }
    expect(await settledAppearance((await fixture(["off", "on"], "on")).input)).toEqual({
      wash: "none",
      glow: "none",
    });
    for (const id of ["low", "high"]) {
      const { input } = await fixture(["off", { id, label: "on" }, "ultra"], id);
      expect(await settledAppearance(input)).toEqual({ wash: "none", glow: "none" });
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

  it("crossfades the boost effects between max and ultra", async () => {
    const { input } = await fixture(["off", "low", "max", "ultra"], "max");
    const { boost, slider } = sliderLayers(input);
    const boostStyle = getComputedStyle(boost);
    // Registered highlight + transitioned inset sheen: every max→ultra delta
    // interpolates instead of snapping.
    expect(boostStyle.transitionProperty).toContain("--reasoning-boost-highlight");
    expect(boostStyle.transitionProperty).toContain("box-shadow");
    const maxHighlight = boostStyle.getPropertyValue("--reasoning-boost-highlight");
    // A registered <color> property resolves to a concrete color; an
    // unregistered one would echo the raw color-mix()/var() declaration.
    expect(maxHighlight).not.toContain("color-mix");
    expect(maxHighlight).not.toContain("var(");
    // Ultra's floating motes exist but stay dark outside ultra.
    const particles = slider.querySelector<HTMLElement>(".chat-controls__reasoning-particles")!;
    expect(particles.querySelectorAll(".chat-controls__reasoning-particle")).toHaveLength(7);
    expect(getComputedStyle(particles).opacity).toBe("0");
    const ultra = await fixture(["off", "low", "max", "ultra"], "ultra");
    await settledAppearance(ultra.input);
    const ultraLayers = sliderLayers(ultra.input);
    const ultraHighlight = getComputedStyle(ultraLayers.boost).getPropertyValue(
      "--reasoning-boost-highlight",
    );
    expect(ultraHighlight).not.toBe(maxHighlight);
    await expect
      .poll(
        () =>
          getComputedStyle(
            ultraLayers.slider.querySelector<HTMLElement>(".chat-controls__reasoning-particles")!,
          ).opacity,
      )
      .toBe("1");
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
