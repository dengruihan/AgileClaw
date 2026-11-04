import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeVaultAutofillAction: vi.fn(),
}));

vi.mock("./browser-tool.vault-fill.js", () => ({
  executeVaultAutofillAction: mocks.executeVaultAutofillAction,
}));

vi.mock("./browser-tool.routing.js", () => ({
  resolveBrowserBaseUrl: () => undefined,
}));

vi.mock("./browser-tool.runtime.js", () => ({
  getRuntimeConfig: () => ({}),
  resolveBrowserConfig: () => ({ defaultProfile: "shared", profiles: { shared: {} } }),
  resolveProfile: () => ({}),
  jsonResult: (details: unknown) => ({ content: [], details }),
  readStringParam: (
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean },
  ) => {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (options?.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  },
}));

const { createBrowserLoginTool } = await import("./browser-login-tool.js");

describe("browser_login tool", () => {
  it("exposes itemRef without any password or origin field", () => {
    const tool = createBrowserLoginTool();
    expect(tool.name).toBe("browser_login");
    const schema = JSON.stringify(tool.parameters);
    const parsed = JSON.parse(schema) as { properties: Record<string, unknown> };
    expect(parsed.properties.itemRef).toBeDefined();
    expect(parsed.properties.password).toBeUndefined();
    expect(parsed.properties.origin).toBeUndefined();
  });

  it("passes only the opaque reference and trusted host route to the fill executor", async () => {
    mocks.executeVaultAutofillAction.mockResolvedValue({
      content: [],
      details: { status: "needs_approval" },
    });
    const tool = createBrowserLoginTool({ agentId: "agent-1", agentSessionKey: "agent:main" });
    const result = await tool.execute?.(
      "call-1",
      { itemRef: "vault_entry_1", reason: "sign in", profile: "shared", targetId: "target-1" },
      undefined as never,
      undefined as never,
    );
    expect(result?.details).toEqual({ status: "needs_approval" });
    expect(mocks.executeVaultAutofillAction).toHaveBeenCalledWith({
      itemRef: "vault_entry_1",
      reason: "sign in",
      submit: false,
      targetId: "target-1",
      baseUrl: undefined,
      profile: "shared",
      proxyRequest: null,
      signal: undefined,
      agentId: "agent-1",
      agentSessionKey: "agent:main",
    });
  });
});
