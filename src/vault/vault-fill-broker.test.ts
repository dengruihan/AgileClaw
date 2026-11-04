import { describe, expect, it } from "vitest";
import {
  VaultFillBroker,
  type VaultFillApprovalLookup,
  type VaultFillApprovalSnapshot,
  type VaultFillServicePort,
} from "./vault-fill-broker.js";
import type { VaultEntryMetadata } from "./vault-types.js";

const CANARY = "canary-fill-7d41f0f4b5";
const NOW = 1_800_000_000_000;

function entry(overrides: Partial<VaultEntryMetadata> = {}): VaultEntryMetadata {
  return {
    itemRef: "vault_entry_1",
    originScheme: "https",
    originHost: "login.example.com",
    originPort: 443,
    siteLabel: "Example Login",
    account: "person@example.com",
    hasNotes: false,
    revision: 3,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

class FakeApproval implements VaultFillApprovalLookup {
  snapshot: VaultFillApprovalSnapshot | null = null;
  consumed = false;
  consumeCalls = 0;

  async getSnapshot(): Promise<VaultFillApprovalSnapshot | null> {
    return this.snapshot;
  }

  async consumeAllowOnce(): Promise<boolean> {
    this.consumeCalls += 1;
    if (this.consumed) {
      return false;
    }
    this.consumed = true;
    return true;
  }
}

function harness(options: { entries?: VaultEntryMetadata[]; unlock?: boolean } = {}) {
  const entries = options.entries ?? [entry()];
  const audits: Array<{ itemRef?: string; reasonCode: string }> = [];
  let nextId = 0;
  let nowMs = NOW;
  const service: VaultFillServicePort = {
    status: async () => ({ state: options.unlock === false ? "locked" : "unlocked" }),
    list: async () => entries,
    fill: async (itemRef, revision, origin) => {
      const found = entries.find((candidate) => candidate.itemRef === itemRef);
      if (!found) {
        throw new Error("missing");
      }
      if (options.unlock === false) {
        throw Object.assign(new Error("locked"), { code: "VAULT_LOCKED" });
      }
      if (found.revision !== revision) {
        throw Object.assign(new Error("conflict"), { code: "VAULT_CONFLICT" });
      }
      if (
        found.originScheme !== origin.scheme ||
        found.originHost !== origin.host ||
        found.originPort !== origin.port
      ) {
        throw Object.assign(new Error("origin"), { code: "VAULT_ORIGIN_MISMATCH" });
      }
      return { entry: found, password: CANARY };
    },
    recordFillAudit: async (itemRef, reasonCode) => {
      audits.push({ ...(itemRef ? { itemRef } : {}), reasonCode });
    },
  };
  const approval = new FakeApproval();
  const broker = new VaultFillBroker({
    service,
    approval,
    now: () => nowMs,
    randomId: () => `fixed${(nextId += 1)}`,
  });
  return {
    broker,
    approval,
    audits,
    entries,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function binding(item = entry()) {
  return {
    itemRef: item.itemRef,
    revision: item.revision,
    origin: { scheme: item.originScheme, host: item.originHost, port: item.originPort },
    agentId: "agent-1",
    sessionKey: "agent:main",
    profile: "shared",
    targetId: "target-1",
    documentId: "loader-1",
    frameId: "frame-1",
    fieldSignature: "fields-1",
  } as const;
}

async function preview(broker: VaultFillBroker, overrides: Record<string, unknown> = {}) {
  return await broker.preview({
    itemRef: "vault_entry_1",
    origin: { scheme: "https", host: "login.example.com", port: 443 },
    agentId: "agent-1",
    sessionKey: "agent:main",
    profile: "shared",
    targetId: "target-1",
    documentId: "loader-1",
    frameId: "frame-1",
    fieldSignature: "fields-1",
    ...overrides,
  });
}

describe("vault fill broker", () => {
  it("returns only public metadata and never a password during preview", async () => {
    const { broker } = harness();
    const result = await preview(broker);
    expect(result).toMatchObject({
      status: "needs_approval",
      itemRef: "vault_entry_1",
      siteLabel: "Example Login",
      accountLabel: "person@example.com",
      origin: { scheme: "https", host: "login.example.com", port: 443 },
      revision: 3,
    });
    expect(result.previewId).toMatch(/^vaultfill_/u);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("rejects exact-origin mismatches without an approval", async () => {
    for (const [origin, status] of [
      [{ scheme: "http", host: "login.example.com", port: 443 }, "insecure_origin"],
      [{ scheme: "https", host: "login.example.com", port: 8443 }, "origin_mismatch"],
      [{ scheme: "https", host: "other.example.com", port: 443 }, "origin_mismatch"],
      [{ scheme: "https", host: "app.login.example.com", port: 443 }, "subdomain_mismatch"],
    ] as const) {
      const { broker, audits } = harness();
      const result = await preview(broker, { origin });
      expect(result.status).toBe(status);
      expect(result.previewId).toBeUndefined();
      expect(audits.at(-1)?.reasonCode).toBe(status);
    }
  });

  it("normalizes IDN hosts to the stored A-label form", async () => {
    const { broker } = harness({
      entries: [entry({ originHost: "xn--bcher-kva.example" })],
    });
    const result = await preview(broker, {
      origin: { scheme: "https", host: "bücher.example", port: 443 },
    });
    expect(result.status).toBe("needs_approval");
  });

  it("requires an allow-once approval bound to the preview and agent", async () => {
    const { broker, approval } = harness();
    const previewResult = await preview(broker);
    const base = binding();
    const request = {
      previewId: previewResult.previewId!,
      approvalId: "plugin:approval-1",
      binding: base,
    };

    expect((await broker.execute(request)).status).toBe("needs_approval");

    approval.snapshot = {
      status: "allowed",
      decision: "deny",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${request.previewId}`,
    };
    expect((await broker.execute(request)).status).toBe("denied");

    approval.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-2",
      sessionKey: "agent:main",
      detail: `preview: ${request.previewId}`,
    };
    expect((await broker.execute(request)).status).toBe("denied");

    approval.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: "preview: another-request",
    };
    expect((await broker.execute(request)).status).toBe("replayed");
    expect(approval.consumeCalls).toBe(0);
  });

  it("consumes the approval once and rejects replay", async () => {
    const { broker, approval, audits } = harness();
    const previewResult = await preview(broker);
    approval.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${previewResult.previewId}`,
    };
    const request = {
      previewId: previewResult.previewId!,
      approvalId: "plugin:approval-1",
      binding: binding(),
    };
    const first = await broker.execute(request);
    expect(first.status).toBe("filled");
    expect(first.status === "filled" ? first.material.password : "").toBe(CANARY);
    expect(approval.consumeCalls).toBe(1);

    const second = await broker.execute(request);
    expect(second.status).toBe("replayed");
    expect(audits.at(-1)?.reasonCode).toBe("replayed");
  });

  it("invalidates a preview when the document or revision changes", async () => {
    const first = harness();
    const previewResult = await preview(first.broker);
    first.approval.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${previewResult.previewId}`,
    };
    expect(
      (
        await first.broker.execute({
          previewId: previewResult.previewId!,
          approvalId: "plugin:approval-1",
          binding: { ...binding(), documentId: "loader-2" },
        })
      ).status,
    ).toBe("document_changed");

    const second = harness();
    const secondPreview = await preview(second.broker);
    second.approval.snapshot = {
      status: "allowed",
      decision: "allow-once",
      agentId: "agent-1",
      sessionKey: "agent:main",
      detail: `preview: ${secondPreview.previewId}`,
    };
    expect(
      (
        await second.broker.execute({
          previewId: secondPreview.previewId!,
          approvalId: "plugin:approval-1",
          binding: { ...binding(), revision: 4 },
        })
      ).status,
    ).toBe("revision_mismatch");
  });

  it("expires previews and revokes them on rotation or lock", async () => {
    const testHarness = harness();
    const { broker } = testHarness;
    const first = await preview(broker);
    testHarness.advance(121_000);
    expect(
      (
        await broker.execute({
          previewId: first.previewId!,
          approvalId: "plugin:approval-1",
          binding: binding(),
        })
      ).status,
    ).toBe("expired");

    const second = await preview(broker);
    expect(broker.pendingPreviewCount()).toBe(1);
    expect(broker.revokeItem("vault_entry_1")).toBe(1);
    expect(
      (
        await broker.execute({
          previewId: second.previewId!,
          approvalId: "plugin:approval-1",
          binding: binding(),
        })
      ).status,
    ).toBe("expired");
  });

  it("returns needs_human when the vault is locked", async () => {
    const { broker } = harness({ unlock: false });
    const result = await preview(broker);
    expect(result).toMatchObject({
      status: "needs_human",
      reasonCode: "vault_locked",
      origin: { scheme: "https", host: "login.example.com", port: 443 },
    });
    expect(result.previewId).toBeUndefined();
  });

  it("reports not_found without leaking entry metadata", async () => {
    const { broker, audits } = harness({ entries: [] });
    const result = await preview(broker, { itemRef: "vault_missing" });
    expect(result).toMatchObject({ status: "not_found" });
    expect(result.siteLabel).toBeUndefined();
    expect(audits.at(-1)).toMatchObject({ itemRef: "vault_missing", reasonCode: "not_found" });
  });
});
