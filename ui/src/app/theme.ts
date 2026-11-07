import {
  normalizeThemeMode,
  type ThemeMode,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";

/** The single UI style. Themes as a selectable palette family are retired. */
export type ThemeName = "phosphor";
export type ResolvedTheme = "phosphor" | "phosphor-light";
export type { ThemeMode };

export function parseThemeSelection(
  _themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  // Any stored selection — including retired theme ids and imported palettes —
  // normalizes to the single style at read time instead of carrying a compat path.
  return { theme: "phosphor", mode: normalizeThemeMode(modeRaw) ?? "system" };
}

export function resolveTheme(_theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  let resolvedMode = mode;
  if (resolvedMode === "system") {
    resolvedMode =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  }
  return resolvedMode === "light" ? "phosphor-light" : "phosphor";
}
