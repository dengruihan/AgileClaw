import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  browserVaultObserve: vi.fn(),
  browserVaultSubmit: vi.fn(),
  jsonResult: vi.fn((details: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  })),
}));

vi.mock("./browser-tool.runtime.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
  browserVaultObserve: mocks.browserVaultObserve,
  browserVaultSubmit: mocks.browserVaultSubmit,
  jsonResult: mocks.jsonResult,
}));

const { executeVaultAutofillAction } = await import("./browser-tool.vault-fill.js");
const { clearVaultFillSession } = await import("./browser/vault-fill-scrub.js");

const ORIGIN = { scheme: "https" as const, host: "login.example.com", port: 443 };
const CANARY = "canary-autofill-7c31e9b2";

function observation(documentId = "loader-1") {
  return {
    ok: true as const,
    targetId: "target-1",
    origin: ORIGIN,
    documentId,
    frameId: "frame-1",
    fieldSignature: "fields-1",
    fields: {
      passwordIndex: 2,
      usernameIndex: 0,
      passwordName: "password",
      passwordAutocomplete: "current-password",
      usernameName: "email",
      usernameAutocomplete: "username",
    },
  };
}

function baseParams() {
  return {
    itemRef: "vault_entry_1",
    reason: "sign in",
    targetId: "target-1",
    baseUrl: "http://127.0.0.1:18800",
    profile: "shared",
    proxyRequest: null,
    agentId: "agent-1",
    agentSessionKey: "agent:main",
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    status: "needs_approval",
    itemRef: "vault_entry_1",
    siteLabel: "Example Login",
    accountLabel: "person@example.com",
    origin: ORIGIN,
    previewId: "vaultfill_preview_1",
    revision: 2,
    ...overrides,
  };
}

describe("browser vault autofill", () => {
  beforeEach(() => {
    mocks.callGatewayTool.mockReset();
    mocks.browserVaultObserve.mockReset();
    mocks.browserVaultSubmit.mockReset();
    clearVaultFillSession("target-1");
  });

  it("fills through the internal material channel without returning secrets", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve.mockResolvedValue(observation());
    mocks.callGatewayTool
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" })
      .mockResolvedValueOnce({
        status: "filled",
        itemRef: "vault_entry_1",
        siteLabel: "Example Login",
        accountLabel: "person@example.com",
        origin: ORIGIN,
      });

    const result = await executeVaultAutofillAction(baseParams());

    const gatewayMethods = mocks.callGatewayTool.mock.calls.map((call) => call[0]);
    expect(gatewayMethods).toEqual([
      "vault.fill.preview",
      "vault.fill.approval.request",
      "vault.fill.execute",
    ]);
    // The model-visible result carries no password and no account label.
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(result.details).toMatchObject({
      status: "filled",
      itemRef: "vault_entry_1",
      siteLabel: "Example Login",
      origin: "https://login.example.com",
      submit: false,
    });
  });

  it("returns denied without executing or filling", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve.mockResolvedValue(observation());
    mocks.callGatewayTool
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "deny" });

    const result = await executeVaultAutofillAction(baseParams());
    expect(result.details).toMatchObject({ status: "denied" });
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("invalidates the request when the document changes after approval", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve
      .mockResolvedValueOnce(observation("loader-1"))
      .mockResolvedValueOnce(observation("loader-2"));
    mocks.callGatewayTool
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await executeVaultAutofillAction(baseParams());
    expect(result.details).toMatchObject({
      status: "document_changed",
      reasonCode: "page_changed_after_approval",
    });
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("requests a second approval before submitting a filled form", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve.mockResolvedValue(observation());
    mocks.callGatewayTool
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" })
      .mockResolvedValueOnce({
        status: "filled",
        itemRef: "vault_entry_1",
        siteLabel: "Example Login",
        origin: ORIGIN,
      })
      .mockResolvedValueOnce({ id: "plugin:submit-1", decision: "allow-once" });
    mocks.browserVaultSubmit.mockResolvedValue({
      ok: true,
      status: "filled",
      targetId: "target-1",
    });

    const result = await executeVaultAutofillAction({ ...baseParams(), submit: true });

    expect(mocks.callGatewayTool.mock.calls.map((call) => call[0])).toEqual([
      "vault.fill.preview",
      "vault.fill.approval.request",
      "vault.fill.execute",
      "vault.fill.approval.request",
    ]);
    expect(result.details).toMatchObject({ status: "filled", submitted: true });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(mocks.browserVaultSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit when the second approval is denied", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve.mockResolvedValue(observation());
    mocks.callGatewayTool
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" })
      .mockResolvedValueOnce({ status: "filled", origin: ORIGIN })
      .mockResolvedValueOnce({ id: "plugin:submit-1", decision: "deny" });

    const result = await executeVaultAutofillAction({ ...baseParams(), submit: true });
    expect(result.details).toMatchObject({
      status: "filled",
      submitted: false,
      submitStatus: "deny",
    });
    expect(mocks.browserVaultSubmit).not.toHaveBeenCalled();
  });

  it("rejects remote/node browsers before observing", async () => {
    const result = await executeVaultAutofillAction({
      ...baseParams(),
      proxyRequest: {} as never,
    });
    expect(result.details).toMatchObject({
      status: "needs_human",
      reasonCode: "local_browser_required",
    });
    expect(mocks.browserVaultObserve).not.toHaveBeenCalled();
  });

  it("never exposes account metadata when preview cannot start an approval", async () => {
    clearVaultFillSession("target-1");
    mocks.browserVaultObserve.mockResolvedValue(observation());
    mocks.callGatewayTool.mockResolvedValueOnce({
      ...preview(),
      status: "origin_mismatch",
      reasonCode: "origin_mismatch",
    });
    const result = await executeVaultAutofillAction(baseParams());
    expect(result.details).toMatchObject({ status: "origin_mismatch" });
    expect(JSON.stringify(result)).not.toContain("person@example.com");
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(1);
  });
});
