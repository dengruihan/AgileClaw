import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import { performGatewaySessionReset } from "./session-reset-service.js";

describe("session reset device scope", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("keeps the row's device scope across a reset of the same node", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:dashboard:scoped-reset";
      const created = await createGatewaySession({
        cfg,
        agentId: "main",
        key,
        commandSource: "test",
        operatorRoleActor: { kind: "system" as const },
        scopeDeviceId: "device-a",
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }

      const reset = await performGatewaySessionReset({
        key,
        agentId: "main",
        reason: "reset",
        commandSource: "gateway",
        workerPlacementContext: { workerSessionPlacementService: { getMany: () => new Map() } },
      });
      expect(reset).toMatchObject({ ok: true });

      const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
      expect(entry).toMatchObject({
        sessionId: created.entry.sessionId,
        scopeDeviceId: "device-a",
      });
    });
  });
});
