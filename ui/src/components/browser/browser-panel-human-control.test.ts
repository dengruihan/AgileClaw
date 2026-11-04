import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createView,
  flushBrowserResponses,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import { renderBrowserPanelChrome } from "./browser-panel-render.ts";
import "./browser-panel.ts";

function textInput(inputType: string, data: string | null = null) {
  return new InputEvent("beforeinput", {
    inputType,
    data,
    bubbles: true,
    cancelable: true,
  });
}

function paste(text: string) {
  const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: ["text/plain"], getData: () => text },
  });
  return event;
}

const ACTIVE_CONTROL = {
  owner: "human" as const,
  status: "active" as const,
  reason: "captcha",
  requestedBy: "agent" as const,
  profile: "work",
  targetId: "raw-form",
  tabId: "form-tab",
  generation: 2,
  claimedAtMs: 1_000,
  expiresAtMs: 301_000,
};

describe("Browser panel human control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(handle: (envelope: BrowserRequestEnvelope) => Promise<unknown>) {
    const { client, request } = createBrowserClient(handle);
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.refreshOnPresentation = false;
    panel.client = client;
    document.body.append(panel);
    await panel.updateComplete;
    const controller = (panel as unknown as { browserPanelController: BrowserPanelController })
      .browserPanelController;
    controller.activeTargetId = "form-tab";
    controller.view = createView("form-tab");
    controller.operations.resetRoute({ profile: "work" });
    panel.requestUpdate();
    await panel.updateComplete;
    return { panel, controller, request };
  }

  function humanControlHandler(
    overrides: Partial<Record<string, (envelope: BrowserRequestEnvelope) => Promise<unknown>>> = {},
  ) {
    return async (envelope: BrowserRequestEnvelope) => {
      const override = overrides[envelope.path];
      if (override) {
        return await override(envelope);
      }
      if (envelope.path === "/human-control") {
        return { ok: true, supported: true, control: null };
      }
      return { ok: true };
    };
  }

  it("claims control, shows ownership, and hands back with the capability", async () => {
    const { controller, request } = await mount(
      humanControlHandler({
        "/human-control/claim": async () => ({
          ok: true,
          targetId: "raw-form",
          tabId: "form-tab",
          control: ACTIVE_CONTROL,
          humanControlToken: "cap-token",
        }),
        "/human-control/release": async () => ({ ok: true, control: null }),
      }),
    );

    await controller.human.takeOver();
    expect(controller.human.control()).toMatchObject({ status: "active", reason: "captcha" });
    expect(controller.sensitiveInputActive()).toBe(true);
    expect(controller.humanControlTokenForInput()).toBe("cap-token");

    await controller.human.handBack();
    expect(controller.human.control()).toBeNull();
    expect(controller.sensitiveInputActive()).toBe(false);
    expect(
      request.mock.calls
        .map(([, params]) => params as BrowserRequestEnvelope)
        .find((envelope) => envelope.path === "/human-control/release"),
    ).toMatchObject({ body: { targetId: "form-tab", humanControlToken: "cap-token" } });
  });

  it("routes typed and pasted values through the sensitive channel while healing the tab", async () => {
    const { controller, request } = await mount(
      humanControlHandler({
        "/human-control/claim": async () => ({
          ok: true,
          control: ACTIVE_CONTROL,
          humanControlToken: "cap-token",
        }),
        "/human-input": async () => ({ ok: true, targetId: "raw-form" }),
      }),
    );
    await controller.human.takeOver();
    const textarea = (
      document.querySelector("openclaw-browser-panel") as HTMLElement & { renderRoot: ShadowRoot }
    ).renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;

    textarea.dispatchEvent(textInput("insertText", "123456"));
    await flushBrowserResponses();
    textarea.dispatchEvent(paste("backup-code-7788"));
    await flushBrowserResponses();

    const bodies = request.mock.calls
      .map(([, params]) => params as BrowserRequestEnvelope)
      .filter((envelope) => envelope.path === "/human-input")
      .map((envelope) => envelope.body);
    expect(bodies).toEqual([
      { targetId: "form-tab", text: "123456", humanControlToken: "cap-token" },
      { targetId: "form-tab", text: "backup-code-7788", humanControlToken: "cap-token" },
    ]);
    expect(
      request.mock.calls.filter(([, params]) => (params as BrowserRequestEnvelope).path === "/act"),
    ).toHaveLength(0);
  });

  it("shows a sensitive-input failure when the page has no focused field", async () => {
    const { controller } = await mount(
      humanControlHandler({
        "/human-control/claim": async () => ({
          ok: true,
          control: ACTIVE_CONTROL,
          humanControlToken: "cap-token",
        }),
        "/human-input": async () => ({ ok: false, reasonCode: "no_focused_field" }),
      }),
    );
    await controller.human.takeOver();
    const textarea = (
      document.querySelector("openclaw-browser-panel") as HTMLElement & { renderRoot: ShadowRoot }
    ).renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    textarea.dispatchEvent(textInput("insertText", "123456"));
    await flushBrowserResponses();

    expect(controller.errorText).toContain("Click the field in the page first");
    expect(controller.human.control()).toMatchObject({ status: "active" });
  });

  it("shows a fixed failure when sensitive insertion throws", async () => {
    const { controller } = await mount(
      humanControlHandler({
        "/human-control/claim": async () => ({
          ok: true,
          control: ACTIVE_CONTROL,
          humanControlToken: "cap-token",
        }),
        "/human-input": async () => {
          throw new Error("synthetic transport echoed the value");
        },
      }),
    );
    await controller.human.takeOver();
    const textarea = (
      document.querySelector("openclaw-browser-panel") as HTMLElement & { renderRoot: ShadowRoot }
    ).renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    textarea.dispatchEvent(textInput("insertText", "123456"));
    await flushBrowserResponses();

    expect(controller.errorText).toContain("Sensitive input was not delivered");
    expect(controller.errorText).not.toContain("synthetic transport");
  });

  it("clears a rejected capability and refreshes ownership after a blocked action", async () => {
    const { controller, request } = await mount(
      humanControlHandler({
        "/human-control/claim": async () => ({
          ok: true,
          control: ACTIVE_CONTROL,
          humanControlToken: "cap-token",
        }),
        "/act": async () => {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "A human currently controls this browser tab.",
            details: { code: "ACT_HUMAN_CONTROL", status: "needs_human" },
          });
        },
      }),
    );
    await controller.human.takeOver();
    const input = document.querySelector("openclaw-browser-panel") as HTMLElement & {
      renderRoot: ShadowRoot;
    };
    const textarea = input.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await flushBrowserResponses();

    expect(controller.humanControlTokenForInput()).toBeUndefined();
    expect(
      request.mock.calls.some(
        ([, params]) =>
          (params as BrowserRequestEnvelope).path === "/human-control" &&
          (params as BrowserRequestEnvelope).method === "GET",
      ),
    ).toBe(true);
  });

  it("renders the takeover request and active ownership states", () => {
    const { controller } = createRenderController();
    controller.human.apply({
      ...ACTIVE_CONTROL,
      status: "requested",
      requestedBy: "agent",
    } as import("./browser-human-control-client.ts").BrowserHumanControl);
    const requested = document.createElement("div");
    render(
      renderBrowserPanelChrome(controller, "bottom", 320, 400, vi.fn(), vi.fn(), nothing),
      requested,
    );
    expect(requested.querySelector(".bp-controlbar--attention")?.textContent).toContain(
      "needs your input",
    );
    expect(requested.querySelector(".bp-controlbar button")?.textContent).toContain("Take over");

    controller.human.apply(ACTIVE_CONTROL);
    (controller.human as unknown as { token: string | null }).token = "cap-token";
    const active = document.createElement("div");
    render(
      renderBrowserPanelChrome(controller, "bottom", 320, 400, vi.fn(), vi.fn(), nothing),
      active,
    );
    expect(active.querySelector(".bp-controlbar--human")?.textContent).toContain(
      "You control this tab",
    );
    expect(active.querySelector(".bp-controlbar")?.textContent).toContain("Hand back to agent");
  });
});

function createRenderController(): {
  controller: BrowserPanelController;
} {
  const { client } = createBrowserClient(async () => ({ ok: true }));
  const controller = new BrowserPanelController(new TestBrowserPanelHost(client));
  controller.activeTargetId = "form-tab";
  controller.view = createView("form-tab");
  controller.operations.resetRoute({ profile: "work" });
  return { controller };
}
