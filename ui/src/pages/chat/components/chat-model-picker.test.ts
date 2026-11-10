/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import type { ChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";
import { renderChatModelPicker } from "./chat-model-picker.ts";

// The merged picker always carries a thinking state; an empty option list keeps
// the effort section out of these model-list assertions.
const thinkingWithoutOptions: ChatThinkingSelectState = {
  selection: { source: "default", value: "medium", displayLabel: "Medium", kind: "unanchored" },
  inherited: { value: "medium", displayLabel: "Medium" },
  options: [],
};

function orderedOptions(count: number, defaultIndex?: number): ChatModelPickerOption[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "fixture",
    value: `fixture/model-${index}`,
    commitValue: index === defaultIndex ? "" : `fixture/model-${index}`,
    label: `Model ${index}`,
    isDefault: index === defaultIndex,
  }));
}

function mount(
  container: HTMLElement,
  modelOptions: ChatModelPickerOption[],
  selectedModelValue: string,
) {
  render(
    renderChatModelPicker({
      disabled: false,
      modelSelectionLocked: false,
      modelOptions,
      selectedModelValue,
      sessionModelPinned: true,
      sessionKey: "main",
      triggerModelLabel: selectedModelValue,
      thinking: thinkingWithoutOptions,
      thinkingDisabled: false,
      onModelSelect: vi.fn(async () => {}),
      onThinkingSelect: vi.fn(async () => {}),
    }),
    container,
  );
}

function renderedValues(container: HTMLElement): Array<string | null> {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-chat-model-option]"),
    (row) => row.dataset.chatModelOption ?? null,
  );
}

function configuredValues(options: ChatModelPickerOption[]): string[] {
  return options.map((option) => option.value);
}

it("renders a selected late model in its configured slot", () => {
  const container = document.createElement("div");
  const options = orderedOptions(300);
  mount(container, options, "fixture/model-299");
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
  expect(renderedValues(container)).toEqual(configuredValues(options));
  expect(rows[299]?.getAttribute("aria-selected")).toBe("true");
  expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
  expect(rows[299]?.dataset.chatModelIndex).toBe("299");
});

it("keeps the Default row in its configured slot", () => {
  const container = document.createElement("div");
  const options = orderedOptions(300, 150);
  mount(container, options, "fixture/model-299");
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
  expect(renderedValues(container)).toEqual(configuredValues(options));
  expect(rows[150]?.dataset.chatModelDefault).toBe("true");
  expect(rows[150]?.getAttribute("aria-selected")).toBe("false");
  expect(rows[299]?.getAttribute("aria-selected")).toBe("true");
});

it("keeps the configured order while the selection changes", () => {
  const container = document.createElement("div");
  const options = orderedOptions(8, 3);
  mount(container, options, "fixture/model-1");
  const before = renderedValues(container);
  mount(container, options, "fixture/model-6");
  expect(renderedValues(container)).toEqual(before);
  expect(
    container
      .querySelector<HTMLElement>('[data-chat-model-option="fixture/model-6"]')
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    container
      .querySelector<HTMLElement>('[data-chat-model-option="fixture/model-1"]')
      ?.getAttribute("aria-selected"),
  ).toBe("false");
});

it("groups providers in authored order without ranking the selection", () => {
  const container = document.createElement("div");
  const options: ChatModelPickerOption[] = [
    {
      provider: "openai",
      value: "openai/first",
      commitValue: "openai/first",
      label: "First",
      isDefault: false,
    },
    {
      provider: "fixture",
      value: "fixture/second",
      commitValue: "fixture/second",
      label: "Second",
      isDefault: false,
    },
    {
      provider: "openai",
      value: "openai/third",
      commitValue: "openai/third",
      label: "Third",
      isDefault: false,
    },
    {
      provider: "fixture",
      value: "fixture/fourth",
      commitValue: "fixture/fourth",
      label: "Fourth",
      isDefault: false,
    },
  ];
  mount(container, options, "openai/third");
  expect(renderedValues(container)).toEqual(["openai/first", "openai/third"]);
  expect(
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-model-provider-option]"),
      (row) => row.dataset.chatModelProviderOption ?? null,
    ),
  ).toEqual(["openai", "fixture"]);
  expect(
    container
      .querySelector<HTMLElement>('[data-chat-model-option="openai/third"]')
      ?.getAttribute("aria-selected"),
  ).toBe("true");
});
