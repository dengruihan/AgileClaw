/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { registerProviderIconConfigSource } from "../lib/provider-icon-source.ts";
import type { ProviderIconChoice } from "./provider-brand-rules.ts";
import { ProviderIconPicker } from "./provider-icon-picker.ts";

registerSettingsEnglish();

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mountPicker(
  options: {
    provider?: string;
    draft?: Record<string, unknown>;
    name?: string;
    editableName?: boolean;
    disabled?: boolean;
    onSelect?: (choice: ProviderIconChoice) => void;
  } = {},
): Promise<ProviderIconPicker> {
  const picker = document.createElement("openclaw-provider-icon-picker") as ProviderIconPicker;
  picker.provider = options.provider ?? "custom-relay";
  picker.draft = options.draft ?? {};
  picker.name = options.name ?? "";
  picker.editableName = options.editableName ?? true;
  picker.disabled = options.disabled ?? false;
  picker.onSelect = options.onSelect ?? (() => undefined);
  document.body.append(picker);
  await picker.updateComplete;
  return picker;
}

function triggerIcon(picker: ProviderIconPicker): string | null {
  return (
    picker
      .querySelector(".provider-icon-picker__trigger [data-provider-icon]")
      ?.getAttribute("data-provider-icon") ?? null
  );
}

function fallbackLetter(picker: ProviderIconPicker): string | null {
  return (
    picker
      .querySelector(".provider-icon-picker__trigger .provider-brand-icon--fallback")
      ?.textContent?.trim() ?? null
  );
}

function choice(picker: ProviderIconPicker, icon: string): HTMLButtonElement {
  const button = picker.querySelector<HTMLButtonElement>(`[data-provider-icon-choice="${icon}"]`);
  expect(button, icon).not.toBeNull();
  return button!;
}

function fixedChoice(picker: ProviderIconPicker, label: string): HTMLButtonElement {
  const button = [...picker.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(button, label).toBeDefined();
  return button!;
}

function search(picker: ProviderIconPicker, query: string): void {
  const input = picker.querySelector<HTMLInputElement>(".provider-icon-picker__search")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("provider icon picker", () => {
  it("offers every bundled icon with a label and marks the automatic choice", async () => {
    const picker = await mountPicker({
      provider: "custom-relay",
      draft: { displayName: "OpenAI", icon: "codex" },
      name: "OpenAI",
    });
    expect(picker.querySelectorAll("[data-provider-icon-choice]")).toHaveLength(80);
    expect(choice(picker, "mistral").getAttribute("aria-label")).toBe("Mistral AI");
    expect(choice(picker, "mistral").getAttribute("title")).toBe("Mistral AI");
    expect(fixedChoice(picker, "Automatic").getAttribute("aria-pressed")).toBe("true");
    expect(fixedChoice(picker, "No icon").getAttribute("aria-pressed")).toBe("false");
    expect(choice(picker, "codex").getAttribute("aria-pressed")).toBe("false");
    expect(triggerIcon(picker)).toBe("codex");
  });

  it("keeps the saved icon and exact-id mark for a committed name", async () => {
    // A saved provider with no stored icon still shows its provider-id brand
    // instead of the letter a name re-match would produce.
    onTestFinished(
      registerProviderIconConfigSource(() => ({
        models: { providers: { ollama: { displayName: "Home Server" } } },
      })),
    );
    const picker = await mountPicker({
      provider: "ollama",
      draft: { displayName: "Home Server" },
      name: "Home Server",
    });
    expect(triggerIcon(picker)).toBe("ollama");
  });

  it("previews the match of an uncommitted rename", async () => {
    const picker = await mountPicker({
      provider: "custom-relay",
      draft: { displayName: "Relay" },
      name: "Anthropic",
    });
    expect(triggerIcon(picker)).toBe("claude");
  });

  it("previews a manual icon and marks it selected", async () => {
    const picker = await mountPicker({
      draft: { displayName: "OpenAI", icon: "mistral", iconManual: true },
      name: "Anthropic",
    });
    expect(triggerIcon(picker)).toBe("mistral");
    expect(choice(picker, "mistral").getAttribute("aria-pressed")).toBe("true");
    expect(fixedChoice(picker, "Automatic").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the configured name's letter after a manual removal", async () => {
    const picker = await mountPicker({
      draft: { displayName: "Relay Cloud", iconManual: true },
      name: "Relay Cloud",
    });
    expect(triggerIcon(picker)).toBeNull();
    expect(fallbackLetter(picker)).toBe("R");
    expect(fixedChoice(picker, "No icon").getAttribute("aria-pressed")).toBe("true");
  });

  it("falls back to the provider id's bundled mark without an editable name", async () => {
    const picker = await mountPicker({
      provider: "anthropic",
      editableName: false,
      disabled: true,
    });
    expect(triggerIcon(picker)).toBe("claude");
  });

  it("emits the picked icon, automatic, and no-icon choices", async () => {
    const onSelect = vi.fn();
    const picker = await mountPicker({ draft: { displayName: "OpenAI" }, onSelect });
    choice(picker, "claude").click();
    fixedChoice(picker, "Automatic").click();
    fixedChoice(picker, "No icon").click();
    expect(onSelect.mock.calls.map(([selection]) => selection)).toEqual([
      { kind: "icon", icon: "claude" },
      { kind: "auto" },
      { kind: "none" },
    ]);
  });

  it("filters icons by name and icon id", async () => {
    const picker = await mountPicker();
    search(picker, "ollama");
    await picker.updateComplete;
    expect(picker.querySelectorAll("[data-provider-icon-choice]")).toHaveLength(1);
    expect(choice(picker, "ollama")).not.toBeNull();
    expect(fixedChoice(picker, "Automatic")).not.toBeNull();
    search(picker, "zzzz");
    await picker.updateComplete;
    expect(picker.querySelectorAll("[data-provider-icon-choice]")).toHaveLength(0);
    expect(picker.querySelector(".provider-icon-picker__empty")?.textContent?.trim()).toBe(
      "No icons match your search",
    );
  });

  it("disables the trigger and choices without rename permission", async () => {
    const onSelect = vi.fn();
    const picker = await mountPicker({
      draft: { displayName: "OpenAI" },
      disabled: true,
      onSelect,
    });
    expect(
      picker.querySelector<HTMLButtonElement>(".provider-icon-picker__trigger")!.disabled,
    ).toBe(true);
    choice(picker, "claude").click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(choice(picker, "claude").disabled).toBe(true);
  });

  it("moves through choices with arrow keys and closes on Escape", async () => {
    const picker = await mountPicker({ draft: { displayName: "OpenAI" } });
    const popover = picker.querySelector("wa-popover") as HTMLElement & { hide: () => void };
    const hide = vi.spyOn(popover, "hide");
    const automatic = fixedChoice(picker, "Automatic");
    const noIcon = fixedChoice(picker, "No icon");
    automatic.focus();
    automatic.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(noIcon);
    noIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(automatic);
    automatic.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(hide).toHaveBeenCalled();
  });

  it("leaves horizontal arrow keys to the search field", async () => {
    const picker = await mountPicker({ draft: { displayName: "OpenAI" } });
    const input = picker.querySelector<HTMLInputElement>(".provider-icon-picker__search")!;
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(input);
  });

  it("exposes the popover state on the trigger", async () => {
    const picker = await mountPicker({ draft: { displayName: "OpenAI", icon: "codex" } });
    const trigger = picker.querySelector(".provider-icon-picker__trigger")!;
    const popover = picker.querySelector("wa-popover")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    popover.dispatchEvent(new Event("wa-show"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    popover.dispatchEvent(new Event("wa-hide"));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
