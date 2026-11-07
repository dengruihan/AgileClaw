import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

vi.mock("openclaw/plugin-sdk/channel-actions", () => ({
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

const { createVaultSaveLoginTool } = await import("./vault-save-login-tool.js");

const SAVED_ENTRY = {
  itemRef: "vault_agent_item",
  siteLabel: "example.com",
  account: "",
};

function gatewayError(details: Record<string, unknown>): Error {
  return Object.assign(new Error("gateway error"), { details });
}

async function runTool(params: Record<string, unknown>) {
  const tool = createVaultSaveLoginTool();
  const result = await tool.execute?.("call-1", params, undefined as never, undefined as never);
  return result?.details as Record<string, unknown>;
}

describe("vault_save_login tool", () => {
  beforeEach(() => {
    mocks.callGatewayTool.mockReset();
  });

  it("requires only the site in the schema and exposes no reveal surface", () => {
    const tool = createVaultSaveLoginTool();
    expect(tool.name).toBe("vault_save_login");
    const parsed = JSON.parse(JSON.stringify(tool.parameters)) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(parsed.required).toEqual(["site"]);
    expect(parsed.properties.itemRef).toBeUndefined();
    expect(parsed.properties.origin).toBeUndefined();
  });

  it("saves a full login through the agent-gated gateway method", async () => {
    mocks.callGatewayTool.mockResolvedValue({
      entry: { ...SAVED_ENTRY, account: "user@example.com" },
    });
    const result = await runTool({
      site: "https://example.com",
      account: "user@example.com",
      password: "synthetic-agent-password",
      notes: "agent note",
    });
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "vault.saveLogin",
      expect.anything(),
      {
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        account: "user@example.com",
        password: "synthetic-agent-password",
        notes: "agent note",
      },
      {
        scopes: ["operator.vault"],
        requireAgentRuntimeIdentity: true,
        signal: undefined,
      },
    );
    expect(result.status).toBe("saved");
    expect(result.itemRef).toBe("vault_agent_item");
    expect(JSON.stringify(result)).not.toContain("synthetic-agent-password");
    expect(JSON.stringify(result)).not.toContain("agent note");
    expect(result.emptyFields).toBeUndefined();
  });

  it("reports the blank fields of a partial save without any secret echo", async () => {
    mocks.callGatewayTool.mockResolvedValue({ entry: SAVED_ENTRY });
    const result = await runTool({ site: "example.com" });
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "vault.saveLogin",
      expect.anything(),
      { originScheme: "https", originHost: "example.com", originPort: 443 },
      expect.anything(),
    );
    expect(result.status).toBe("saved");
    expect(result.origin).toBe("https://example.com");
    expect(result.account).toBe("");
    expect(result.emptyFields).toEqual(["account", "password", "notes"]);
    expect(String(result.message)).toContain("blank fields");
  });

  it("reduces a URL with a path to its origin and keeps explicit ports", async () => {
    mocks.callGatewayTool.mockResolvedValue({ entry: SAVED_ENTRY });
    await runTool({ site: "http://localhost:3000/login?next=1" });
    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "vault.saveLogin",
      expect.anything(),
      { originScheme: "http", originHost: "localhost", originPort: 3000 },
      expect.anything(),
    );
  });

  it("rejects a site that is not an http(s) origin", async () => {
    for (const site of ["ftp://example.com", "https://user:pass@example.com"]) {
      const result = await runTool({ site });
      expect(result.status).toBe("invalid_input");
    }
    await expect(runTool({ site: "   " })).rejects.toThrow(/site required/u);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("maps vault errors to actionable value-free statuses", async () => {
    mocks.callGatewayTool.mockRejectedValueOnce(
      gatewayError({
        code: "VAULT_DUPLICATE",
        message: "An entry for this site and account already exists.",
        existingItemRef: "vault_existing",
      }),
    );
    const duplicate = await runTool({ site: "example.com", account: "user@example.com" });
    expect(duplicate).toMatchObject({
      status: "duplicate",
      existingItemRef: "vault_existing",
      origin: "https://example.com",
    });

    mocks.callGatewayTool.mockRejectedValueOnce(
      gatewayError({ code: "VAULT_WRITE_KEY_UNAVAILABLE", message: "unlock once" }),
    );
    const setup = await runTool({ site: "example.com" });
    expect(setup.status).toBe("setup_required");
    expect(String(setup.message)).toContain("unlock");

    mocks.callGatewayTool.mockRejectedValueOnce(
      gatewayError({ code: "VAULT_UNINITIALIZED", message: "Set up the password vault first." }),
    );
    const uninitialized = await runTool({ site: "example.com" });
    expect(uninitialized.status).toBe("vault_uninitialized");

    mocks.callGatewayTool.mockRejectedValueOnce(new Error("transport"));
    const unavailable = await runTool({ site: "example.com" });
    expect(unavailable).toMatchObject({ status: "unavailable", reasonCode: "vault_save_failed" });
    expect(JSON.stringify(unavailable)).not.toContain("synthetic");
  });
});
