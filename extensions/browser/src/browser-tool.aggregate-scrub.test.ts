import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserTabs: vi.fn(),
}));

vi.mock("./browser-tool.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-tool.runtime.js")>();
  return { ...actual, browserTabs: mocks.browserTabs };
});

const { createBrowserTool } = await import("./browser-tool.js");
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
});
