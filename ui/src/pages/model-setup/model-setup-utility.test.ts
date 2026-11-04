/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  candidate,
  clickCandidate,
  createModelSetupContext,
  detection,
  mountPage,
  selectManualProvider,
} from "./model-setup.test-support.ts";

const utility = {
  ...candidate("provider-auto:local", "local/setup", true),
  modelTarget: "utility" as const,
};
const activatedUtility = {
  done: true,
  status: "done",
  modelActivation: { modelRef: utility.modelRef, modelTarget: utility.modelTarget },
};

function createUtilityContext() {
  const fixture = createModelSetupContext();
  return {
    ...fixture,
    mount: (result: Partial<SystemAgentSetupDetectResult>) =>
      mountPage(fixture.context, {
        client: fixture.client,
        state: { phase: "ready", result: { ...detection, ...result } },
      }),
  };
}

describe("ModelSetupPage utility roles", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "synthetic-utility-device-key" }),
    );
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the setup assistant after explicit utility activation", async () => {
    const { context, request, mount } = createUtilityContext();
    request.mockResolvedValue(activatedUtility);
    const { page } = await mount({ candidates: [utility] });

    expect(page.textContent).toContain("Setup & utility");
    expect(page.textContent).toContain("Use for setup");
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, utility.kind);
    await waitForFast(() => expect(page.textContent).toContain("Setup & utility model ready"));
    const success = page.querySelector(".model-setup-success")!;
    expect(success.textContent).not.toContain("start chatting");
    expect(success.textContent).not.toContain("Active model");
    [...success.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Open setup assistant"))!
      .click();
    await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("chat"));
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      kind: utility.kind,
      modelRef: utility.modelRef,
      modelTarget: "utility",
    });
  });

  it.each([false, true])(
    "keeps the configured utility available for reopening and repair (primary: %s)",
    async (primary) => {
      const { context, request, mount } = createUtilityContext();
      request.mockResolvedValue(activatedUtility);
      const { page } = await mount({
        candidates: [utility],
        utilityModel: utility.modelRef,
        ...(primary
          ? { configuredModel: "cloud/primary", setupComplete: true }
          : { setupModel: utility.modelRef }),
      });

      expect(page.querySelector(`[data-candidate-kind="${utility.kind}"]`)).toBeNull();
      expect(page.textContent).toContain(
        primary
          ? "Regular chats use your primary model"
          : "Choose a primary model below for regular chats",
      );
      const buttons = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__utility button")];
      buttons.find((button) => button.textContent?.includes("Open setup assistant"))!.click();
      expect(context.navigate).toHaveBeenCalledWith("chat");
      expect(request).not.toHaveBeenCalled();
      buttons.find((button) => button.textContent?.includes("Recheck & repair"))!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.activate.start",
          expect.objectContaining({
            kind: utility.kind,
            modelRef: utility.modelRef,
            modelTarget: "utility",
          }),
          expect.anything(),
        ),
      );
    },
  );

  it("acknowledges a manual provider's utility role in the actual activation request", async () => {
    const { request, mount } = createUtilityContext();
    request.mockResolvedValue(activatedUtility);
    const { page } = await mount({
      manualProviders: [{ id: "manual-utility", label: "Utility API key", modelTarget: "utility" }],
    });
    await selectManualProvider(page, "manual-utility");
    const key = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    key.value = "synthetic-utility-key";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate.start",
        expect.objectContaining({
          kind: "api-key",
          authChoice: "manual-utility",
          apiKey: "synthetic-utility-key",
          modelTarget: "utility",
        }),
        expect.anything(),
      ),
    );
    await waitForFast(() => expect(page.querySelector(".model-setup-success")).not.toBeNull());
  });

  it("retains the advertised utility role when preparation directly returns its model", async () => {
    const { request, mount } = createUtilityContext();
    request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.prepare.start") {
        return { done: true, status: "done", preparedModelRef: utility.modelRef };
      }
      if (method === "openclaw.setup.activate.start") {
        expect(params).toMatchObject({
          kind: utility.kind,
          modelRef: utility.modelRef,
          modelTarget: "utility",
        });
        return activatedUtility;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mount({
      prepareOptions: [{ id: "local", label: "Utility model", modelTarget: "utility" }],
    });
    page.querySelector<HTMLButtonElement>('[data-prepare-choice="local"] button')!.click();
    await waitForFast(() => expect(page.querySelector(".model-setup-success")).not.toBeNull());
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.prepare.start",
      "openclaw.setup.activate.start",
    ]);
  });

  it.each([true, false])(
    "keeps the primary while utility preparation redetects its model (usable: %s)",
    async (usable) => {
      const { request, mount } = createUtilityContext();
      const prepared = {
        ...detection,
        configuredModel: "cloud/primary",
        setupComplete: true,
        prepareOptions: [{ id: "local", label: "Local utility", modelTarget: "utility" as const }],
      };
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.prepare.start") {
          return { done: true, status: "done" };
        }
        if (method === "openclaw.setup.detect") {
          return {
            ...prepared,
            utilityModel: utility.modelRef,
            candidates: usable ? [utility] : [],
          };
        }
        if (method === "openclaw.setup.activate.start") {
          return activatedUtility;
        }
        throw new Error("Unexpected method " + method);
      });
      const { page } = await mount(prepared);
      page.querySelector<HTMLButtonElement>('[data-prepare-choice="local"] button')!.click();
      await waitForFast(() =>
        expect(page.textContent).toContain(
          usable
            ? "Setup & utility model ready"
            : "Local utility did not expose a usable local model",
        ),
      );
      expect(page.querySelector(".model-setup__utility")).toBeNull();
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.prepare.start",
        "openclaw.setup.detect",
        ...(usable ? ["openclaw.setup.activate.start"] : []),
      ]);
      if (usable) {
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.activate.start",
          expect.objectContaining({
            agentId: "main",
            kind: utility.kind,
            modelRef: utility.modelRef,
            modelTarget: "utility",
          }),
          expect.anything(),
        );
      }
    },
  );
});
