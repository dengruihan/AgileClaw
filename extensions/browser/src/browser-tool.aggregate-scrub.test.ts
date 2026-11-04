import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserTabs: vi.fn(),
  callGatewayTool: vi.fn(),
}));

vi.mock("./browser-tool.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-tool.runtime.js")>();
  return {
    ...actual,
    browserTabs: mocks.browserTabs,
    callGatewayTool: mocks.callGatewayTool,
    readGatewayToolOperatorScopes: () => ["operator.write"],
    getRuntimeConfig: () => ({ browser: {}, gateway: { nodes: { browser: { mode: "off" } } } }),
  };
});

const { createBrowserTool } = await import("./browser-tool.js");
const { browserTabs: realBrowserTabs } = await import("./browser/client.js");
const { BrowserServiceError } = await import("./browser/client-fetch.js");
const { clearAllVaultFillSessions, registerVaultFillSecret } =
  await import("./browser/vault-fill-scrub.js");

const CANARY = "aggregate-tabs-canary-3e7f";
const KEY_CANARY = "property-key-canary-r5";
const GETTER_CANARY = "getter-result-canary-r6";
const DASH_CANARY = "dashboard-tabs-canary-r7";

describe("browser tool aggregate fill scrub", () => {
  beforeEach(() => {
    clearAllVaultFillSessions();
    mocks.browserTabs.mockReset();
    mocks.callGatewayTool.mockReset();
  });

  it("masks a filled page title in untargeted browser tabs content and details", async () => {
    registerVaultFillSecret("target-1", CANARY, "doc-1");
    mocks.browserTabs.mockResolvedValue({
      running: true,
      tabs: [
        {
          targetId: "target-1",
          title: `Synthetic login ${CANARY}`,
          url: "https://login.example.com/",
        },
        {
          targetId: "target-2",
          title: "Unrelated tab",
          url: "https://example.com/",
        },
      ],
    });

    const tool = createBrowserTool({ allowHostControl: true });
    const result = await tool.execute?.(
      "call-1",
      { action: "tabs" },
      undefined as never,
      undefined as never,
    );
    const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).not.toContain(CANARY);
    expect(text).toContain("***");
    expect(JSON.stringify(result?.details)).not.toContain(CANARY);
    expect(JSON.stringify(result?.details)).toContain("***");
  });

  it("masks secret-bearing property names in an aggregate tool result", async () => {
    registerVaultFillSecret("target-1", KEY_CANARY, "doc-1");
    mocks.browserTabs.mockResolvedValue({
      running: true,
      tabs: [
        {
          targetId: "target-1",
          title: { [KEY_CANARY]: "clean" },
          url: "https://login.example.com/",
        },
      ],
    });

    const tool = createBrowserTool({ allowHostControl: true });
    const result = await tool.execute?.(
      "call-1",
      { action: "tabs" },
      undefined as never,
      undefined as never,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY_CANARY);
    expect(serialized).toContain("***");
  });

  it("never invokes a result getter on the final scrub and stays value-free", async () => {
    registerVaultFillSecret("target-1", GETTER_CANARY, "doc-1");
    let getterCalls = 0;
    const title: Record<string, unknown> = {};
    Object.defineProperty(title, "display", {
      get() {
        getterCalls += 1;
        if (getterCalls >= 2) {
          throw new Error(`getter ${GETTER_CANARY}`);
        }
        return "clean";
      },
      enumerable: true,
      configurable: true,
    });
    mocks.browserTabs.mockResolvedValue({
      running: true,
      tabs: [{ targetId: "target-1", title, url: "https://login.example.com/" }],
    });

    const tool = createBrowserTool({ allowHostControl: true });
    const result = await tool.execute?.(
      "call-1",
      { action: "tabs" },
      undefined as never,
      undefined as never,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(GETTER_CANARY);
    // The dispatch formatter may read the getter once; the scrub must not.
    expect(getterCalls).toBeLessThanOrEqual(1);
  });

  it("masks an active fill canary in a scoped dashboard tabs success", async () => {
    registerVaultFillSecret("DASH-TAB", DASH_CANARY, "doc-1");
    // The dashboard dispatch routes through the real browserTabs client so the
    // proxyRequest -> callGatewayTool chain runs exactly as in production.
    mocks.browserTabs.mockImplementation(realBrowserTabs);
    mocks.callGatewayTool
      .mockResolvedValueOnce({
        sessionKey: "agent:main:dashboard-test",
        name: "service",
        instanceId: "widget-one",
        revision: 1,
        paused: false,
        stopping: false,
        url: "https://example.test/",
        browserTab: { target: "host", profile: "openclaw", targetId: "DASH-TAB" },
      })
      .mockResolvedValueOnce({
        running: true,
        tabs: [
          {
            targetId: "DASH-TAB",
            title: `dashboard ${DASH_CANARY}`,
            url: "https://example.test/",
          },
        ],
      });

    const tool = createBrowserTool({
      allowHostControl: true,
      agentSessionKey: "agent:main:dashboard-test",
      agentId: "main",
    });
    const result = await tool.execute?.(
      "call-1",
      { action: "tabs", dashboard: "service" },
      undefined as never,
      undefined as never,
    );

    const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).not.toContain(DASH_CANARY);
    expect(text).toContain("***");
    expect(JSON.stringify(result?.details)).not.toContain(DASH_CANARY);
    expect(JSON.stringify(result)).not.toContain(DASH_CANARY);
  });

  it("masks a filled value in a rejected aggregate tabs error without rethrowing the live object", async () => {
    registerVaultFillSecret("target-1", CANARY, "doc-1");
    const error = Object.assign(new BrowserServiceError(`tabs failed ${CANARY}`, undefined, 500), {
      details: { body: CANARY },
      cause: new Error(`loopback body ${CANARY}`),
    });
    mocks.browserTabs.mockRejectedValue(error);

    const tool = createBrowserTool({ allowHostControl: true });
    let thrown: unknown;
    try {
      await tool.execute?.("call-1", { action: "tabs" }, undefined as never, undefined as never);
    } catch (caught) {
      thrown = caught;
    }

    // Any active secret replaces the live object with an inert projection;
    // class identity is deliberately not preserved.
    expect(Object.is(thrown, error)).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    const record = thrown as {
      name?: string;
      status?: number;
      message: string;
      stack?: string;
      details?: { body?: string };
      cause?: unknown;
    };
    expect(record.name).toBe("BrowserServiceError");
    expect(record.status).toBe(500);
    expect(record.message).not.toContain(CANARY);
    expect(record.message).toContain("***");
    expect(String(record.stack)).not.toContain(CANARY);
    expect(JSON.stringify(record.details)).not.toContain(CANARY);
    expect(record.details?.body).toBe("***");
    expect(record.cause).toBeInstanceOf(Error);
    expect((record.cause as Error).message).not.toContain(CANARY);
    expect((record.cause as Error).message).toContain("***");
    expect(formatErrorMessage(thrown)).not.toContain(CANARY);
  });
});
