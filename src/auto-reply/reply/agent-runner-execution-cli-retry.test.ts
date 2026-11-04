import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { MODEL_RETRY_RECORD_TYPE } from "../../../packages/gateway-protocol/src/chat-retry.js";
import { FailoverError } from "../../agents/failover-error.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  makeTestSessionStorePath,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: CLI retry history", () => {
  it.each(["recovered", "failed", "aborted"] as const)(
    "commits a CLI fallback's %s outcome before releasing placement",
    async (outcome) => {
      const sessionKey = "agent:main:cli-retry";
      const storePath = makeTestSessionStorePath();
      const entry: SessionEntry = { sessionId: "session", updatedAt: 1 };
      const target = { agentId: "main", sessionId: entry.sessionId, sessionKey, storePath };
      await replaceSessionEntry(target, entry);
      const followupRun = createFollowupRun();
      followupRun.run.provider = "claude-cli";
      followupRun.run.model = "claude-sonnet-4-6";
      state.isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      state.runCliAgentMock.mockRejectedValueOnce(
        new FailoverError("upstream temporarily unavailable", {
          reason: "server_error",
          status: 503,
        }),
      );
      if (outcome === "failed") {
        state.runCliAgentMock.mockRejectedValueOnce(
          new FailoverError("invalid credentials", { reason: "auth_permanent", status: 401 }),
        );
      } else {
        state.runCliAgentMock.mockResolvedValueOnce({
          payloads: [{ text: outcome === "recovered" ? "Recovered answer" : "Partial answer" }],
          meta: outcome === "aborted" ? { aborted: true } : {},
        });
      }
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => {
          await expect(
            params.run("claude-cli", "claude-sonnet-4-6", {
              ...initialFallbackAttemptOptions(params),
              isFinalFallbackAttempt: false,
            }),
          ).rejects.toThrow("upstream temporarily unavailable");
          return {
            result: await params.run("claude-cli", "claude-opus-4-8", {
              ...fallbackAttemptOptions(params, "server_error"),
              isFinalFallbackAttempt: true,
            }),
            provider: "claude-cli",
            model: "claude-opus-4-8",
            attempts: [
              { provider: "claude-cli", model: "claude-sonnet-4-6", reason: "server_error" },
            ],
          };
        },
      );
      let placements = 0;
      let historyBeforeRelease: unknown[] = [];
      const readHistory = async () =>
        (await loadTranscriptEvents(target)).flatMap((transcriptEntry) => {
          const event = asOptionalRecord(transcriptEntry);
          const message = asOptionalRecord(event?.message);
          return event?.type === "message" && message?.customType === MODEL_RETRY_RECORD_TYPE
            ? [message.details]
            : [];
        });
      const uninstall = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed: () => {
          throw new Error("Unexpected compaction");
        },
        executeLocalTurn: async (_claim, runLocal) => {
          const currentPlacement = ++placements;
          try {
            return await runLocal();
          } finally {
            if (currentPlacement === 2) {
              historyBeforeRelease = await readHistory();
            }
          }
        },
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
      });
      try {
        const executeAgentTurn = await getExecuteAgentTurnForTest();
        const result = await executeAgentTurn({
          ...createMinimalRunAgentTurnParams({ followupRun }),
          sessionKey,
          storePath,
          activeSessionStore: { [sessionKey]: entry },
          getActiveSessionEntry: () => entry,
        });
        expect(state.runCliAgentMock).toHaveBeenCalledTimes(2);
        expect(historyBeforeRelease[0]).toMatchObject({
          number: 1,
          stage: "requesting",
          reason: "server_error",
          status: 503,
        });
        expect(historyBeforeRelease.at(-1)).toMatchObject({ number: 1, stage: outcome });
        expect(historyBeforeRelease).toHaveLength(2);
        if (outcome === "failed") {
          expect(historyBeforeRelease.at(-1)).toMatchObject({
            reason: "auth_permanent",
            status: 401,
            stopReason: "non_retryable",
            errorMessage: "invalid credentials",
          });
        } else if (outcome === "recovered") {
          expect(result).toMatchObject({
            kind: "success",
            runResult: { payloads: [{ text: "Recovered answer" }] },
          });
        }
        expect(await readHistory()).toEqual(historyBeforeRelease);
      } finally {
        uninstall();
      }
    },
  );
});
