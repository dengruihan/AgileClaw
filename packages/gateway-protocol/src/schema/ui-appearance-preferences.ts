import { UI_APPEARANCE_TYPEFACE_VALUES } from "./ui-appearance-typefaces.js";

export type ThemeMode = "system" | "light" | "dark";

export function normalizeThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

export const UI_APPEARANCE_PREFERENCE_KEYS = {
  themeMode: "ui.themeMode",
  fontUi: "ui.fontUi",
  fontChat: "ui.fontChat",
} as const;

export type UiAppearancePreferenceKey =
  (typeof UI_APPEARANCE_PREFERENCE_KEYS)[keyof typeof UI_APPEARANCE_PREFERENCE_KEYS];

const UI_APPEARANCE_TYPEFACES = new Set<string>(UI_APPEARANCE_TYPEFACE_VALUES);

export function normalizeUiAppearancePreference(
  key: UiAppearancePreferenceKey,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontUi ||
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontChat
  ) {
    return UI_APPEARANCE_TYPEFACES.has(value) ? value : undefined;
  }
  return normalizeThemeMode(value);
}
