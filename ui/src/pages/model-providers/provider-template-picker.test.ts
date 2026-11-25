/* @vitest-environment jsdom */

import { PROVIDER_TEMPLATES } from "@openclaw/model-catalog-core/provider-templates";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_ICON_IDS } from "../../components/provider-icon-ids.ts";
import {
  buildProviderTemplateSections,
  localizedTemplateName,
  renderProviderTemplatePicker,
  type ProviderTemplatePickerProps,
} from "./provider-template-picker.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function pickerProps(
  overrides: Partial<ProviderTemplatePickerProps> = {},
): ProviderTemplatePickerProps {
  return {
    open: true,
    sections: buildProviderTemplateSections({ locale: "en", occupied: new Map() }),
    disabled: false,
    blockedReason: null,
    onSelectTemplate: () => undefined,
    onOpenProvider: () => undefined,
    onCustomProvider: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

function mount(props: ProviderTemplatePickerProps): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  render(renderProviderTemplatePicker(props), container);
  return container;
}

function rowIds(sections: ReturnType<typeof buildProviderTemplateSections>, id: string) {
  return sections.find((section) => section.id === id)?.rows.map((row) => row.id);
}

describe("buildProviderTemplateSections", () => {
  it("keeps the group and row order declared by the template data", () => {
    const sections = buildProviderTemplateSections({ locale: "en", occupied: new Map() });

    expect(sections.map((section) => section.id)).toEqual(["zhipu", "other"]);
    expect(rowIds(sections, "zhipu")).toEqual(
      PROVIDER_TEMPLATES.filter((template) => template.group === "zhipu")
        .toSorted((left, right) => left.order - right.order)
        .map((template) => template.id),
    );
    expect(rowIds(sections, "other")).toHaveLength(
      PROVIDER_TEMPLATES.filter((template) => template.group === "other").length,
    );
  });

  it("localizes group and template names for the active locale", () => {
    const english = buildProviderTemplateSections({ locale: "en", occupied: new Map() });
    const chinese = buildProviderTemplateSections({ locale: "zh-CN", occupied: new Map() });

    expect(english.map((section) => section.label)).toEqual(["Zhipu", "Other"]);
    expect(chinese.map((section) => section.label)).toEqual(["智谱", "其他"]);
    expect(chinese.find((section) => section.id === "other")?.rows[0]?.label).toBe("Kimi");
  });

  it("falls back to the English name when a template has no zh-CN copy", () => {
    expect(localizedTemplateName({ en: "Kimi Code", zhCN: "  " }, "zh-CN")).toBe("Kimi Code");
    expect(localizedTemplateName({ en: "Kimi Code", zhCN: "Kimi 代码" }, "zh-CN")).toBe(
      "Kimi 代码",
    );
    expect(localizedTemplateName({ en: "Kimi Code", zhCN: "Kimi 代码" }, "en")).toBe("Kimi Code");
  });

  it("marks a template added only when its exact endpoint path is configured", () => {
    const sections = buildProviderTemplateSections({
      locale: "en",
      occupied: new Map([
        // Same host as the Coding Plan row, different API root.
        ["custom-open-bigmodel-cn", "https://open.bigmodel.cn/api/paas/v4"],
        // Mixed host case and a trailing slash still name the same endpoint.
        ["custom-api-deepseek-com", "https://API.DeepSeek.com/"],
      ]),
    });
    const rows = sections.flatMap((section) => section.rows);
    const added = Object.fromEntries(rows.map((row) => [row.id, row.addedProviderId]));

    expect(added["zhipu-api-cn"]).toBe("custom-open-bigmodel-cn");
    expect(added["zhipu-coding-cn"]).toBeUndefined();
    expect(added.deepseek).toBe("custom-api-deepseek-com");
    expect(added["kimi-cn"]).toBeUndefined();
  });
});

describe("renderProviderTemplatePicker", () => {
  it("renders the custom provider entry first, then grouped template rows", () => {
    const container = mount(pickerProps());
    const body = container.querySelector(".provider-template-picker__body")!;

    expect(body.firstElementChild?.hasAttribute("data-template-custom")).toBe(true);
    expect(
      [...container.querySelectorAll("[data-template-group]")].map((group) =>
        group.getAttribute("data-template-group"),
      ),
    ).toEqual(["zhipu", "other"]);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("[data-template-id]")].map((row) =>
        row.getAttribute("data-template-id"),
      ),
    ).toEqual(
      buildProviderTemplateSections({ locale: "en", occupied: new Map() }).flatMap((section) =>
        section.rows.map((row) => row.id),
      ),
    );
  });

  it("starts the custom provider flow from the fixed first entry", () => {
    const onCustomProvider = vi.fn();
    const container = mount(pickerProps({ onCustomProvider }));

    container.querySelector<HTMLButtonElement>("[data-template-custom]")!.click();

    expect(onCustomProvider).toHaveBeenCalledOnce();
  });

  it("selects a template by id and opens an added row's existing provider", () => {
    const onSelectTemplate = vi.fn();
    const onOpenProvider = vi.fn();
    const container = mount(
      pickerProps({
        sections: buildProviderTemplateSections({
          locale: "en",
          occupied: new Map([["custom-api-deepseek-com", "https://api.deepseek.com"]]),
        }),
        onSelectTemplate,
        onOpenProvider,
      }),
    );

    const added = container.querySelector<HTMLButtonElement>('[data-template-id="deepseek"]')!;
    expect(added.getAttribute("data-template-added")).toBe("true");
    expect(added.textContent).toContain("Added");
    added.click();

    expect(onOpenProvider).toHaveBeenCalledOnce();
    expect(onOpenProvider).toHaveBeenCalledWith("custom-api-deepseek-com");
    expect(onSelectTemplate).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('[data-template-id="kimi"]')!.click();
    expect(onSelectTemplate).toHaveBeenCalledExactlyOnceWith("kimi");
  });

  it("disables creating while the provider list is unknown but still opens added rows", () => {
    const onOpenProvider = vi.fn();
    const container = mount(
      pickerProps({
        sections: buildProviderTemplateSections({
          locale: "en",
          occupied: new Map([["custom-api-deepseek-com", "https://api.deepseek.com"]]),
        }),
        disabled: true,
        blockedReason: "The provider list has not loaded.",
        onOpenProvider,
      }),
    );

    expect(container.querySelector<HTMLButtonElement>("[data-template-custom]")!.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLButtonElement>('[data-template-id="kimi"]')!.disabled).toBe(
      true,
    );
    const added = container.querySelector<HTMLButtonElement>('[data-template-id="deepseek"]')!;
    expect(added.disabled).toBe(false);
    added.click();
    expect(onOpenProvider).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "The provider list has not loaded.",
    );
  });

  it("closes from the header button", () => {
    const onClose = vi.fn();
    const container = mount(pickerProps({ onClose }));

    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders nothing while closed", () => {
    const container = mount(pickerProps({ open: false }));

    expect(container.querySelector("[data-provider-template-picker]")).toBeNull();
  });
});

it("uses bundled provider icons for every template", () => {
  const icons = new Set<string>(PROVIDER_ICON_IDS);
  expect(PROVIDER_TEMPLATES.filter((template) => !icons.has(template.icon))).toEqual([]);
});
