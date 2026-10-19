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
      applyPatch(current, JSON.parse(String(patch.raw ?? "{}")), new Set(patch.replacePaths ?? []));
      return { config: current, hash: `patched-${patches.length}` };
    }
    if (method === "models.list") {
      return { models: config.catalog };
    }
    return originalRequest(method, params);
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
    manager
      .querySelector<HTMLButtonElement>('.provider-manager__footer button[type="submit"]')!
      .click();
    await waitForFast(() => expect(patches.length).toBeGreaterThan(0));
    // The write settles asynchronously; the edit form closing marks the saved
    // return to the merged view.
    await waitForFast(() =>
      expect(manager.querySelector(".provider-manager__models-section")).not.toBeNull(),
    );
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
    // A catalog-advertised model without an authored entry: saving without
    // touching reasoning must not freeze the capability into config.
    const { manager, save, patches, input, setInput, page } = await openDialog(
      {
        providers: {
          "custom-lab": {
            baseUrl: "https://example.test/v1",
            models: [{ id: "kept", name: "Kept", reasoning: true }],
          },
        },
        catalog: [
          { id: "discovered", name: "Discovered", provider: "custom-lab", reasoning: true },
        ],
      },
      "custom-lab",
    );
    editButton(manager, "discovered").click();
    await waitForFast(() => expect(input("id")).not.toBeNull());
    expect(input("id").disabled).toBe(true);
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
    // Toggling reasoning off on a catalog-only row saves an explicit false
    // override instead of falling back to the advertised capability.
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
            ],
          },
        },
        catalog: [
          {
            id: "discovered",
            name: "Discovered",
            provider: "custom-lab",
            thinkingLevelMap: { low: "cat-low", high: "cat-high", max: null },
          },
          {
            id: "quiet",
            name: "Quiet",
            provider: "custom-lab",
            thinkingLevelMap: { low: "quiet-low" },
          },
          {
            id: "renamed-only",
            name: "Renamed Only",
            provider: "custom-lab",
            thinkingLevelMap: { high: "rename-high", xhigh: null },
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
    const addLevel = () =>
      [...manager.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Add level",
      )!;
    const rowLevel = (level: string) => manager.querySelector(`[data-thinking-level="${level}"]`);
    const moveLevel = (from: string, to: string) => {
      const select = rowLevel(from)!.querySelector<HTMLSelectElement>("select")!;
      select.value = to;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const removeLevel = (level: string) =>
      rowLevel(level)!.querySelector<HTMLButtonElement>("button")!.click();

    // A new model starts with an empty list; added rows choose their slot and
    // value, and every level not added is hidden in the saved map.
    const add = [...manager.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Add model",
    )!;
    add!.click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    expect(rowLevel("off")).toBeNull();
    for (const level of ["off", "minimal", "low"]) {
      addLevel().click();
      await waitForFast(() => expect(rowLevel(level)).not.toBeNull());
    }
    moveLevel("minimal", "high");
    await waitForFast(() => expect(rowLevel("high")).not.toBeNull());
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
    // adding rows re-materializes the map with hidden slots.
    editButton(manager, "discovered").click();
    await waitForFast(() => expect(input("name")).not.toBeNull());
    expect(rowLevel("low")).not.toBeNull();
    expect(rowLevel("high")).not.toBeNull();
    expect(rowLevel("max")).toBeNull();
    removeLevel("high");
    await waitForFast(() => expect(rowLevel("high")).toBeNull());
    addLevel().click();
    await waitForFast(() => expect(rowLevel("off")).not.toBeNull());
    setInput("thinking-off", "disabled");
    await save();
    expect(savedRows().find((row) => row.id === "discovered")?.thinkingLevelMap).toEqual({
      off: "disabled",
      minimal: null,
      low: "cat-low",
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

  it("saves a new model with the text-only default input and the models-add marker", async () => {
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
  });
});
