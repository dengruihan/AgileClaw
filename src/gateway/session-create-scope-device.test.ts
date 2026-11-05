import { describe, expect, it } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

describe("session creation device scope", () => {
  it("stamps the creating client's verified device on a new root row only", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await state.writeConfig(cfg);
      const create = async (params: { key: string; scopeDeviceId?: string }) => {
        const result = await createGatewaySession({
          cfg,
          agentId: "main",
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
          ...params,
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result;
      };
      const scope = { agentId: "main", sessionKey: "agent:main:dashboard:scoped" };

      await create({ key: scope.sessionKey, scopeDeviceId: "device-a" });
      expect(loadSessionEntry(scope)?.scopeDeviceId).toBe("device-a");

      // Adoption never restamps: the row keeps the device it was created for.
      await create({ key: scope.sessionKey, scopeDeviceId: "device-b" });
      expect(loadSessionEntry(scope)?.scopeDeviceId).toBe("device-a");

      // Absent scope stays gateway-hosted.
      const gatewayKey = "agent:main:dashboard:gateway-hosted";
      await create({ key: gatewayKey });
      expect(loadSessionEntry({ ...scope, sessionKey: gatewayKey })?.scopeDeviceId).toBeUndefined();
    });
  });

  it("inherits a parented row's tree scope instead of the creating client's device", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await state.writeConfig(cfg);
      const create = async (params: {
        key: string;
        parentSessionKey?: string;
        scopeDeviceId?: string;
      }) => {
        const result = await createGatewaySession({
          cfg,
          agentId: "main",
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
          ...params,
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        return result;
      };
      const scope = (sessionKey: string) => ({ agentId: "main", sessionKey });

      const scopedParentKey = "agent:main:dashboard:scoped-parent";
      await create({ key: scopedParentKey, scopeDeviceId: "device-parent" });
      await create({
        key: "agent:main:dashboard:scoped-child",
        parentSessionKey: scopedParentKey,
        scopeDeviceId: "device-requester",
      });
      expect(loadSessionEntry(scope("agent:main:dashboard:scoped-child"))?.scopeDeviceId).toBe(
        "device-parent",
      );

      const gatewayParentKey = "agent:main:dashboard:gateway-parent";
      await create({ key: gatewayParentKey });
      await create({
        key: "agent:main:dashboard:gateway-child",
        parentSessionKey: gatewayParentKey,
        scopeDeviceId: "device-requester",
      });
      expect(
        loadSessionEntry(scope("agent:main:dashboard:gateway-child"))?.scopeDeviceId,
      ).toBeUndefined();
    });
  });
});
