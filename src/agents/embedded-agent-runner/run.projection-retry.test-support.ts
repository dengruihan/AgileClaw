import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_RETRY_RECORD_TYPE } from "../../../packages/gateway-protocol/src/chat-retry.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let agentDatabase: typeof import("../../state/openclaw-agent-db.js");
let agentDatabaseTest: typeof import("../../state/openclaw-agent-db.test-support.js");
let sessionAccessor: typeof import("../../config/sessions/session-accessor.js");
let activeEvents: typeof import("../../config/sessions/session-accessor.sqlite-active-events.js");
let sqliteScope: typeof import("../../config/sessions/session-accessor.sqlite-scope.js");
let reconcile: typeof import("../../config/sessions/session-transcript-reconcile.js");
let modelContext: typeof import("../../config/sessions/session-accessor.sqlite-model-context.js");

describe("runEmbeddedAgent transcript projection retry", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    agentDatabase = await import("../../state/openclaw-agent-db.js");
    agentDatabaseTest = await import("../../state/openclaw-agent-db.test-support.js");
    sessionAccessor = await import("../../config/sessions/session-accessor.js");
    activeEvents = await import("../../config/sessions/session-accessor.sqlite-active-events.js");
    sqliteScope = await import("../../config/sessions/session-accessor.sqlite-scope.js");
    reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
    modelContext = await import("../../config/sessions/session-accessor.sqlite-model-context.js");
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.projection-retry" });
  });

  afterEach(async () => {
    await state?.cleanup();
    expect(
      agentDatabaseTest
        .listOpenClawAgentDatabasesForTest()
        .filter((database) => database.path.startsWith(`${state.stateDir}${path.sep}`)),
    ).toEqual([]);
    await expect(fs.stat(state.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles an owned compacted retry before durable reopen while ordinary reads stay fail-fast", async () => {
    const sessionId = "projection-retry-session";
    const sessionKey = "agent:main:projection-retry";
    const storePath = state.statePath("alternate", "sessions.json");
    const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
    await sessionAccessor.persistSessionTranscriptTurn(sessionTarget, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const seedContext = modelContext.readSessionTranscriptContextMessages(
      sessionTarget,
      (messages) => [...messages],
    );
    expect(seedContext).toMatchObject([{ role: "user", content: "seed" }]);
    const databaseOptions = sqliteScope.toDatabaseOptions(
      sqliteScope.resolveSqliteTranscriptReadScope(sessionTarget),
    );
    const controller = new AbortController();
    const originalWaitForProjection = reconcile.waitForSessionTranscriptProjection;
    let ownedProjectionSettled = false;
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockImplementation(async (scope, abortSignal) => {
        await originalWaitForProjection(scope, abortSignal);
        expect(
          agentDatabase
            .openOpenClawAgentDatabase(databaseOptions)
            .db.prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ needs_rebuild: 0 });
        ownedProjectionSettled = true;
      });

    try {
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            timedOut: true,
            sessionIdUsed: sessionId,
            lastAssistant: { usage: { input: 160_000 } } as never,
          }),
        )
        .mockImplementationOnce(async () => {
          expect(ownedProjectionSettled).toBe(true);
          const retryPage = activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
            maxMessages: 2,
            offset: 0,
            offsetFrom: "start",
          });
          expect(retryPage.totalMessages).toBe(2);
          expect(retryPage.events.map(({ event }) => event)).toMatchObject([
            { id: "seed", message: { role: "user", content: "seed" } },
            {
              message: {
                customType: MODEL_RETRY_RECORD_TYPE,
                excludeFromContext: true,
                details: { number: 1, stage: "requesting", reason: "timeout" },
              },
            },
          ]);
          expect(
            modelContext.readSessionTranscriptContextMessages(sessionTarget, (messages) => [
              ...messages,
            ]),
          ).toEqual(seedContext);
          return makeAttemptResult({ sessionIdUsed: sessionId });
        });
      mockedCompactDirect.mockImplementationOnce(async () => {
        const database = agentDatabase.openOpenClawAgentDatabase(databaseOptions);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(sessionId);

        expect(() =>
          activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
            maxMessages: 1,
            offset: 0,
          }),
        ).toThrow(activeEvents.SessionTranscriptProjectionUnavailableError);
        reconcile.startSessionTranscriptIndexReconcile({
          ...databaseOptions,
          preferredSessionId: sessionId,
        });
        return makeCompactionSuccess({
          summary: "compacted before projection retry",
          tokensBefore: 160_000,
          tokensAfter: 60_000,
        });
      });

      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-owned-projection-retry",
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget,
        abortSignal: controller.signal,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(waitForProjection).toHaveBeenCalledOnce();
      expect(waitForProjection).toHaveBeenCalledWith(
        { ...sessionTarget, expectedWriterRunId: "run-owned-projection-retry" },
        expect.any(AbortSignal),
      );
      agentDatabase.closeOpenClawAgentDatabaseByPath(
        agentDatabase.resolveOpenClawAgentSqlitePath(databaseOptions),
      );
      const reopenedPage = activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
        maxMessages: 3,
        offset: 0,
        offsetFrom: "start",
      });
      expect(reopenedPage.totalMessages).toBe(3);
      expect(reopenedPage.events.map(({ event }) => event)).toMatchObject([
        { id: "seed", message: { role: "user", content: "seed" } },
        {
          message: {
            customType: MODEL_RETRY_RECORD_TYPE,
            excludeFromContext: true,
            details: { number: 1, stage: "requesting" },
          },
        },
        {
          message: {
            customType: MODEL_RETRY_RECORD_TYPE,
            excludeFromContext: true,
            details: { number: 1, stage: "recovered" },
          },
        },
      ]);
      expect(
        modelContext.readSessionTranscriptContextMessages(sessionTarget, (messages) => [
          ...messages,
        ]),
      ).toEqual(seedContext);
      const cancellation = new Error("caller stopped projection work");
      controller.abort(cancellation);
      expect(waitForProjection.mock.calls[0]?.[1]?.reason).toBe(cancellation);
    } finally {
      waitForProjection.mockRestore();
      await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
  });
});
