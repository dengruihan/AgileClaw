/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import { configFieldId } from "../../components/config-form.shared.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { configRouteData } from "../config/route-data.ts";
import {
  appendPage,
  createEmptyModelProvidersRouteData,
  createHarness,
} from "./model-providers-page.test-support.ts";

afterEach(() => document.body.replaceChildren());

it("applies provider navigation without replacing an edited search during revalidation", async () => {
  const { context } = createHarness("writer");
  const page = appendPage(context);
  const routeData = { ...createEmptyModelProvidersRouteData(context), provider: "openai" };
  page.routeData = routeData;
  const search = () => page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  await waitForFast(() => expect(search()?.value).toBe("openai"));

  search().value = "anthropic";
  search().dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  // Route revalidation can publish its pending state before new route data arrives.
  Object.assign(page, { loaderPending: true });
  await page.updateComplete;
  Object.assign(page, { loaderPending: false });
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));
  page.routeData = { ...routeData };
  await waitForFast(() => expect(search()?.value).toBe("anthropic"));

  page.routeData = { ...routeData, provider: "minimax-portal" };
  await waitForFast(() => expect(search()?.value).toBe("minimax"));
  page.routeData = { ...routeData, provider: "" };
  await waitForFast(() => expect(search()?.value).toBe(""));
});

it.each([
  [
    "?section=models&subsection=providers&provider=local.one&view=settings",
    "#settings-model-providers",
  ],
  [
    "?section=models&subsection=providers&provider=local.one&view=models",
    "#settings-model-providers",
  ],
  ["?section=models.providers.local.one.models", ""],
  [
    "?section=models",
    `#${configFieldId(["models", "providers", "local.one", "baseUrl"], "description")}`,
  ],
  [
    "?section=models",
    `#${configFieldId(["models", "providers", "local.one", "models", 0, "name"], "description")}`,
  ],
])(
  "opens a provider link once and keeps it closed after revalidation: %s %s",
  async (search, hash) => {
    const { context, runtimeConfig, notifyRuntimeConfig } = createHarness("writer");
    await runtimeConfig.ensureLoaded();
    runtimeConfig.state.configForm = {
      models: { providers: { "local.one": { baseUrl: "http://localhost:11434/v1", models: [] } } },
    };
    const page = appendPage(context);
    const routeData = {
      ...createEmptyModelProvidersRouteData(context),
      provider: new URLSearchParams(search).get("provider") ?? "",
      catalogConfig: configRouteData({ pathname: "/settings/models", search, hash }),
    };
    page.routeData = routeData;
    notifyRuntimeConfig();
    // The merged provider dialog shows connection settings and models in one
    // view, so every provider deep link opens the same titled editor.
    await waitForFast(() =>
      expect(page.querySelector(".provider-manager__header h2")?.textContent?.trim()).toBe(
        "Local.one",
      ),
    );
    expect(page.querySelector(".provider-manager__models-section")).not.toBeNull();
    expect(
      page.querySelector<HTMLDetailsElement>("openclaw-model-catalog-settings > details")?.open,
    ).toBe(false);
    page.querySelector<HTMLButtonElement>(".provider-manager__header button")!.click();
    await waitForFast(() => expect(page.querySelector(".provider-manager__header")).toBeNull());
    page.routeData = { ...routeData };
    await page.updateComplete;
    expect(page.querySelector(".provider-manager__header")).toBeNull();
  },
);
