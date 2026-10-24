/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { configRouteData } from "../config/route-data.ts";
import {
  appendPage,
  createEmptyModelProvidersRouteData,
  createHarness,
} from "./model-providers-page.test-support.ts";
import "./provider-manager.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

type DialogTestConfig = {
  providers: Record<string, Record<string, unknown>>;
  catalog: Record<string, unknown>[];
};

type DialogPatchParams = { baseHash?: string; raw?: string; replacePaths?: string[] };

/** Test-local merge-patch application honoring replaced array paths. */
function applyPatch(
  target: Record<string, unknown>,
  raw: unknown,
  replaced: Set<string>,
  path = "",
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (replaced.has(childPath) || !value || typeof value !== "object" || Array.isArray(value)) {
      target[key] = value;
    } else {
      const nested = target[key];
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        target[key] = {};
      }
      applyPatch(target[key] as Record<string, unknown>, value, replaced, childPath);
    }
  }
}

/**
 * Opens the merged provider dialog for `provider` over a mutable config so
 * tests can drive the real form and capture the config.patch payloads.
 */
async function openDialog(config: DialogTestConfig, provider: string) {
  const harness = createHarness("main");
  const originalRequest = harness.request.getMockImplementation()!;
  const current: Record<string, unknown> = {
    agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } },
    models: { providers: structuredClone(config.providers) },
  };
  const patches: DialogPatchParams[] = [];
  harness.request.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return { config: current, hash: "dialog-hash", valid: true };
    }
    if (method === "config.patch") {
      const patch = params as DialogPatchParams;
      patches.push(patch);
      applyPatch(current, JSON.parse(patch.raw ?? "{}"), new Set(patch.replacePaths ?? []));
      return { config: current, hash: `patched-${patches.length}` };
    }
    if (method === "models.list") {
      return { models: config.catalog };
    }
    return originalRequest(method);
  });
  const page = appendPage(harness.context);
  harness.runtimeConfig.state.configForm = structuredClone(current);
  const search = `?section=models&subsection=providers&provider=${provider}&view=models`;
  page.routeData = {
    ...createEmptyModelProvidersRouteData(harness.context),
    provider,
    catalogConfig: configRouteData({ pathname: "/settings/models", search, hash: "" }),
  };
  harness.notifyRuntimeConfig();
  const manager = await waitForFast(() => {
    const dialog = page.querySelector("openclaw-provider-manager");
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector(".provider-manager__models-section")).not.toBeNull();
    return dialog!;
  });
  const input = (name: string) => manager.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const setInput = (name: string, value: string) => {
    input(name).value = value;
    input(name).dispatchEvent(new Event("input", { bubbles: true }));
  };
  const save = async () => {
    const previous = patches.length;
    manager
      .querySelector<HTMLButtonElement>('.provider-manager__footer button[type="submit"]')!
      .click();
    await waitForFast(() => expect(patches.length).toBeGreaterThan(previous));
    // The write settles asynchronously; the edit form closing marks the saved
    // return to the merged view.
    await waitForFast(() => expect(manager.querySelector(".provider-manager--model")).toBeNull());
    await page.updateComplete;
  };
  return { harness, manager, input, setInput, save, patches, page };
}

function editButton(manager: Element, modelId: string): HTMLButtonElement {
  const button = [
    ...manager
      .querySelector(`[data-model-id="${modelId}"]`)!
      .querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === "Edit model");
  expect(button).toBeDefined();
  return button!;
}

describe("provider manager dialog forms", () => {
  it("clears an API override when selecting the provider default", async () => {
    const { manager, save, patches } = await openDialog(
      {
        providers: { openai: { api: "openai-responses", models: [] } },
        catalog: [],
      },
      "openai",
    );
    const api = manager.querySelector<HTMLSelectElement>('select[name="api"]')!;
    api.value = "";
    api.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() =>
      expect(
        manager.querySelector<HTMLButtonElement>('.provider-manager__footer button[type="submit"]')!
          .disabled,
      ).toBe(false),
    );
    await save();
    expect(JSON.parse(String(patches.at(-1)!.raw))).toEqual({
      models: { providers: { openai: { api: null } } },
    });
  });

  it("preserves authored tiered pricing when renaming a model", async () => {
    const cost = {
      tieredPricing: [{ input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5, range: [0] }],
    };
    const { manager, setInput, save, patches } = await openDialog(
      {
        providers: {
          "custom-lab": {
            baseUrl: "https://example.test/v1",
            models: [{ id: "tiered", name: "Tiered", cost }],
          },
        },
        catalog: [],
      },
      "custom-lab",
    );
    editButton(manager, "tiered").click();
    await waitForFast(() => expect(manager.querySelector('input[name="name"]')).not.toBeNull());
    setInput("name", "Renamed");
    await save();
    expect(JSON.parse(String(patches.at(-1)!.raw))).toMatchObject({
      models: {
        providers: {
          "custom-lab": { models: [{ id: "tiered", name: "Renamed", cost }] },
        },
      },
    });
  });

  it("normalizes an edited model: coerces numbers, drops blanked overrides, keeps hidden fields", async () => {
    const { manager, setInput, save, patches } = await openDialog(
      {
        providers: {
          "custom-lab": {
            baseUrl: "https://example.test/v1",
            models: [
              {
                id: "model-1",
                name: "One",
                contextWindow: 128000,
                input: ["text"],
                compat: { supportsTemperature: false },
                cost: { input: 3, output: 5 },
              },
            ],
          },
        },
        catalog: [],
      },
      "custom-lab",
    );
    editButton(manager, "model-1").click();
    await waitForFast(() => expect(manager.querySelector('input[name="name"]')).not.toBeNull());
    setInput("name", "Renamed");
    // Clearing a number field removes the override instead of writing a blank.
    setInput("contextWindow", "");
    // Typed numbers must land in config as numbers, not input strings.
    setInput("maxTokens", "4096");
    // Zero is a valid free-model rate and must survive the save.
    setInput("cost-input", "0");
    await save();
    const patch = patches.at(-1)!;
    expect(JSON.parse(String(patch.raw))).toEqual({
      models: {
        providers: {
          "custom-lab": {
            models: [
              {
                id: "model-1",
                name: "Renamed",
                input: ["text"],
                maxTokens: 4096,
                compat: { supportsTemperature: false },
                cost: { input: 0, output: 5 },
              },
            ],
          },
        },
      },
    });
    expect(patch.replacePaths).toHaveLength(1);
  });

  it("keeps catalog reasoning inherited until the form overrides it", async () => {
    // A catalog-advertised model edited from its bare authored entry: saving
    // without touching reasoning must not freeze the capability into config.
    const { manager, save, patches, input, setInput, page } = await openDialog(
      {
        providers: {
          "custom-lab": {
            baseUrl: "https://example.test/v1",
            models: [
              { id: "kept", name: "Kept", reasoning: true },
              { id: "discovered", name: "Discovered" },
            ],
          },
        },
        catalog: [
          {
            id: "discovered",
            name: "Discovered",
            provider: "custom-lab",
            reasoning: true,
            input: ["text", "image"],
          },
        ],
      },
      "custom-lab",
    );
    editButton(manager, "discovered").click();
    await waitForFast(() => expect(input("id")).not.toBeNull());
    expect(input("id").disabled).toBe(true);
    expect(input("input-image").checked).toBe(true);
    await save();
    expect(JSON.parse(String(patches.at(-1)!.raw))).toEqual({
      models: {
        providers: {
          "custom-lab": {
            models: [
              { id: "kept", name: "Kept", reasoning: true },
              { id: "discovered", name: "Discovered" },
            ],
          },
        },
      },
    });
    // Unchecking an authored reasoning override writes an explicit false.
    editButton(manager, "kept").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    manager.querySelector<HTMLInputElement>('input[name="reasoning"]')!.checked = false;
    manager
      .querySelector<HTMLInputElement>('input[name="reasoning"]')!
      .dispatchEvent(new Event("change", { bubbles: true }));
    await save();
    const savedKept = JSON.parse(String(patches.at(-1)!.raw)).models.providers["custom-lab"]
      .models as Record<string, unknown>[];
    expect(savedKept.find((row) => row.id === "kept")).toMatchObject({
      id: "kept",
      reasoning: false,
    });
    // Toggling reasoning off on a bare catalog-matched entry saves an explicit
    // false override instead of falling back to the advertised capability.
    editButton(manager, "discovered").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    const reasoning = manager.querySelector<HTMLInputElement>('input[name="reasoning"]')!;
    for (const checked of [true, false]) {
      reasoning.checked = checked;
      reasoning.dispatchEvent(new Event("change", { bubbles: true }));
      await page.updateComplete;
    }
    await save();
    const savedDiscovered = JSON.parse(String(patches.at(-1)!.raw)).models.providers["custom-lab"]
      .models as Record<string, unknown>[];
    expect(savedDiscovered.find((row) => row.id === "discovered")).toMatchObject({
      id: "discovered",
      reasoning: false,
    });
    // An authored explicit false survives an unrelated edit instead of
    // silently re-enabling the catalog capability.
    editButton(manager, "kept").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    setInput("name", "Kept renamed");
    await save();
    const renamed = JSON.parse(String(patches.at(-1)!.raw)).models.providers["custom-lab"]
      .models as Record<string, unknown>[];
    expect(renamed.find((row) => row.id === "kept")).toMatchObject({
      id: "kept",
      name: "Kept renamed",
      reasoning: false,
    });
  });

  it("builds thinking levels from an empty add-based list and passes values through", async () => {
    const { manager, save, patches, input, setInput } = await openDialog(
      {
        providers: {
          "custom-lab": {
            baseUrl: "https://example.test/v1",
            models: [
              { id: "authored", name: "Authored", thinkingLevelMap: { high: "auth-high" } },
              { id: "renamed-only", name: "Renamed Only" },
              { id: "discovered", name: "Discovered" },
              { id: "quiet", name: "Quiet" },
            ],
          },
        },
        catalog: [
          {
            id: "discovered",
            name: "Discovered",
            provider: "custom-lab",
            thinkingLevels: [
              { id: "low", label: "low" },
              { id: "high", label: "high" },
            ],
          },
          {
            id: "quiet",
            name: "Quiet",
            provider: "custom-lab",
            thinkingLevels: [{ id: "low", label: "low" }],
          },
          {
            id: "renamed-only",
            name: "Renamed Only",
            provider: "custom-lab",
            thinkingLevels: [{ id: "high", label: "high" }],
          },
        ],
      },
      "custom-lab",
    );
    const savedRows = () =>
      JSON.parse(String(patches.at(-1)!.raw)).models.providers["custom-lab"].models as Record<
        string,
        unknown
      >[];
    const addLevel = (level: string) => {
      const select = manager.querySelector<HTMLSelectElement>(".provider-manager__thinking-add")!;
      select.value = level;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const rowLevel = (level: string) => manager.querySelector(`[data-thinking-level="${level}"]`);
    const removeLevel = (level: string) =>
      rowLevel(level)!.querySelector<HTMLButtonElement>("button")!.click();

    // A new model starts with an empty list; the add dropdown offers the
    // exact levels to append, so off/low/high needs no reshuffling.
    const add = [...manager.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Add model",
    )!;
    add!.click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    expect(rowLevel("off")).toBeNull();
    for (const level of ["off", "low", "high"]) {
      addLevel(level);
      await waitForFast(() => expect(rowLevel(level)).not.toBeNull());
    }
    setInput("id", "fresh");
    setInput("name", "Fresh");
    setInput("thinking-off", "  disabled  ");
    setInput("thinking-high", "high");
    await save();
    expect(savedRows().find((row) => row.id === "fresh")?.thinkingLevelMap).toEqual({
      off: "disabled",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
    // Prefilled catalog rows list only their offered levels; removing and
    // adding rows re-materializes the map with hidden slots. Untouched
    // prefilled values stay blank on the wire, so materialization passes the
    // level's own name through instead of a catalog effort value.
    editButton(manager, "discovered").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    expect(rowLevel("low")).not.toBeNull();
    expect(rowLevel("high")).not.toBeNull();
    expect(rowLevel("max")).toBeNull();
    removeLevel("high");
    await waitForFast(() => expect(rowLevel("high")).toBeNull());
    addLevel("off");
    await waitForFast(() => expect(rowLevel("off")).not.toBeNull());
    setInput("thinking-off", "disabled");
    await save();
    expect(savedRows().find((row) => row.id === "discovered")?.thinkingLevelMap).toEqual({
      off: "disabled",
      minimal: null,
      low: "low",
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
    // Editing a catalog row without touching its levels keeps the map
    // inherited: nothing is frozen into the authored entry.
    editButton(manager, "quiet").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    setInput("name", "Quiet renamed");
    await save();
    expect(savedRows().find((row) => row.id === "quiet")).not.toHaveProperty("thinkingLevelMap");
    // An authored map rides along unchanged through an unrelated edit.
    editButton(manager, "authored").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    setInput("name", "Authored renamed");
    await save();
    expect(savedRows().find((row) => row.id === "authored")?.thinkingLevelMap).toEqual({
      high: "auth-high",
    });
    // A configured row without its own map prefills the effective catalog
    // rows; editing a value materializes the whole map, nulls included.
    editButton(manager, "renamed-only").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    setInput("thinking-high", "renamed-high");
    setInput("name", "Renamed Only again");
    await save();
    expect(savedRows().find((row) => row.id === "renamed-only")?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "renamed-high",
      xhigh: null,
      max: null,
    });
  });

  it("saves text input by default and edits model modalities without losing its added marker", async () => {
    const { manager, input, setInput, save, patches } = await openDialog(
      {
        providers: { "custom-lab": { baseUrl: "https://example.test/v1", models: [] } },
        catalog: [],
      },
      "custom-lab",
    );
    const add = [...manager.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Add model",
    );
    expect(add).toBeDefined();
    add!.click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    setInput("id", "new-model");
    setInput("name", "New Model");
    await save();
    expect(JSON.parse(String(patches.at(-1)!.raw))).toEqual({
      models: {
        providers: {
          "custom-lab": {
            models: [
              { id: "new-model", name: "New Model", input: ["text"], metadataSource: "models-add" },
            ],
          },
        },
      },
    });
    editButton(manager, "new-model").click();
    await waitForFast(() => expect(input("input-video")).not.toBeNull());
    input("input-video").click();
    await save();
    expect(JSON.parse(String(patches.at(-1)!.raw))).toMatchObject({
      models: {
        providers: {
          "custom-lab": {
            models: [
              {
                id: "new-model",
                input: ["text", "video"],
                metadataSource: "models-add",
              },
            ],
          },
        },
      },
    });
  });
});
