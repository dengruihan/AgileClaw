import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserTabs: vi.fn(),
}));

vi.mock("./browser-tool.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-tool.runtime.js")>();
  return { ...actual, browserTabs: mocks.browserTabs };
});

const { createBrowserTool } = await import("./browser-tool.js");
const { BrowserServiceError } = await import("./browser/client-fetch.js");
const { clearAllVaultFillSessions, registerVaultFillSecret } =
  await import("./browser/vault-fill-scrub.js");

const CANARY = "aggregate-tabs-canary-3e7f";

describe("browser tool aggregate fill scrub", () => {
  beforeEach(() => {
    clearAllVaultFillSessions();
    mocks.browserTabs.mockReset();
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

  it("masks a filled value in a rejected aggregate tabs error without losing its class", async () => {
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

    expect(thrown).toBe(error);
    expect(thrown).toBeInstanceOf(BrowserServiceError);
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
  });
});
