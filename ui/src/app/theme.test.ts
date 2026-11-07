// @vitest-environment node
// Control UI tests cover theme behavior.
import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves the single style in both explicit modes", () => {
    expect(resolveTheme("phosphor", "dark")).toBe("phosphor");
    expect(resolveTheme("phosphor", "light")).toBe("phosphor-light");
  });

  it("uses system preference when mode is system", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("phosphor", "system")).toBe("phosphor-light");
    vi.unstubAllGlobals();
  });

  it("falls back to dark when the system query is unavailable", () => {
    expect(resolveTheme("phosphor", "system")).toBe("phosphor");
  });
});

describe("parseThemeSelection", () => {
  it("normalizes every stored selection to the single style", () => {
    expect(parseThemeSelection("claw", "light")).toEqual({ theme: "phosphor", mode: "light" });
    expect(parseThemeSelection("dash", "dark")).toEqual({ theme: "phosphor", mode: "dark" });
    expect(parseThemeSelection(undefined, undefined)).toEqual({
      theme: "phosphor",
      mode: "system",
    });
  });

  it("falls back to the system mode for invalid stored modes", () => {
    expect(parseThemeSelection("phosphor", "invalid-mode")).toEqual({
      theme: "phosphor",
      mode: "system",
    });
  });
});
