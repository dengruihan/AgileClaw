/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { detected, mount, props, text } from "./test-helpers/view.test-support.ts";
import { renderModelSetup } from "./view.ts";

function wizardStep(step: WizardStep, value: unknown = step.initialValue): HTMLDivElement {
  return mount(
    props({
      wizard: {
        phase: "step",
        authChoice: "provider-auth",
        step,
        busy: false,
        validationError: null,
      },
      wizardValue: value,
    }),
  );
}

describe("renderModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("shows detected authentication without credential values", () => {
    const detail = "logged in · ChatGPT account · alex@example.com";
    const secret = "synthetic-private-token";
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [{ ...detected.candidates[0]!, detail: `${detail} · token=${secret}` }],
          },
        },
      }),
    );
    const row = container.querySelector('[data-candidate-kind="codex-cli"]')!;

    expect(text(row)).toContain(detail);
    expect(text(row)).not.toContain(secret);
  });

  it("derives prepare rows from accepted choice ids and hides usable local candidates", () => {
    const onStartPrepare = vi.fn();
    const container = mount(props({ onStartPrepare }));

    const ollama = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="ollama"] button',
    );
    const llamaCpp = container.querySelector<HTMLButtonElement>(
      '[data-prepare-choice="llama-cpp"] button',
    );
    expect(ollama?.textContent).toContain("Choose connection");
    expect(llamaCpp?.textContent).toContain("Set up model");
    expect(
      container.querySelector<HTMLButtonElement>('[data-prepare-choice="lmstudio"] button')
        ?.textContent,
    ).toContain("Connect server");
    const llamaCppRow = container.querySelector('[data-prepare-choice="llama-cpp"]');
    expect(llamaCppRow?.querySelector('[data-provider-icon="llamacpp"]')).not.toBeNull();
    expect(text(llamaCppRow!)).toContain("llama.cpp");
    expect(text(llamaCppRow!)).not.toContain("Gemma");
    expect(llamaCppRow?.classList.contains("model-setup__prepare-row--featured")).toBe(false);
    ollama?.click();
    expect(onStartPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: "ollama" }));

    const withUsableOllama = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [
              ...detected.candidates,
              {
                kind: "provider-auto:ollama",
                label: "Ollama",
                detail: "available locally",
                modelRef: "ollama/qwen3:8b",
                recommended: false,
              },
            ],
          },
        },
      }),
    );
    expect(withUsableOllama.querySelector('[data-prepare-choice="ollama"]')).toBeNull();
  });

  it("renders recommended install cards only when candidates and sign-ins are empty", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: { ...detected, candidates: [], authOptions: [] },
        },
      }),
    );

    expect(text(container)).toContain("Recommended installs");
    expect(text(container)).toContain("Ollama Run open models locally");
    const card = container.querySelector('[data-recommended-install="ollama"]');
    const icon = card?.querySelector<HTMLElement>('[data-provider-icon="ollama"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    expect(icon).not.toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    expect(link?.href).toBe("https://ollama.com/download");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener");

    const withSignIn = mount(
      props({
        page: { phase: "ready", result: { ...detected, candidates: [] } },
      }),
    );
    expect(withSignIn.querySelector(".model-setup__empty")).toBeNull();
  });

  it("never renders remote icon URLs directly", () => {
    const container = mount(props({ iconUrls: {} }));

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("https://cdn.example.com");
  });

  it("uses explicit brand identity without guessing from labels or opaque ids", () => {
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "custom-login",
                brandId: "claude",
                label: "Company account",
                icon: "https://cdn.example.com/custom.png",
              },
            ],
          },
        },
        manualProviderId: "custom-login",
        iconUrls: {},
      }),
    );

    expect(
      container.querySelector('.model-setup__manual [data-provider-icon="claude"]'),
    ).not.toBeNull();
    expect(container.querySelector(".model-setup__manual img")).toBeNull();
  });

  it("uses proxied artwork for unknown providers and invalidates broken blobs", () => {
    const iconUrl = "https://cdn.example.com/acme.png";
    const onIconError = vi.fn();
    const container = mount(
      props({
        page: {
          phase: "ready",
          result: {
            ...detected,
            candidates: [],
            authOptions: [],
            recommendedInstalls: [],
            manualProviders: [
              {
                id: "acme",
                label: "Acme",
                icon: iconUrl,
              },
            ],
          },
        },
        manualProviderId: "acme",
        iconUrls: { [iconUrl]: "blob:acme" },
        onIconError,
      }),
    );

    const image = container.querySelector<HTMLImageElement>(".model-setup__manual img");
    expect(image?.src).toBe("blob:acme");
    expect(image?.alt).toBe("Acme");
    image?.dispatchEvent(new Event("error"));
    expect(onIconError).toHaveBeenCalledWith(iconUrl);
    expect(container.innerHTML).not.toContain(iconUrl);
  });

  it("renders admin and older-gateway gates without actions", () => {
    const admin = mount(props({ canAdmin: false }));
    expect(text(admin)).toContain("Model setup requires operator.admin access.");
    expect(admin.querySelector(".settings-section")).toBeNull();

    const old = mount(props({ gatewayTooOld: true }));
    expect(text(old)).toContain("The Gateway is running an older AgileClaw version");
    expect(old.querySelector(".settings-section")).toBeNull();
  });

  it("keeps saved replacement credentials selectable without repeating the current route", () => {
    const onActivateCandidate = vi.fn();
    const savedCandidate: SystemAgentSetupDetectResult["candidates"][number] = {
      kind: "saved-auth:openai:replacement",
      brandId: "openai",
      label: "Saved OpenAI credentials",
      detail: "Saved for retry after a failed setup test",
      modelRef: "openai/gpt-5",
      recommended: false,
      credentials: true,
    };
    const container = mount(
      props({
        onActivateCandidate,
        page: {
          phase: "ready",
          result: {
            ...detected,
            configuredModel: savedCandidate.modelRef,
            setupComplete: true,
            candidates: [
              {
                kind: "existing-model",
                brandId: "openai",
                label: "Current model",
                detail: "openai/gpt-5 — already configured",
                modelRef: savedCandidate.modelRef,
                recommended: false,
                credentials: true,
              },
              { ...savedCandidate, kind: "provider-auto:openai", label: "OpenAI" },
              savedCandidate,
              {
                kind: "claude-cli",
                brandId: "claude",
                label: "Claude Code",
                detail: "logged in",
                modelRef: "claude-cli/claude-opus-5",
                recommended: false,
                credentials: true,
              },
            ],
          },
        },
      }),
    );

    expect(container.querySelector('[data-candidate-kind="existing-model"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="provider-auto:openai"]')).toBeNull();
    expect(container.querySelector('[data-candidate-kind="claude-cli"]')).not.toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-candidate-kind="saved-auth:openai:replacement"] button',
    );
    expect(retry).not.toBeNull();
    expect(retry!.disabled).toBe(false);
    retry!.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(savedCandidate);
  });

  it("renders note links and device codes", () => {
    const container = wizardStep({
      id: "device",
      type: "note",
      title: "Authorize device",
      message: "Use this code",
      externalUrl: "https://example.com/device",
      deviceCode: { code: "ABCD-EFGH", expiresInMinutes: 10 },
    });
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/device"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noreferrer");
    expect(text(container)).toContain("ABCD-EFGH");
    expect(text(container)).toContain("Expires in 10 minutes");
  });

  it.each([true, false])("reports device-code fallback success: %s", async (copied) => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    vi.stubGlobal("navigator", copied ? {} : { clipboard: { writeText } });
    const execCommand = vi.fn().mockImplementation(() => {
      expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("ABCD-EFGH");
      return copied;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = wizardStep({
      id: "device",
      type: "note",
      deviceCode: { code: "ABCD-EFGH" },
    });

    const copy = container.querySelector<HTMLButtonElement>(".wizard-step__sign-in button");
    copy?.click();

    const feedback = copied ? "Copied!" : "Copy failed";
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe(feedback));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledTimes(copied ? 0 : 1);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input and associates validation errors until recovery",
    ({ sensitive, expectedType }) => {
      const container = document.body.appendChild(document.createElement("div"));
      const renderStep = (validationError: string | null) =>
        render(
          renderModelSetup(
            props({
              wizard: {
                phase: "step",
                authChoice: "provider-auth",
                step: {
                  id: "access-value",
                  type: "text",
                  message: "Provider access value",
                  sensitive,
                  placeholder: "Enter value",
                },
                busy: false,
                validationError,
              },
              wizardValue: "initial value",
            }),
          ),
          container,
        );
      renderStep(null);
      const input = container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input");
      const label = container.querySelector<HTMLLabelElement>(
        'label[for="model-setup-wizard-text-input"]',
      );
      expect(label?.textContent).toBe("Provider access value");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
      renderStep("That access value is not valid.");
      const errorId = input?.getAttribute("aria-describedby");
      expect(input?.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(errorId ?? "")?.textContent).toContain(
        "That access value is not valid.",
      );
      renderStep(null);
      expect(input?.hasAttribute("aria-invalid")).toBe(false);
      expect(input?.hasAttribute("aria-describedby")).toBe(false);
    },
  );

  it("keeps a Continue action for client progress", () => {
    const container = wizardStep({
      id: "client-progress",
      type: "progress",
      message: "Waiting for the local client",
      executor: "client",
    });

    expect(text(container)).toContain("Waiting for the local client");
    expect(text(container)).toContain("Continue");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
