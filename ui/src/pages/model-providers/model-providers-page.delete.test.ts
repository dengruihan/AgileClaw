/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import {
  appendPage,
  createApiKeyProviderData,
  createAuthStatus,
  createHarness,
  waitForProviders,
} from "./model-providers-page.test-support.ts";

const confirmMocks = vi.hoisted(() => ({ showConfirmDialog: vi.fn() }));
vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: confirmMocks.showConfirmDialog,
}));

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage provider deletion", () => {
  function customProxyConfig(defaults: Record<string, unknown> = {}) {
    return {
      config: {
        agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto", ...defaults } },
        models: {
          providers: {
            "custom.proxy": {
              baseUrl: "https://models.example.test/v1",
              models: [{ id: "m1", name: "M1" }],
            },
          },
        },
      },
      hash: "hash",
      valid: true,
    };
  }

  async function setupDeletePage(
    defaults: Record<string, unknown> = {},
    data: ModelProvidersData = createApiKeyProviderData(),
  ) {
    const harness = createHarness("main");
    const originalRequest = harness.request.getMockImplementation()!;
    harness.request.mockImplementation(async (method: string) =>
      method === "config.get" ? customProxyConfig(defaults) : originalRequest(method),
    );
    confirmMocks.showConfirmDialog.mockResolvedValue(true);
    const page = appendPage(harness.context);
    await waitForProviders(page);
    page.data = data;
    // Custom-provider cards render on the Custom tab.
    page.querySelector<HTMLButtonElement>('[data-provider-category="custom"]')!.click();
    await page.updateComplete;
    return { ...harness, page };
  }

  it("deletes a custom provider entry without a logout when it has no credentials", async () => {
    const { request, runtimeConfig, page } = await setupDeletePage();
    page.querySelector<HTMLButtonElement>('[data-models-delete-provider="custom.proxy"]')!.click();
    await waitForFast(() => expect(page.messages.connection?.kind).toBe("success"));
    expect(request.mock.calls.filter(([method]) => method === "models.authLogout")).toHaveLength(0);
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { models: { providers: { "custom.proxy": null } } },
      note: "Delete provider",
    });
    expect(confirmMocks.showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
  });

  it("offers deletion for catalog-known providers with an authored entry", async () => {
    const harness = createHarness("main");
    const originalRequest = harness.request.getMockImplementation()!;
    const openaiConfig = {
      config: {
        agents: { defaults: { thinkingDefault: "low", fastModeDefault: "auto" } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5", name: "GPT-5" }],
            },
          },
        },
      },
      hash: "hash",
      valid: true,
    };
    harness.request.mockImplementation(async (method: string) =>
      method === "config.get" ? openaiConfig : originalRequest(method),
    );
    confirmMocks.showConfirmDialog.mockResolvedValue(true);
    const page = appendPage(harness.context);
    await waitForProviders(page);
    page.data = {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      authStatus: {
        ...createAuthStatus([]),
        providerCapabilities: [
          { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
        ],
      },
    };
    await page.updateComplete;
    // The cloud tab is the default; no category switch needed.
    const button = page.querySelector<HTMLButtonElement>('[data-models-delete-provider="openai"]');
    expect(button).not.toBeNull();
    button!.click();
    await waitForFast(() => expect(page.messages.connection?.kind).toBe("success"));
    expect(harness.runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { models: { providers: { openai: null } } },
      note: "Delete provider",
    });
  });

  it("declining the confirmation leaves the provider untouched", async () => {
    const { request, runtimeConfig, page } = await setupDeletePage();
    confirmMocks.showConfirmDialog.mockResolvedValue(false);
    page.querySelector<HTMLButtonElement>('[data-models-delete-provider="custom.proxy"]')!.click();
    await page.updateComplete;
    expect(request).not.toHaveBeenCalledWith("models.authLogout", expect.anything());
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("logs out stored credentials before applying the delete patch", async () => {
    const { request, runtimeConfig, page } = await setupDeletePage(
      {},
      {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        authStatus: {
          ...createAuthStatus([
            {
              provider: "custom.proxy",
              displayName: "Custom Proxy",
              profiles: [
                {
                  profileId: "custom.proxy:key",
                  type: "api_key",
                  status: "static",
                  logoutSupported: true,
                },
              ],
            },
          ]),
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
          ],
        },
      },
    );
    page.querySelector<HTMLButtonElement>('[data-models-delete-provider="custom.proxy"]')!.click();
    await waitForFast(() => expect(page.messages.connection?.kind).toBe("success"));
    expect(request).toHaveBeenCalledWith("models.authLogout", {
      provider: "custom.proxy",
      agentId: "main",
    });
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { models: { providers: { "custom.proxy": null } } },
      note: "Delete provider",
    });
  });

  it("aborts before the patch when the credential logout fails", async () => {
    const { request, runtimeConfig, page } = await setupDeletePage(
      {},
      {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        authStatus: {
          ...createAuthStatus([
            {
              provider: "custom.proxy",
              displayName: "Custom Proxy",
              profiles: [
                {
                  profileId: "custom.proxy:key",
                  type: "api_key",
                  status: "static",
                  logoutSupported: true,
                },
              ],
            },
          ]),
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
          ],
        },
      },
    );
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method: string) => {
      if (method === "models.authLogout") {
        throw new Error("logout unavailable");
      }
      return originalRequest(method);
    });
    page.querySelector<HTMLButtonElement>('[data-models-delete-provider="custom.proxy"]')!.click();
    await waitForFast(() => expect(page.messages.connection?.kind).toBe("error"));
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("clears default-model references in the same delete patch", async () => {
    const { runtimeConfig, page } = await setupDeletePage({
      model: { primary: "custom.proxy/m1", fallbacks: ["openai/gpt-5", "custom.proxy/m2"] },
      utilityModel: "custom.proxy/m2",
    });
    page.querySelector<HTMLButtonElement>('[data-models-delete-provider="custom.proxy"]')!.click();
    await waitForFast(() => expect(page.messages.connection?.kind).toBe("success"));
    expect(confirmMocks.showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("agents.defaults.model.primary"),
      }),
    );
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: {
        agents: { defaults: { model: null, utilityModel: null } },
        models: { providers: { "custom.proxy": null } },
      },
      note: "Delete provider",
    });
  });
});
