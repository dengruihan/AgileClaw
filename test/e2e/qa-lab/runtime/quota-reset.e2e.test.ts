import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ID,
  BACKUP_API_KEY,
  BACKUP_MARKER,
  BACKUP_MODEL,
  BACKUP_RESPONSES_PATH,
  MARKER,
  createQuotaResetFixture,
  installQuotaStateWriteFault,
  syntheticAccessToken,
} from "./quota-reset.test-support.js";

describe.each([
  ["wham", false],
  ["codex_rate_limits", false],
  ["wham", true],
] as const)("Gateway quota reset (%s, expired=%s)", (source, expiresDuringBlock) => {
  it(
    "recovers the next chat after upstream capacity returns without admitting exhausted or revoked auth",
    { timeout: 600_000 },
    async (context) => {
      const { provider, sessionKey, access, advanceClock, clock, stats, evidence, turn } =
        await createQuotaResetFixture(context, {
          source,
          expiresDuringBlock,
        });
      expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
      const quotaSessions =
        source === "codex_rate_limits"
          ? [sessionKey, `agent:main:quota-${randomUUID()}`, `agent:main:quota-${randomUUID()}`]
          : [sessionKey];
      for (const key of quotaSessions.slice(1)) {
        expect(await turn(key), evidence()).toEqual({ status: "ok", output: [MARKER] });
      }
      provider.setPhase("initial-exhaustion");
      for (const blocked of await Promise.all(quotaSessions.map((key) => turn(key)))) {
        expect(blocked.status, evidence()).toBe("error");
        expect(blocked.output, evidence()).not.toContain(MARKER);
      }
      expect(stats(), evidence()).toMatchObject({
        blockedSource: source,
        blockedReason: "subscription_limit",
      });
      expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);

      if (source === "codex_rate_limits") {
        const originalGeneration = stats();
        expect(originalGeneration?.lastFailureAt, evidence()).toEqual(expect.any(Number));
        expect(originalGeneration?.failureCounts?.rate_limit, evidence()).toBeGreaterThan(0);
        for (const phase of [
          "additional-exhaustion",
          "workspace-exhaustion",
          "spending-exhaustion",
          "malformed-usage",
        ] as const) {
          provider.setPhase(phase);
          await advanceClock();
          const additionalLimitTurn = await turn();
          expect(additionalLimitTurn.status, evidence()).toBe("error");
          expect(additionalLimitTurn.output, evidence()).not.toContain(MARKER);
          const retained = stats();
          expect(retained?.blockedReason, evidence()).toBe("subscription_limit");
          expect(retained?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + clock.offset);
          expect(retained?.lastFailureAt, evidence()).toBe(originalGeneration?.lastFailureAt);
          expect(retained?.failureCounts, evidence()).toEqual(originalGeneration?.failureCounts);
          const additionalLimitRequests = provider.requests.filter(
            (request) => request.phase === phase,
          );
          expect(
            additionalLimitRequests.filter((request) => request.path === "/core-wham/usage"),
            evidence(),
          ).not.toHaveLength(0);
          // A fresh exhausted bucket must not become another failed inference attempt.
          expect(
            additionalLimitRequests.filter(
              (request) => request.transport === "websocket" || request.path.endsWith("/responses"),
            ),
            evidence(),
          ).toEqual([]);
        }
      }

      provider.setPhase("exhausted");
      if (!expiresDuringBlock) {
        await advanceClock();
      }
      const exhaustedTurn = await turn();
      expect(exhaustedTurn.status, evidence()).toBe("error");
      expect(exhaustedTurn.output, evidence()).not.toContain(MARKER);
      expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + clock.offset);

      provider.setPhase("restored");
      const earlyRetry = await turn();
      expect(earlyRetry.status, evidence()).toBe("error");
      expect(earlyRetry.output, evidence()).not.toContain(MARKER);
      expect(
        provider.requests.filter(
          (request) => request.phase === "restored" && request.path === "/core-wham/usage",
        ),
        evidence(),
      ).toEqual([]);
      await advanceClock();
      expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
      expect(stats()?.blockedUntil, evidence()).toBeUndefined();
      if (expiresDuringBlock) {
        const refreshRequests = provider.requests.filter(
          (request) => request.path === "/oauth/token",
        );
        expect(refreshRequests, evidence()).toHaveLength(1);
        expect(refreshRequests[0]?.body, evidence()).toContain("synthetic-refresh");
      }
      expect(
        provider.requests.filter(
          (request) => request.phase === "restored" && request.path === "/core-wham/usage",
        ),
        evidence(),
      ).not.toHaveLength(0);
      expect(
        provider.requests.filter(
          (request) => request.phase === "restored" && request.path.endsWith("/responses"),
        ),
        evidence(),
      ).not.toHaveLength(0);

      provider.setPhase("revoked");
      const revoked = await turn();
      expect(revoked.status, evidence()).toBe("error");
      expect(revoked.output, evidence()).not.toContain(MARKER);
      await advanceClock();
      const revokedAgain = await turn();
      expect(revokedAgain.status, evidence()).toBe("error");
      expect(revokedAgain.output, evidence()).not.toContain(MARKER);
      for (const request of provider.requests.filter(
        (entry) => entry.path.endsWith("/responses") || entry.path === "/core-wham/usage",
      )) {
        const refreshed =
          expiresDuringBlock && (request.phase === "restored" || request.phase === "revoked");
        // The native process retains its real clock and may reuse the bound session's token.
        if (refreshed && request.path.endsWith("/responses")) {
          expect([`Bearer ${access}`, `Bearer ${syntheticAccessToken()}`], evidence()).toContain(
            request.authorization,
          );
          expect(request.accountId, evidence()).toBe(ACCOUNT_ID);
        } else {
          expect(request.authorization, evidence()).toBe(
            `Bearer ${refreshed ? syntheticAccessToken() : access}`,
          );
        }
      }
      for (const request of provider.requests.filter(
        (entry) => entry.path === "/core-wham/usage",
      )) {
        expect(request.accountId, evidence()).toBe(ACCOUNT_ID);
      }
      expect(provider.errors, evidence()).toEqual([]);
    },
  );
});

describe.each([
  { write: "claim", failure: "io" },
  { write: "result", failure: "io" },
  { write: "claim", failure: "constraint" },
] as const)("Quota $write write $failure failure", ({ write, failure }) => {
  it.skipIf(process.platform === "win32")(
    "preserves healthy fallback for operational writes and refuses constraint failures through chat.send",
    { timeout: 600_000 },
    async (context) => {
      const { client, provider, gateway, turn, stats, evidence, advanceClock, storageFaultFile } =
        await createQuotaResetFixture(context, {
          source: "codex_rate_limits",
          includeBackup: true,
          limitGatewayFileSize: true,
        });
      expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });

      const directBackupSession = `agent:main:quota-backup-${randomUUID()}`;
      await client.request("sessions.patch", { key: directBackupSession, model: BACKUP_MODEL });
      expect(await turn(directBackupSession), evidence()).toEqual({
        status: "ok",
        output: [BACKUP_MARKER],
      });

      provider.setPhase("initial-exhaustion");
      const initialFallback = await turn(`agent:main:quota-initial-fallback-${randomUUID()}`);
      expect(initialFallback.status, evidence()).toBe("ok");
      expect(initialFallback.output, evidence()).toContain(BACKUP_MARKER);
      expect(stats(), evidence()).toMatchObject({
        blockedSource: "codex_rate_limits",
        blockedReason: "subscription_limit",
      });
      const blockedUntil = stats()?.blockedUntil;
      expect(blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);

      provider.setPhase("restored");
      await advanceClock();
      const fault = await installQuotaStateWriteFault(gateway, storageFaultFile, write, failure);
      try {
        expect(
          await turn(directBackupSession, `Direct backup before ${write} I/O failure.`),
          evidence(),
        ).toEqual({ status: "ok", output: [BACKUP_MARKER] });
        const beforeFault = provider.requests.length;
        const prompt = `Ordinary chat during the quota ${write} write ${failure} failure.`;
        // A new ordinary session uses configured primary/fallback order instead
        // of a previous turn's automatic model preference.
        const fallback = await turn(`agent:main:quota-storage-fallback-${randomUUID()}`, prompt);
        const backupAfterFault = await turn(
          directBackupSession,
          `Direct backup after ${write} I/O failure.`,
        );

        expect(gateway.logs(), evidence()).toContain(
          failure === "io" ? "disk I/O error" : "quota test constraint invariant",
        );
        expect(gateway.logs(), evidence()).toContain(`errcode: ${failure === "io" ? 778 : 1811}`);
        expect(fault.scratchCommitted(), evidence()).toBe(false);
        expect(backupAfterFault, evidence()).toEqual({ status: "ok", output: [BACKUP_MARKER] });
        expect(fallback.status, evidence()).toBe(failure === "io" ? "ok" : "error");
        if (failure === "io") {
          expect(fallback.output, evidence()).toContain(BACKUP_MARKER);
        } else {
          expect(fallback.output, evidence()).not.toContain(BACKUP_MARKER);
        }
        const faultRequests = provider.requests.slice(beforeFault);
        expect(
          faultRequests.filter(
            (request) =>
              request.path !== BACKUP_RESPONSES_PATH &&
              (request.transport === "websocket" || request.path.endsWith("/responses")),
          ),
          evidence(),
        ).toEqual([]);
        expect(
          faultRequests.filter((request) => request.path === "/core-wham/usage"),
          evidence(),
        ).toHaveLength(write === "claim" ? 0 : 1);
        const fallbackRequests = faultRequests.filter((request) => request.body?.includes(prompt));
        if (failure === "io") {
          expect(fallbackRequests, evidence()).toContainEqual(
            expect.objectContaining({
              path: BACKUP_RESPONSES_PATH,
              authorization: `Bearer ${BACKUP_API_KEY}`,
            }),
          );
        } else {
          expect(fallbackRequests, evidence()).toEqual([]);
        }
        expect(stats(), evidence()).toMatchObject({
          blockedReason: "subscription_limit",
          blockedUntil,
        });
        expect(provider.errors, evidence()).toEqual([]);
      } finally {
        await fault.remove();
      }
      await advanceClock();
      expect(await turn(`agent:main:quota-after-fault-${randomUUID()}`), evidence()).toEqual({
        status: "ok",
        output: [MARKER],
      });
      expect(stats()?.blockedUntil, evidence()).toBeUndefined();
    },
  );
});
