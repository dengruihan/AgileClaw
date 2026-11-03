import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VaultFillBroker } from "./vault-fill-broker.js";
import { VaultService } from "./vault-service.js";

const PASSPHRASE = "correct horse battery staple";
const CANARY = "canary-fill-e2e-91b7f3c2";

describe("vault fill with the real vault worker", () => {
  let service: VaultService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("decrypts once for the bound fallback and leaves only value-free evidence", async () => {
    await withOpenClawTestState({ label: "vault-fill-e2e", scenario: "minimal" }, async (state) => {
      service = new VaultService({ env: state.env });
      await service.initialize(PASSPHRASE, 60);
      const entry = await service.create({
        originScheme: "https",
        originHost: "login.example.com",
        originPort: 443,
        siteLabel: "Example Login",
        account: "person@example.com",
        password: CANARY,
        notes: "",
      });

      const approval = {
        snapshot: null as null | {
          status: string;
          decision: string;
          agentId: string;
          sessionKey: string;
          detail: string;
        },
        consumed: false,
      };
      const broker = new VaultFillBroker({
        service,
        approval: {
          getSnapshot: async () => approval.snapshot,
          consumeAllowOnce: async () => {
            if (approval.consumed) {
              return false;
            }
            approval.consumed = true;
            return true;
          },
        },
      });

      const preview = await broker.preview({
        itemRef: entry.itemRef,
        origin: { scheme: "https", host: "login.example.com", port: 443 },
        agentId: "agent-1",
        sessionKey: "agent:main",
        profile: "shared",
        targetId: "target-1",
        documentId: "loader-1",
        frameId: "frame-1",
        fieldSignature: "fields-1",
      });
      expect(preview.status).toBe("needs_approval");
      expect(JSON.stringify(preview)).not.toContain(CANARY);

      approval.snapshot = {
        status: "allowed",
        decision: "allow-once",
        agentId: "agent-1",
        sessionKey: "agent:main",
        detail: `preview: ${preview.previewId}`,
      };
      const binding = {
        itemRef: entry.itemRef,
        revision: entry.revision,
        origin: { scheme: "https" as const, host: "login.example.com", port: 443 },
        agentId: "agent-1",
        sessionKey: "agent:main",
        profile: "shared",
        targetId: "target-1",
        documentId: "loader-1",
        frameId: "frame-1",
        fieldSignature: "fields-1",
      };
      const executed = await broker.execute({
        previewId: preview.previewId!,
        approvalId: "plugin:approval-1",
        binding,
      });
      expect(executed.status).toBe("filled");
      expect(executed.status === "filled" ? executed.material.password : "").toBe(CANARY);

      const replay = await broker.execute({
        previewId: preview.previewId!,
        approvalId: "plugin:approval-1",
        binding,
      });
      expect(replay.status).toBe("replayed");

      const audit = await service.auditList(20);
      expect(audit.filter((event) => event.action === "fill")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded" }),
          expect.objectContaining({ status: "blocked", reasonCode: "replayed" }),
        ]),
      );
      expect(JSON.stringify(audit)).not.toContain(CANARY);
      expect(JSON.stringify(preview)).not.toContain(CANARY);
      expect(JSON.stringify(replay)).not.toContain(CANARY);
    });
  });
});
