/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  appendPage,
  createHarness,
  requestCount,
  waitForProviders,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

type PatchParams = { raw?: string };

function addButtons(page: ModelProvidersPageTestElement): HTMLButtonElement[] {
  return [...page.querySelectorAll<HTMLButtonElement>("[data-custom-provider]")];
}

describe("ModelProvidersPage provider-key reservations", () => {
  it("waits for the provider list before creating, then reserves plugin provider ids", async () => {
    const harness = createHarness("main");
    const originalRequest = harness.request.getMockImplementation()!;
    const patches: PatchParams[] = [];
    let authStatusFails = true;
    harness.request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        if (authStatusFails) {
          throw new Error("synthetic provider list failure");
        }
        return {
          ts: 1,
          providers: [],
          providerCapabilities: [
            {
              provider: "custom-relay-example-test",
              apiKeySupported: true,
              quickApiKeySetup: true,
            },
          ],
        };
      }
      if (method === "config.patch") {
        const patch = params as PatchParams;
        patches.push(patch);
        return { config: JSON.parse(patch.raw ?? "{}"), hash: `patched-${patches.length}` };
      }
      return originalRequest(method, params);
    });

    const page = appendPage(harness.context);
    await waitForProviders(page);
    await waitForFast(() => expect(page.data?.error).toContain("synthetic provider list failure"));
    await page.updateComplete;

    // Creation is paused while the plugin reservation source is unavailable,
    // everywhere it can be started from.
    expect(addButtons(page)).toHaveLength(2);
    expect(addButtons(page).every((button) => button.disabled)).toBe(true);
    expect(page.querySelector("[data-provider-creation-blocked]")?.textContent).toContain(
      "Refresh and try again",
    );
    await page.selectProvider({ provider: "", view: "create" });
    await page.updateComplete;
    expect(page.querySelector("openclaw-provider-manager")).toBeNull();
    expect(page.messages.connection?.text).toContain("Refresh and try again");

    // A create intent that bypasses the buttons still cannot write a claimed key.
    (page as ModelProvidersPageTestElement & { managerIntent: unknown }).managerIntent = {
      provider: "",
      view: "create",
    };
    await page.updateComplete;
    const form = page.querySelector<HTMLFormElement>(
      "openclaw-provider-manager .provider-manager--inline",
    );
    expect(form).not.toBeNull();
    const baseUrl = form!.querySelector<HTMLInputElement>('[name="baseUrl"]')!;
    baseUrl.value = "https://relay.example.test/v1";
    baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await page.updateComplete;
    expect(page.querySelector("openclaw-provider-manager [role='alert']")?.textContent).toContain(
      "Refresh and try again",
    );
    expect(requestCount(harness.request, "config.patch")).toBe(0);

    // The refresh retry path restores creation, and the recovered capability list
    // keeps the plugin-declared id out of the generated-key namespace.
    authStatusFails = false;
    await page.refresh("forced");
    await waitForFast(() => expect(page.data?.authStatus?.providerCapabilities).toHaveLength(1));
    await page.updateComplete;
    expect(addButtons(page).every((button) => button.disabled)).toBe(false);
    expect(page.querySelector("[data-provider-creation-blocked]")).toBeNull();

    const name = form!.querySelector<HTMLInputElement>('[name="displayName"]')!;
    name.value = "Relay Example";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    name.dispatchEvent(new Event("change", { bubbles: true }));
    baseUrl.value = "https://relay.example.test/v1";
    baseUrl.dispatchEvent(new Event("input", { bubbles: true }));
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(patches).toHaveLength(1));
    expect(JSON.parse(patches[0]!.raw ?? "{}")).toEqual({
      models: {
        providers: {
          "custom-relay-example-test-2": {
            baseUrl: "https://relay.example.test/v1",
            api: "openai-completions",
            displayName: "Relay Example",
            models: [],
          },
        },
      },
    });
  });
});
