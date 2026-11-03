import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { VaultService } from "../../vault/vault-service.js";
import { VaultError } from "../../vault/vault-types.js";
import { createVaultHandlers } from "./vault.js";

const STATUS = {
  initialized: true,
  state: "locked" as const,
  autoLockSeconds: 300,
  failedAttempts: 0,
  itemCount: 0,
  deletedCount: 0,
};

function invokedClient(scopes: string[]) {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "control-ui",
        version: "test",
        platform: "web",
        mode: "webchat",
        displayName: "Control UI",
      },
      role: "operator",
      scopes,
    },
  } as never;
}

function createServiceStub() {
  return {
    status: vi.fn(async () => STATUS),
    initialize: vi.fn(async () => ({ ...STATUS, state: "unlocked" as const })),
    unlock: vi.fn(async () => ({ ...STATUS, state: "unlocked" as const })),
    lock: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({
      itemRef: "vault_item",
      originScheme: "https" as const,
      originHost: "example.com",
      originPort: 443,
      siteLabel: "Example",
      account: "user@example.com",
      hasNotes: false,
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    })),
    update: vi.fn(),
    delete: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    purge: vi.fn(async () => undefined),
    reveal: vi.fn(async () => ({
      entry: {
        itemRef: "vault_item",
        originScheme: "https" as const,
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "user@example.com",
        hasNotes: false,
        revision: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      password: "synthetic-password",
      notes: "",
    })),
    generate: vi.fn(async () => "generated-password"),
    setAutoLock: vi.fn(async () => STATUS),
    auditList: vi.fn(async () => []),
    fill: vi.fn(async () => ({
      entry: {
        itemRef: "vault_item",
        originScheme: "https" as const,
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "user@example.com",
        hasNotes: false,
        revision: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      password: "synthetic-fill-password",
    })),
    recordFillAudit: vi.fn(async () => undefined),
  } as unknown as VaultService;
}

function createUnlockedServiceStub() {
  const service = createServiceStub();
  service.status = vi.fn(async () => ({ ...STATUS, state: "unlocked" as const }));
  return service;
}

function invokedAgentClient(scopes: string[], agentId = "agent-1", sessionKey = "agent:main") {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "gateway-client",
        version: "test",
        platform: "linux",
        mode: "backend",
        displayName: "agent",
      },
      role: "operator",
      scopes,
    },
    internal: { agentRuntimeIdentity: { agentId, sessionKey } },
  } as never;
}

async function invoke(params: {
  handlers: ReturnType<typeof createVaultHandlers>;
  method: keyof ReturnType<typeof createVaultHandlers>;
  requestParams: Record<string, unknown>;
  scopes: string[];
  agent?: { agentId?: string; sessionKey?: string };
}) {
  const respond = vi.fn();
  await params.handlers[params.method]?.({
    req: { type: "req", id: "1", method: params.method },
    params: params.requestParams,
    client: params.agent
      ? invokedAgentClient(
          params.scopes,
          params.agent.agentId ?? "agent-1",
          params.agent.sessionKey ?? "agent:main",
        )
      : invokedClient(params.scopes),
    isWebchatConnect: () => false,
    respond: respond as never,
    context: {} as never,
  });
  return respond;
}

const FILL_ENTRY = {
  itemRef: "vault_item",
  originScheme: "https" as const,
  originHost: "login.example.com",
  originPort: 443,
  siteLabel: "Example Login",
  account: "person@example.com",
  hasNotes: false,
  revision: 2,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function fillParams() {
  return {
    itemRef: FILL_ENTRY.itemRef,
    reason: "sign in for the agent",
    origin: { scheme: "https", host: "login.example.com", port: 443 },
    profile: "shared",
    targetId: "target-1",
    documentId: "loader-1",
    frameId: "frame-1",
    fieldSignature: "fields-1",
  };
}

function createFillApproval() {
  const state = {
    snapshot: null as null | {
      status: string;
      decision: string;
      agentId: string;
      sessionKey: string;
      detail: string;
    },
    consumed: false,
  };
  return {
    state,
    lookup: {
      getSnapshot: async () => state.snapshot,
      consumeAllowOnce: async () => {
        if (state.consumed) {
          return false;
        }
        state.consumed = true;
        return true;
      },
    },
  };
}

describe("vault gateway methods", () => {
  it("does not let operator.admin imply reveal or unlock", async () => {
    const service = createServiceStub();
    const handlers = createVaultHandlers({ service });

    const reveal = await invoke({
      handlers,
      method: "vault.reveal",
      requestParams: { itemRef: "vault_item" },
      scopes: ["operator.admin", "operator.vault"],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn service stub
    expect(service.reveal).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );

    const unlock = await invoke({
      handlers,
      method: "vault.unlock",
      requestParams: { passphrase: "correct horse battery" },
      scopes: ["operator.admin"],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn service stub
    expect(service.unlock).not.toHaveBeenCalled();
    expect(unlock).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
  });

  it("allows reveal only with the explicit reveal scope and returns validated values", async () => {
    const service = createServiceStub();
    const handlers = createVaultHandlers({ service });
    const respond = await invoke({
      handlers,
      method: "vault.reveal",
      requestParams: { itemRef: "vault_item" },
      scopes: ["operator.admin", "operator.vault.reveal"],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn service stub
    expect(service.reveal).toHaveBeenCalledWith("vault_item", "reveal");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ password: "synthetic-password" }),
    );
  });

  it("maps vault failures to distinguishable protocol errors without values", async () => {
    const service = createServiceStub();
    service.unlock = vi.fn(async () => {
      throw new VaultError("VAULT_WRONG_PASSPHRASE", "Incorrect master passphrase.");
    });
    const handlers = createVaultHandlers({ service });
    const respond = await invoke({
      handlers,
      method: "vault.unlock",
      requestParams: { passphrase: "wrong but long enough" },
      scopes: ["operator.vault.reveal"],
    });
    const error = respond.mock.calls[0]?.[2] as {
      code: string;
      details: { code: string };
    };
    expect(error.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error.details.code).toBe("VAULT_WRONG_PASSPHRASE");
    expect(JSON.stringify(error)).not.toContain("wrong but long enough");
  });

  it("passes create fields to the vault service and never echoes the password", async () => {
    const service = createServiceStub();
    const handlers = createVaultHandlers({ service });
    const respond = await invoke({
      handlers,
      method: "vault.create",
      requestParams: {
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "user@example.com",
        password: "synthetic-password",
        notes: "note",
      },
      scopes: ["operator.vault"],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn service stub
    expect(service.create).toHaveBeenCalledWith({
      originScheme: "https",
      originHost: "example.com",
      originPort: 443,
      siteLabel: "Example",
      account: "user@example.com",
      password: "synthetic-password",
      notes: "note",
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("synthetic-password");
  });

  it("never writes vault values to handler logs", async () => {
    const logs: string[] = [];
    const service = createServiceStub();
    service.create = vi.fn(async () => {
      throw new VaultError("VAULT_CORRUPTED", "The vault entry secret is missing.");
    });
    const handlers = createVaultHandlers({
      service,
      log: { warn: (message) => logs.push(message) },
    });
    await invoke({
      handlers,
      method: "vault.create",
      requestParams: {
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "user@example.com",
        password: "log-canary-password",
        notes: "log-canary-notes",
      },
      scopes: ["operator.vault"],
    });
    expect(logs.join("\n")).not.toContain("log-canary");
    expect(logs.join("\n")).toContain("VAULT_CORRUPTED");
  });

  it("registers no vault tool on the model-facing agent tool surface", () => {
    const tools = fs.readdirSync("src/agents/tools");
    expect(tools.some((name) => /vault/iu.test(name))).toBe(false);
  });

  it("requests fill approval through the shared operator approval store", async () => {
    const service = createServiceStub();
    const calls: Array<{ request: Record<string, unknown>; timeoutMs: number }> = [];
    const handlers = createVaultHandlers({
      service,
      requestFillApproval: async (input) => {
        calls.push({
          request: input.request as unknown as Record<string, unknown>,
          timeoutMs: input.timeoutMs,
        });
        return { id: "plugin:fill-approval", decision: "allow-once" };
      },
    });
    const respond = await invoke({
      handlers,
      method: "vault.fill.approval.request",
      requestParams: {
        title: "Password fill: Example Login",
        description: "Agent wants https://login.example.com profile shared",
        detail: "preview: vaultfill_abc",
        timeoutMs: 60_000,
        allowedDecisions: ["allow-once", "deny"],
        pluginId: "spoofed-plugin",
        agentId: "spoofed-agent",
        sessionKey: "spoofed-session",
      },
      scopes: ["operator.vault"],
      agent: {},
    });
    expect(respond.mock.calls[0]?.[1]).toEqual({
      id: "plugin:fill-approval",
      decision: "allow-once",
    });
    expect(calls[0]).toMatchObject({
      timeoutMs: 60_000,
      request: {
        pluginId: "vault",
        agentId: "agent-1",
        sessionKey: "agent:main",
        toolName: "browser",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain("spoofed-agent");
  });

  it("requires a live agent runtime identity for fill previews", async () => {
    const service = createServiceStub();
    service.list = vi.fn(async () => [FILL_ENTRY]);
    const handlers = createVaultHandlers({ service });
    const denied = await invoke({
      handlers,
      method: "vault.fill.preview",
      requestParams: fillParams(),
      scopes: ["operator.vault"],
    });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        details: expect.objectContaining({ code: "VAULT_FILL_AGENT_REQUIRED" }),
      }),
    );
  });

  it("returns a value-free preview bound to the observed origin", async () => {
    const service = createUnlockedServiceStub();
    service.list = vi.fn(async () => [FILL_ENTRY]);
    const handlers = createVaultHandlers({ service });
    const respond = await invoke({
      handlers,
      method: "vault.fill.preview",
      requestParams: fillParams(),
      scopes: ["operator.vault"],
      agent: {},
    });
    const [ok, result] = respond.mock.calls[0] as [boolean, Record<string, unknown>];
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      status: "needs_approval",
      itemRef: "vault_item",
      siteLabel: "Example Login",
      accountLabel: "person@example.com",
      revision: 2,
      origin: { scheme: "https", host: "login.example.com", port: 443 },
    });
    expect(result.previewId).toMatch(/^vaultfill_/u);
    expect(JSON.stringify(result)).not.toContain("synthetic-fill-password");
    // The browser tool strips the operator-only account label before returning
    // any tool result to the model.
  });

  it("executes once with an allow-once approval and rejects replay", async () => {
    const service = createUnlockedServiceStub();
    service.list = vi.fn(async () => [FILL_ENTRY]);
    const approval = createFillApproval();
    const handlers = createVaultHandlers({ service, fillApproval: approval.lookup });
    const preview = await invoke({
      handlers,
      method: "vault.fill.preview",
      requestParams: fillParams(),
      scopes: ["operator.vault"],
      agent: {},
    });
    const previewResult = preview.mock.calls[0]?.[1] as { previewId: string };
    approval.state.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${previewResult.previewId}`,
    };

    const { reason: _reason, ...executeBinding } = fillParams();
    const executeParams = {
      previewId: previewResult.previewId,
      approvalId: "plugin:approval-1",
      ...executeBinding,
      revision: FILL_ENTRY.revision,
    };
    const first = await invoke({
      handlers,
      method: "vault.fill.execute",
      requestParams: executeParams,
      scopes: ["operator.vault"],
      agent: {},
    });
    const [firstOk, firstResult] = first.mock.calls[0] as [boolean, Record<string, unknown>];
    expect(firstOk).toBe(true);
    expect(firstResult).toMatchObject({
      status: "filled",
      itemRef: "vault_item",
      siteLabel: "Example",
      origin: { scheme: "https", host: "login.example.com", port: 443 },
    });
    expect(firstResult.password).toBe("synthetic-fill-password");
    // The internal response is consumed by the browser fill executor; it is not
    // a tool result or a protocol schema.

    const second = await invoke({
      handlers,
      method: "vault.fill.execute",
      requestParams: executeParams,
      scopes: ["operator.vault"],
      agent: {},
    });
    expect(second.mock.calls[0]?.[1]).toMatchObject({ status: "replayed" });
  });

  it("rejects a fill when the observed origin does not match the entry", async () => {
    const service = createUnlockedServiceStub();
    service.list = vi.fn(async () => [FILL_ENTRY]);
    const handlers = createVaultHandlers({ service });
    const respond = await invoke({
      handlers,
      method: "vault.fill.preview",
      requestParams: {
        ...fillParams(),
        origin: { scheme: "https", host: "phish.example.com", port: 443 },
      },
      scopes: ["operator.vault"],
      agent: {},
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      status: "origin_mismatch",
      reasonCode: "origin_mismatch",
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("synthetic-fill-password");
  });

  it("invalidates a pending fill preview when the entry is edited", async () => {
    const service = createUnlockedServiceStub();
    service.list = vi.fn(async () => [FILL_ENTRY]);
    service.update = vi.fn(async () => ({ ...FILL_ENTRY, revision: 3 }));
    const approval = createFillApproval();
    const handlers = createVaultHandlers({ service, fillApproval: approval.lookup });
    const preview = await invoke({
      handlers,
      method: "vault.fill.preview",
      requestParams: fillParams(),
      scopes: ["operator.vault"],
      agent: {},
    });
    const previewResult = preview.mock.calls[0]?.[1] as { previewId: string };
    await invoke({
      handlers,
      method: "vault.update",
      requestParams: {
        itemRef: FILL_ENTRY.itemRef,
        revision: FILL_ENTRY.revision,
        originScheme: FILL_ENTRY.originScheme,
        originHost: FILL_ENTRY.originHost,
        originPort: FILL_ENTRY.originPort,
        siteLabel: FILL_ENTRY.siteLabel,
        account: FILL_ENTRY.account,
        password: "rotated-password",
      },
      scopes: ["operator.vault"],
    });
    approval.state.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${previewResult.previewId}`,
    };
    const { reason: _reason, ...executeBinding } = fillParams();
    const execute = await invoke({
      handlers,
      method: "vault.fill.execute",
      requestParams: {
        previewId: previewResult.previewId,
        approvalId: "plugin:approval-1",
        ...executeBinding,
        revision: FILL_ENTRY.revision,
      },
      scopes: ["operator.vault"],
      agent: {},
    });
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ status: "expired" });
  });
});
