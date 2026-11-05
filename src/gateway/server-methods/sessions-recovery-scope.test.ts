import { expect, test } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { recoverGatewaySession } from "../session-recovery-service.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("restart recovery rolls the device scope onto the successor session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sourceKey = "agent:main:dashboard:scoped-recovery";
  const sourceSessionId = "scoped-recovery-source";
  await writeSessionStore({
    entries: {
      [sourceKey]: sessionStoreEntry(sourceSessionId, {
        status: "failed",
        abortedLastRun: true,
        scopeDeviceId: "device-a",
        mainRestartRecovery: {
          cycleId: `cycle-${sourceSessionId}`,
          revision: 1,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId: sourceSessionId,
    sessionKey: sourceKey,
    storePath,
    messages: [{ role: "user", content: "recover the interrupted turn" }],
  });

  const recovered = await recoverGatewaySession({
    cfg: getRuntimeConfig(),
    key: sourceKey,
    agentId: "main",
    workerPlacementContext: {},
    launchContinuation: async () => ({ status: "started", runId: "recovery-proof" }),
  });

  expect(recovered).toMatchObject({ ok: true, created: true });
  if (!recovered.ok || !("successorEntry" in recovered)) {
    throw new Error("recovery did not create a successor session");
  }
  expect(recovered.successorEntry.scopeDeviceId).toBe("device-a");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: recovered.successorKey, storePath })
      ?.scopeDeviceId,
  ).toBe("device-a");
});
