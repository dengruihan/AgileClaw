import { describe, expect, it } from "vitest";
import {
  isApplePlatform,
  matchesKeyboardShortcut,
  resolveAsciiShortcutKey,
} from "./keyboard-shortcuts.js";

function keyboardEvent(
  key: string,
  code: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    keyCode: number;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  return {
    key,
    code,
    keyCode: 0,
    isComposing: false,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("keyboard shortcut matching", () => {
  it("preserves native Unicode and physical-key fallbacks", () => {
    const match = (
      combo: Parameters<typeof matchesKeyboardShortcut>[0],
      event: ReturnType<typeof keyboardEvent>,
      applePlatform: boolean,
      asciiKey: string | null,
    ) => matchesKeyboardShortcut(combo, event, applePlatform, asciiKey);

    expect([
      isApplePlatform("MacIntel"),
      isApplePlatform("Linux"),
      resolveAsciiShortcutKey(keyboardEvent("K", "KeyQ")),
      resolveAsciiShortcutKey(keyboardEvent("л", "KeyK")),
      resolveAsciiShortcutKey(keyboardEvent("😀", "KeyA")),
      resolveAsciiShortcutKey(keyboardEvent("\uD800", "KeyB")),
      resolveAsciiShortcutKey(keyboardEvent("٢", "Digit2")),
      resolveAsciiShortcutKey(keyboardEvent("Dead", "KeyE")),
      match(
        { modifiers: ["mod"], key: "k", platformSpecific: true },
        keyboardEvent("k", "KeyK"),
        true,
        "k",
      ),
      match(
        { modifiers: ["mod", "alt"], key: "ß" },
        keyboardEvent("Dead", "KeySS", { altKey: true }),
        true,
        null,
      ),
      match(
        { modifiers: ["mod", "alt"], key: "ß" },
        keyboardEvent("∂", "KeySS", { altKey: true }),
        true,
        null,
      ),
      match({ modifiers: ["mod"], key: "/" }, keyboardEvent("ж", "Slash"), true, null),
      match({ modifiers: ["mod"], key: "/" }, keyboardEvent("-", "Slash"), true, null),
    ]).toEqual([true, false, "k", "k", "a", "b", "2", null, true, false, true, true, false]);
  });
});
