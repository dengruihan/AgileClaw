/* @vitest-environment jsdom */

import type { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import "../apps/apps-page.ts";

type AppsPageElement = LitElement & { appSearch: string };

const discoverResult = {
  servers: [
    {
      serverName: "parts",
      label: "Parts plugin",
      entrypoints: [
        {
          title: "Library",
          toolName: "library",
          resourceUri: "ui://parts/library",
          entrypoint: { type: "global" },
        },
      ],
    },
  ],
};

function mountPage(
  appSearch = "",
  operatorScopes: readonly string[] = ["operator.admin"],
  discover: () => Promise<unknown> = async () => discoverResult,
) {
  const navigate = vi.fn();
  const request = vi.fn(discover);
  const provider = createApplicationContextProvider({
    gateway: {
      snapshot: {
        sessionKey: "agent:main:main",
        client: { request },
        phase: "connected",
        hello: {
          auth: { scopes: [...operatorScopes] },
          features: { methods: ["mcp.app.discover"] },
        },
      },
      connectionRevision: 1,
      connection: { gatewayUrl: "wss://gateway.example.test" },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
    sessions: {
      state: { error: null },
      describe: vi.fn(async () => ({ session: { key: "agent:main:main" } })),
      createResult: vi.fn(async () => ({ key: "agent:main:main" })),
    },
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    navigate,
  } as unknown as ApplicationContext);
  const page = document.createElement("openclaw-apps-page") as AppsPageElement;
  page.appSearch = appSearch;
  provider.append(page);
  document.body.append(provider);
  return { page, provider, navigate };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("Plugin apps page", () => {
  it("renders the plugin catalog without official app promotion", async () => {
    const { page, provider } = mountPage();

    await page.updateComplete;
    await vi.dynamicImportSettled();
    await page.updateComplete;

    expect(page.querySelectorAll("a[href]")).toHaveLength(0);
    expect(page.querySelectorAll("img[src*='app-art']")).toHaveLength(0);
    const rendered = page.textContent ?? "";
    expect(rendered).not.toContain("Take AgileClaw everywhere");
    expect(rendered).not.toContain("Already have the app?");
    expect(rendered).not.toContain("Pair your device");
    expect(rendered).not.toContain("Chrome extension");
    expect(page.querySelector(".page-title")?.textContent).toBe("Plugin apps");
    expect(page.querySelector("openclaw-mcp-app-catalog")?.getAttribute("surface")).toBe("global");
    provider.remove();
  });

  it.each([["operator.read"], []])(
    "renders the same plugin catalog for non-admin access %j",
    async (scopes) => {
      const { page, provider } = mountPage("", scopes);

      await page.updateComplete;
      await vi.dynamicImportSettled();
      await page.updateComplete;

      expect(page.querySelector(".page-title")?.textContent).toBe("Plugin apps");
      expect(page.querySelector("openclaw-mcp-app-catalog")).not.toBeNull();
      expect(page.textContent).not.toContain("Pair your device");
      provider.remove();
    },
  );

  it("opens a plugin app from its deep link and returns to the catalog", async () => {
    // Discovery stays pending so the test exercises the route handoff, not the
    // embedded chat pane that the app conversation mounts.
    const { page, provider, navigate } = mountPage(
      "?tool=library&path=%2F&server=parts",
      ["operator.admin"],
      () => new Promise(() => {}),
    );

    await page.updateComplete;
    await vi.dynamicImportSettled();

    const close = [...page.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Close app",
    );
    expect(close).toBeDefined();
    expect(page.querySelector("openclaw-mcp-app-catalog")).toBeNull();
    close!.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("apps");
    provider.remove();
  });
});
