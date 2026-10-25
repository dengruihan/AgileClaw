/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
import { card, mount, props, text } from "./view.test-support.ts";
import { renderModelProviders } from "./view.ts";

type SegmentedGroup = HTMLElement & { disabled: boolean; value: string };

it("offers only decision models, even without a chat provider, and retains an unavailable selection", async () => {
  const onDecisionChange = vi.fn();
  const container = document.createElement("div");
  const viewProps = props({
    configuredModels: [],
    decisionModels: [{ provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" }],
    defaultModels: {
      primary: "",
      fallbacks: [],
      utilityModel: null,
      decisionModel: "typesafe/retired",
    },
    onDecisionChange,
  });
  mount(viewProps, container);
  await updatePickers(container);
  const picker = container.querySelector<HTMLButtonElement>("#model-providers-decision-model")!;
  expect(picker.disabled).toBe(false);
  expect(picker.textContent).toContain("typesafe/retired");
  expect(
    container.querySelectorAll('[role="option"][data-value="typesafe/jev-latest"]'),
  ).toHaveLength(1);
  await choosePickerValue(picker, "typesafe/retired");
  expect(onDecisionChange).not.toHaveBeenCalled();
  await choosePickerValue(picker, "typesafe/jev-latest");
  expect(onDecisionChange).toHaveBeenLastCalledWith("typesafe/jev-latest");
  await choosePickerValue(picker, "");
  expect(onDecisionChange).toHaveBeenLastCalledWith(null);

  render(
    renderModelProviders({ ...viewProps, defaultsMutationBlockedReason: "Read only" }),
    container,
  );
  await updatePickers(container);
  expect(
    container.querySelector<HTMLButtonElement>("#model-providers-decision-model")!.disabled,
  ).toBe(true);
});

it("retains a saved unavailable model without offering it for another default setting", async () => {
  const onUtilityChange = vi.fn();
  const container = document.createElement("div");
  mount(
    props({
      configuredModels: [
        { provider: "fixture", id: "ready", name: "Ready", available: true },
        { provider: "fixture", id: "blocked", name: "Blocked", available: false },
      ],
      defaultModels: {
        primary: "fixture/ready",
        fallbacks: ["fixture/blocked"],
        utilityModel: "fixture/blocked",
      },
      onUtilityChange,
    }),
    container,
  );

  await updatePickers(container);
  const blocked = [...container.querySelectorAll('[role="option"][data-value="fixture/blocked"]')];
  expect(blocked).toHaveLength(3);
  expect(blocked.every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(
    [...container.querySelectorAll('[role="option"][data-value="fixture/ready"]')].every(
      (option) => option.getAttribute("aria-disabled") === "false",
    ),
  ).toBe(true);
  const utility = container.querySelector<HTMLButtonElement>("#model-providers-utility-model")!;
  expect(utility.textContent).toContain("Blocked");
  await choosePickerValue(utility, "fixture/blocked");
  expect(onUtilityChange).not.toHaveBeenCalled();
  await choosePickerValue(utility, "__openclaw_automatic_utility__");
  expect(onUtilityChange).toHaveBeenCalledExactlyOnceWith(null);
});

function button(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    text(entry).includes(label),
  );
}

function settingsRow(container: Element, label: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) =>
      text(
        candidate.querySelector(".model-providers__label-with-help > span:first-child") ??
          candidate.querySelector(".settings-row__title"),
      ) === label,
  );
  if (!match) {
    throw new Error(`Missing settings row: ${label}`);
  }
  return match;
}

function selectSegment(group: SegmentedGroup, value: string) {
  group.value = value;
  group.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("renderModelProviders", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps discovery failure recovery visible while another provider is pending", () => {
    const container = mount(
      props({ catalogDiscovering: true, catalogDiscoveryError: "A provider failed discovery." }),
    );
    expect(
      container.querySelector('.model-providers__catalog-progress[role="status"]'),
    ).not.toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(
      '.model-providers__catalog-progress[role="alert"] button',
    );
    expect(retry).not.toBeNull();
    expect(retry?.disabled).toBe(false);
  });

  it.each([
    { cards: [], providerQuery: "", sidebarAction: true },
    { cards: [card()], providerQuery: "", sidebarAction: false },
    { cards: [card()], providerQuery: "no-match", sidebarAction: false },
  ])(
    "keeps provider creation available with sidebar action: $sidebarAction, query: $providerQuery",
    ({ cards, providerQuery, sidebarAction }) => {
      const onCustomProvider = vi.fn();
      const container = mount(
        props({
          cards,
          providerQuery,
          configuredModels: [],
          unconfiguredProviders: [],
          onCustomProvider,
        }),
      );

      expect(container.querySelector("[data-available-provider]")).toBeNull();
      const sidebarButton = container.querySelector<HTMLButtonElement>(
        ".model-providers__navigation [data-custom-provider]",
      );
      expect(Boolean(sidebarButton)).toBe(sidebarAction);
      (sidebarButton ??
        container.querySelector<HTMLButtonElement>("[data-custom-provider]"))!.click();
      expect(onCustomProvider).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-model-readiness="model-required"]')).toBeNull();
    },
  );

  it("shows inherited model policy, restores overrides, and preserves advanced thinking", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = mount(
      props({
        thinkingLevel: "adaptive",
        fastMode: true,
        onThinkingReset,
        onFastModeReset,
      }),
    );
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinkingRow = settingsRow(behavior, "Thinking");
    const fastRow = settingsRow(behavior, "Fast Mode");

    expect(thinkingRow.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("adaptive");
    expect(text(thinkingRow)).toContain("Adaptive");
    expect(text(thinkingRow)).not.toContain("Default: Model policy");
    expect(text(fastRow)).not.toContain("Default: Model policy");
    const thinkingHelp = thinkingRow.querySelector('openclaw-tooltip [slot="content"]');
    const fastModeHelp = fastRow.querySelector('openclaw-tooltip [slot="content"]');
    expect(thinkingHelp?.textContent).toContain("model's thinking policy");
    expect(fastModeHelp?.textContent).toContain("Unlike Auto");
    expect(thinkingRow.querySelector("wa-radio button")).toBeNull();
    expect(fastRow.querySelector("wa-radio button")).toBeNull();
    expect(thinkingRow.querySelector('wa-radio[value=""]')?.hasAttribute("title")).toBe(false);
    expect(fastRow.querySelector('wa-radio[value=""]')?.hasAttribute("title")).toBe(false);

    selectSegment(thinkingRow.querySelector<SegmentedGroup>("wa-radio-group")!, "");
    selectSegment(fastRow.querySelector<SegmentedGroup>("wa-radio-group")!, "");
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();

    render(
      renderModelProviders(
        props({
          thinkingLevel: undefined,
          thinkingOverridden: false,
          fastMode: undefined,
          fastModeOverridden: false,
        }),
      ),
      container,
    );
    const inheritedBehavior = container.querySelector("#settings-model-behavior")!;
    const inheritedThinking = settingsRow(inheritedBehavior, "Thinking");
    const inheritedFast = settingsRow(inheritedBehavior, "Fast Mode");
    expect(inheritedThinking.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("");
    expect(inheritedFast.querySelector<SegmentedGroup>("wa-radio-group")?.value).toBe("");
    expect(
      (
        inheritedThinking.querySelector('wa-radio[value=""]') as HTMLElement & {
          checked: boolean;
        }
      ).checked,
    ).toBe(true);
    expect(
      (inheritedFast.querySelector('wa-radio[value=""]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
    expect(text(inheritedThinking)).not.toContain("Using default: Model policy");
    expect(text(inheritedFast)).not.toContain("Using default: Model policy");
    expect(
      inheritedBehavior.querySelectorAll('button[aria-label="Reset to default"]'),
    ).toHaveLength(0);
  });

  it("keeps invalid explicit model behavior values resettable", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = mount(
      props({
        thinkingLevel: undefined,
        thinkingOverridden: true,
        fastMode: undefined,
        fastModeOverridden: true,
        onThinkingReset,
        onFastModeReset,
      }),
    );
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinking = settingsRow(behavior, "Thinking");
    const fast = settingsRow(behavior, "Fast Mode");

    thinking.querySelector<HTMLElement>('wa-radio[value=""]')?.click();
    fast.querySelector<HTMLElement>('wa-radio[value=""]')?.click();
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();
  });

  it("restores controlled model behavior when a reset is rejected", () => {
    const viewProps = props({
      thinkingLevel: "high",
      fastMode: true,
    });
    const container = mount(viewProps);
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinking = settingsRow(behavior, "Thinking").querySelector<SegmentedGroup>(
      "wa-radio-group",
    )!;
    const fastMode = settingsRow(behavior, "Fast Mode").querySelector<SegmentedGroup>(
      "wa-radio-group",
    )!;

    selectSegment(thinking, "");
    selectSegment(fastMode, "");
    render(renderModelProviders(viewProps), container);

    expect(thinking.value).toBe("high");
    expect(fastMode.value).toBe("on");
    expect(
      (thinking.querySelector('wa-radio[value="high"]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
    expect(
      (fastMode.querySelector('wa-radio[value="on"]') as HTMLElement & { checked: boolean })
        .checked,
    ).toBe(true);
  });

  it("locks model behavior while shared config work is pending", () => {
    const container = mount(props({ configBusy: true }));
    const behavior = container.querySelector("#settings-model-behavior");
    const groups = behavior?.querySelectorAll<SegmentedGroup>("wa-radio-group") ?? [];

    expect(groups).toHaveLength(2);
    expect([...groups].every((group) => group.disabled)).toBe(true);
  });

  it("locks provider and default-model mutations while shared config work is pending", async () => {
    const onPrimaryChange = vi.fn();
    const container = mount(
      props({
        configBusy: true,
        onPrimaryChange,
        defaultModels: {
          primary: "openai/gpt-5",
          fallbacks: ["anthropic/claude"],
          utilityModel: null,
        },
        configuredModels: [
          { id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true },
          { id: "anthropic/claude", provider: "anthropic", name: "Claude", available: true },
        ],
        cards: [
          card({
            hasConfigApiKey: true,
            apiKey: { source: "config" },
            profiles: [
              { profileId: "openai:one", type: "oauth", status: "ok", logoutSupported: true },
            ],
          }),
        ],
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
      }),
    );

    const defaults = container.querySelector(".model-providers__defaults");
    await updatePickers(container);
    const primary = settingsRow(defaults!, "Model").querySelector<HTMLButtonElement>("button")!;
    expect(primary.disabled).toBe(false);
    await choosePickerValue(primary, "anthropic/claude");
    expect(onPrimaryChange).not.toHaveBeenCalled();
    expect(
      [...settingsRow(defaults!, "Model").querySelectorAll('[role="option"]')].every(
        (option) => option.getAttribute("aria-disabled") === "true",
      ),
    ).toBe(true);
    expect(
      [
        ...(defaults?.querySelectorAll<HTMLButtonElement>(
          ".model-providers__fallback-row button",
        ) ?? []),
      ].every((control) => control.disabled),
    ).toBe(true);
    expect(button(defaults!, "Save")).toBeUndefined();

    const addForm = container.querySelector("[data-models-key-dialog]");
    expect(
      [
        ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
          "select, input, button",
        ) ?? []),
      ].map((control) => control.disabled),
    ).toEqual([true, false, true]);
  });

  it("locks an already-open provider form after mutation access is revoked", async () => {
    const onAddProvider = vi.fn();
    const onAddProviderToggle = vi.fn();
    const container = mount(
      props({
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
        canMutate: false,
        mutationBlockedReason: "Operator admin access required",
        defaultsMutationBlockedReason: "Operator admin access required",
        messages: {
          defaults: {
            kind: "error",
            text: "Configuration changes require operator.admin access.",
          },
        },
        onAddProvider,
        onAddProviderToggle,
      }),
    );
    const addForm = container.querySelector("[data-models-key-dialog]");
    const controls = [
      ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "select, input, button",
      ) ?? []),
    ];

    expect(controls.map((control) => control.disabled)).toEqual([true, false, true]);
    const defaults = container.querySelector(".model-providers__defaults");
    await updatePickers(container);
    const primary = settingsRow(defaults!, "Model").querySelector<HTMLButtonElement>("button")!;
    expect(primary.disabled).toBe(false);
    expect(
      [...settingsRow(defaults!, "Model").querySelectorAll('[role="option"]')].every(
        (option) => option.getAttribute("aria-disabled") === "true",
      ),
    ).toBe(true);
    expect(text(defaults)).not.toContain("operator.admin access");
    button(addForm!, "Save provider")?.click();
    expect(onAddProvider).not.toHaveBeenCalled();

    const cancel = button(addForm!, "Cancel");
    expect(cancel?.disabled).toBe(false);
    cancel?.click();
    expect(onAddProviderToggle).toHaveBeenCalledOnce();
  });

  it("freezes provider and credential fields while adding a provider", () => {
    const container = mount(
      props({
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
        busy: { add: true },
      }),
    );
    const addForm = container.querySelector("[data-models-key-dialog]");

    expect(
      [
        ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input") ?? []),
      ].map((control) => control.disabled),
    ).toEqual([true]);
  });

  it("keeps committed default-model success visible beside its refresh warning", () => {
    const container = mount(
      props({
        messages: {
          defaults: {
            kind: "success",
            text: "Default models saved.",
            warning: "Config refresh failed after the model defaults were committed.",
          },
        },
      }),
    );
    const defaults = container.querySelector(".model-providers__defaults");
    const messages = [...(defaults?.querySelectorAll('[role="status"]') ?? [])];

    expect(messages.map((message) => text(message))).toEqual([
      "Default models saved.",
      "Config refresh failed after the model defaults were committed.",
    ]);
    expect(messages[0]?.classList.contains("success")).toBe(true);
    expect(messages[1]?.classList.contains("warning")).toBe(true);
  });

  it("announces provider and default-model mutation failures as accessible alerts", () => {
    const container = mount(
      props({
        messages: {
          openai: { kind: "error", text: "Provider credential could not be saved." },
          defaults: { kind: "error", text: "Default models could not be saved." },
        },
      }),
    );

    expect(text(container.querySelector('[data-provider-details="openai"] [role="alert"]'))).toBe(
      "Provider credential could not be saved.",
    );
    expect(text(container.querySelector('.model-providers__defaults [role="alert"]'))).toBe(
      "Default models could not be saved.",
    );
  });

  it("keeps model behavior available while provider data loads", () => {
    const container = mount(props({ loading: true, thinkingLevel: "high", fastMode: true }));
    const behavior = container.querySelector("#settings-model-behavior");

    expect(behavior).not.toBeNull();
    expect(
      settingsRow(behavior!, "Thinking").querySelector<SegmentedGroup>("wa-radio-group")?.value,
    ).toBe("high");
    expect(
      settingsRow(behavior!, "Fast Mode").querySelector<SegmentedGroup>("wa-radio-group")?.value,
    ).toBe("on");
    expect(text(container)).not.toContain("Configure a provider before selecting default models.");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-provider-id="openai"]')).toBeNull();
  });

  it.each([false, true])(
    "does not present catalog-rejected credentials as signed in (configured key: %s)",
    (hasConfigApiKey) => {
      const container = mount(
        props({
          cards: [
            card({
              auth: { kind: "ok" },
              profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
              hasConfigApiKey,
              catalogStatus: "auth-rejected",
              modelCount: 0,
              availableModelCount: 0,
            }),
          ],
          configuredModels: [],
          defaultModels: { primary: "", fallbacks: [], utilityModel: null },
        }),
      );

      const provider = container.querySelector('[data-provider-select="openai"]');
      expect(text(provider)).toContain("Credentials rejected");
      expect(text(provider)).not.toContain("Signed in");
    },
  );

  it("does not report an unverified API key as ready", () => {
    const container = mount(
      props({
        cards: [
          card({
            auth: { kind: "api-key" },
          }),
        ],
      }),
    );

    const provider = container.querySelector('[data-provider-select="openai"]');
    expect(text(provider)).toContain("Credentials configured");
    expect(text(provider)).not.toContain("Ready");
  });

  it("qualifies slash-bearing model IDs with their catalog provider", async () => {
    const container = mount(
      props({
        configuredModels: [
          {
            id: "anthropic/claude-sonnet-4",
            provider: "openrouter",
            name: "Claude Sonnet 4",
            available: true,
          },
        ],
        defaultModels: {
          primary: "openrouter/anthropic/claude-sonnet-4",
          fallbacks: [],
          utilityModel: null,
        },
      }),
    );
    await updatePickers(container);
    const option = container.querySelector(
      '[role="option"][data-value="openrouter/anthropic/claude-sonnet-4"]',
    );
    expect(option?.getAttribute("aria-selected") === "true").toBe(true);
  });

  it.each([undefined, null])(
    "renders alias defaults and distinct automatic or disabled utility states (%s)",
    async (automaticUtilityModel) => {
      const aliasEntry = {
        id: "claude-opus",
        provider: "anthropic",
        name: "Claude Opus",
        available: true,
        selectionRef: "opus",
      };
      const automatic = mount(
        props({
          configuredModels: [aliasEntry],
          defaultModels: { primary: "opus", fallbacks: [], utilityModel: null },
          automaticUtilityModel,
        }),
      );
      await updatePickers(automatic);
      expect(
        automatic
          .querySelector('[role="option"][data-value="opus"]')
          ?.getAttribute("aria-selected") === "true",
      ).toBe(true);
      expect(
        text(
          automatic
            .querySelectorAll(".model-providers__defaults openclaw-select-picker")[1]
            ?.querySelector('[role="option"][aria-selected="true"]') ?? null,
        ),
      ).toBe(automaticUtilityModel === null ? "Auto No recommended small model" : "Auto");

      const disabled = mount(
        props({
          configuredModels: [aliasEntry],
          defaultModels: { primary: "opus", fallbacks: [], utilityModel: "" },
        }),
      );
      await updatePickers(disabled);
      expect(
        text(
          disabled
            .querySelectorAll(".model-providers__defaults openclaw-select-picker")[1]
            ?.querySelector('[role="option"][aria-selected="true"]') ?? null,
        ),
      ).toBe("Disabled");
    },
  );

  function utilityOption(container: HTMLElement, value: string) {
    const option = container
      .querySelectorAll(".model-providers__defaults openclaw-select-picker")[1]
      ?.querySelector(`[role="option"][data-value="${value}"]`);
    return {
      label: text(option?.querySelector(".picker-select__label") ?? null),
      detail: text(option?.querySelector(".picker-select__description") ?? null),
    };
  }
  const utilityModels = [
    { id: "claude-opus", provider: "anthropic", name: "Claude Opus", available: true },
    { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", available: true },
  ];

  it.each([
    [
      { id: "claude-cli", kind: "cli", label: "Claude CLI" },
      "Claude CLI · native",
      "Runs through Claude CLI using its own login.",
    ],
    [
      { id: "openclaw", kind: "api", label: "OpenClaw Default" },
      "API · OpenClaw",
      "Uses the provider's API connection",
    ],
  ] as const)(
    "shows the automatic utility model's route in its detail line (%o)",
    async (runtime, route, billing) => {
      const container = mount(
        props({
          configuredModels: utilityModels,
          defaultModels: { primary: "anthropic/claude-opus", fallbacks: [], utilityModel: null },
          automaticUtilityModel: "anthropic/claude-haiku-4-5",
          utilityRuntime: runtime,
        }),
      );
      await updatePickers(container);
      const automatic = utilityOption(container, "__openclaw_automatic_utility__");
      expect(automatic.label).toBe("Auto · Claude Haiku 4.5");
      expect(automatic.detail).toContain(route);
      const trigger = container
        .querySelectorAll(".model-providers__defaults openclaw-select-picker")[1]
        ?.querySelector<HTMLButtonElement>("button[aria-haspopup]");
      expect(trigger?.title).toContain(billing);
    },
  );

  it("shows the route on an explicitly chosen utility model, not on Auto", async () => {
    const container = mount(
      props({
        configuredModels: utilityModels,
        defaultModels: {
          primary: "anthropic/claude-opus",
          fallbacks: [],
          utilityModel: "anthropic/claude-haiku-4-5",
        },
        automaticUtilityModel: "anthropic/claude-haiku-4-5",
        utilityRuntime: { id: "claude-cli", kind: "cli", label: "Claude CLI" },
      }),
    );
    await updatePickers(container);
    const chosen = utilityOption(container, "anthropic/claude-haiku-4-5");
    expect(chosen.label).toBe("Claude Haiku 4.5");
    expect(chosen.detail).toContain("Claude CLI · native");
    expect(utilityOption(container, "__openclaw_automatic_utility__").detail).not.toContain(
      "Claude CLI",
    );
  });

  it("offers provider deletion only for deletable cards and forwards the card", () => {
    const onDeleteProvider = vi.fn();
    const onProviderSettings = vi.fn();
    const deletable = card({ id: "custom.proxy", displayName: "Custom Proxy" });
    const viewProps = props({
      cards: [deletable, card()],
      onDeleteProvider,
      onProviderSettings,
      canDeleteProvider: (entry) => entry.id === "custom.proxy",
    });
    const container = mount(viewProps);
    const custom = container.querySelector('[data-provider-details="custom.proxy"]');
    expect(button(custom!, "Delete provider")).toBeDefined();
    button(custom!, "Delete provider")!.click();
    expect(onDeleteProvider).toHaveBeenCalledWith(deletable);
    container.querySelector<HTMLButtonElement>('[data-provider-select="openai"]')!.click();
    expect(onProviderSettings).toHaveBeenCalledWith(viewProps.cards[1]);
    render(renderModelProviders({ ...viewProps, selectedProvider: "openai" }), container);
    expect(container.querySelector('[data-provider-details="custom.proxy"]')).toBeNull();
    expect(
      button(container.querySelector('[data-provider-details="openai"]')!, "Delete provider"),
    ).toBeUndefined();

    const busy = mount(
      props({
        cards: [deletable],
        canDeleteProvider: () => true,
        busy: { "delete:custom.proxy": true },
      }),
    );
    expect(
      button(busy.querySelector('[data-provider-details="custom.proxy"]')!, "Delete provider")!
        .disabled,
    ).toBe(true);
  });

  it("shows the current key-operation failure over an older card success", () => {
    const container = mount(
      props({
        messages: {
          openai: { kind: "success", text: "Older success" },
          "key:openai": { kind: "error", text: "Current failure" },
        },
      }),
    );
    expect(text(container.querySelector('[data-provider-details="openai"] .callout'))).toBe(
      "Current failure",
    );
  });
});

it.each([" ANTHROPIC ", "claude-cli"])(
  "filters provider access by name or credential alias (%s) without hiding defaults",
  (providerQuery) => {
    const onProviderQueryChange = vi.fn();
    const viewProps = props({
      cards: [
        card(),
        card({
          id: "anthropic",
          displayName: "Anthropic",
          credentialProviderIds: ["anthropic", "claude-cli"],
        }),
      ],
      providerQuery,
      onProviderQueryChange,
    });
    const container = mount(viewProps);
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(1);
    expect(container.querySelector('[data-provider-id="anthropic"]')).not.toBeNull();
    expect(container.querySelector("#settings-model-behavior")).not.toBeNull();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "missing";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onProviderQueryChange).toHaveBeenCalledExactlyOnceWith("missing");
    render(renderModelProviders({ ...viewProps, providerQuery: "missing" }), container);
    expect(text(container)).toContain("No providers match your search.");
    expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(0);
    expect(container.querySelector("#settings-model-behavior")).not.toBeNull();
  },
);
