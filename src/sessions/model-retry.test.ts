import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, describe, expect, it } from "vitest";
import { MODEL_RETRY_RECORD_TYPE } from "../../packages/gateway-protocol/src/chat-retry.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readRecentSessionTranscriptActiveEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  createModelRetryReporter,
  settleModelRetryState,
  type ModelRetryReporterState,
} from "./model-retry.js";
import { onSessionTranscriptUpdate } from "./transcript-events.js";
import { createSqliteTranscriptTarget } from "./user-turn-transcript.test-support.js";

describe("model request retry records", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "openclaw-model-retry-");

  it("publishes durable sanitized transitions without adding model context", async () => {
    const dir = dirs.make();
    const target = createSqliteTranscriptTarget({ dir });
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const updates: unknown[] = [];
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const reporter = createModelRetryReporter({
        runId: "retry-run",
        sessionKey: target.sessionKey,
        getTarget: () => target,
        assertCurrent: () => {},
        onAgentEvent: (event) => events.push(event),
      });
      await reporter.retry({
        reason: "server_error",
        status: 503,
        delayMs: 100,
        error: "503 authorization: Bearer sk-synthetic1234567890abcdefghijklmnop",
      });
      await reporter.requesting();
      await reporter.requesting();
      await reporter.retry({ reason: "timeout", error: new Error("upstream timed out") });
      await reporter.finish("recovered");
      expect(events.map((event) => event.data.retry)).toMatchObject([
        {
          id: "retry-run:retry:1",
          number: 1,
          stage: "waiting",
          reason: "server_error",
          status: 503,
        },
        { id: "retry-run:retry:1", number: 1, stage: "requesting" },
        { id: "retry-run:retry:2", number: 2, stage: "requesting", reason: "timeout" },
        { id: "retry-run:retry:2", number: 2, stage: "recovered" },
      ]);
      expect(JSON.stringify(events)).not.toContain("sk-synthetic1234567890abcdefghijklmnop");
      expect(updates).toHaveLength(4);
      expect(readRecentSessionTranscriptActiveEvents(target, 20)).toEqual([]);
      await closeOpenClawAgentDatabasesAsync(dir);
      const messages = (await loadTranscriptEvents(target))
        .map(asOptionalRecord)
        .filter((event) => event?.type === "message")
        .map((event) => event?.message);
      expect(messages).toHaveLength(4);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            customType: MODEL_RETRY_RECORD_TYPE,
            excludeFromContext: true,
            __openclaw: { runId: "retry-run" },
            details: expect.objectContaining({ stage: "recovered", number: 2 }),
          }),
        ]),
      );
      expect(JSON.stringify(messages)).not.toContain("sk-synthetic1234567890abcdefghijklmnop");
    } finally {
      unsubscribe();
    }
  });

  it("reports failed record persistence and never emits after authority is revoked", async () => {
    const target = createSqliteTranscriptTarget({ dir: dirs.make() });
    const events: Array<{ data: Record<string, unknown> }> = [];
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("run retired");
      }
    };
    const state: ModelRetryReporterState = {
      count: 0,
      pendingFailure: {
        reason: "auth",
        error: "unauthorized",
        status: 401,
        code: "invalid_api_key",
      },
    };
    const reporter = createModelRetryReporter({
      state,
      runId: "failed-run",
      sessionKey: target.sessionKey,
      getTarget: () => target,
      assertCurrent,
      onAgentEvent: (event) => {
        events.push(event);
        throw new Error("observer failed");
      },
    });
    await reporter.finish(
      "failed",
      Object.assign(new Error("request failed"), { rawError: "provider denied the API key" }),
    );
    await reporter.finish(
      "failed",
      Object.assign(new Error("request failed"), {
        rawError: "provider denied the API key",
      }),
      "non_retryable",
    );
    expect(events[3]?.data.retry).toMatchObject({
      number: 0,
      stage: "failed",
      reason: "auth",
      status: 401,
      code: "invalid_api_key",
      errorMessage: "provider denied the API key",
      stopReason: "non_retryable",
      persistenceError: expect.any(String),
    });
    revoked = true;
    await expect(reporter.retry({ reason: "timeout" })).rejects.toThrow("run retired");
    expect(events).toHaveLength(4);
  });

  it("settles cancellation under its retained owner and refuses retired authority", async () => {
    const dir = dirs.make();
    const target = createSqliteTranscriptTarget({ dir });
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    let cancelled = false;
    let ownerCurrent = true;
    let targetBroken = false;
    const state: ModelRetryReporterState = { count: 0 };
    const assertTerminalCurrent = () => {
      if (!ownerCurrent) {
        throw new Error("owner retired");
      }
    };
    const reporter = createModelRetryReporter({
      state,
      runId: "cancelled-run",
      sessionKey: target.sessionKey,
      getTarget: () => {
        if (targetBroken) {
          throw new Error("unexpected target failure");
        }
        return target;
      },
      assertCurrent: () => {
        assertTerminalCurrent();
        if (cancelled) {
          throw new Error("request cancelled");
        }
      },
      assertTerminalCurrent,
    });
    state.finish = reporter.finish;
    await reporter.retry({ reason: "timeout", delayMs: 100, error: "upstream deadline exceeded" });
    cancelled = true;
    await expect(reporter.requesting()).rejects.toThrow("request cancelled");
    expect(await settleModelRetryState(state, "aborted")).toBe(true);
    await closeOpenClawAgentDatabasesAsync(dir);
    const messages = (await loadTranscriptEvents(target))
      .map(asOptionalRecord)
      .filter((event) => event?.type === "message")
      .map((event) => event?.message);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ details: { stage: "aborted", number: 1 } });
    ownerCurrent = false;
    expect(await settleModelRetryState(state, "failed", "late model error")).toBe(false);
    expect(
      (await loadTranscriptEvents(target)).filter(
        (event) => asOptionalRecord(event)?.type === "message",
      ),
    ).toHaveLength(2);
    ownerCurrent = true;
    targetBroken = true;
    await expect(settleModelRetryState(state, "failed", "late model error")).rejects.toThrow(
      "unexpected target failure",
    );
  });
});
