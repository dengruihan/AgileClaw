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
  } as unknown as VaultService;
}

async function invoke(params: {
  handlers: ReturnType<typeof createVaultHandlers>;
  method: keyof ReturnType<typeof createVaultHandlers>;
  requestParams: Record<string, unknown>;
  scopes: string[];
}) {
  const respond = vi.fn();
  await params.handlers[params.method]?.({
    req: { type: "req", id: "1", method: params.method },
    params: params.requestParams,
    client: invokedClient(params.scopes),
    isWebchatConnect: () => false,
    respond: respond as never,
    context: {} as never,
  });
  return respond;
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
});
