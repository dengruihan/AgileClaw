import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import {
  MAX_TURN_CONTEXT_CONTRIBUTION_CHARS,
  assertAttemptTurnContextCarriersCurrent,
  TURN_CONTEXT_CUSTOM_TYPE,
  drainAttemptTurnContextContributionsForModelRequest,
  ensureAttemptTurnContextManager,
  forgetAttemptTurnContextManager,
  markAttemptTurnContextCarriers,
  observeAttemptTurnContextAssistantText,
  readAttemptTurnContextReceiptCounts,
  resolveAttemptTurnContextTerminalContinuation,
  rotateAttemptTurnContextForSteeringInput,
} from "./attempt-turn-context.js";

const RUN_ID = "turn-context-test-run";

type Publish = (contribution: { id: string; text: string }) => {
  status: string;
  id?: string;
};

type AttachedHarness = {
  publish: Publish;
  onAssistantText: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

const INPUT_ID = "input-a";

/** Attaches a source whose scope publish and callbacks are test-observable. */
function attachHarness(
  manager: NonNullable<ReturnType<typeof ensureAttemptTurnContextManager>>,
  key: string,
  options?: { terminalWaitMs?: number; publishDuringFlush?: string; inputId?: string },
): AttachedHarness {
  const onAssistantText = vi.fn();
  const flush = vi.fn<(deadlineAtMs: number) => Promise<void>>(async () => {});
  const dispose = vi.fn(async () => {});
  let publish: Publish | undefined;
  const outcome = manager.attach(
    { key, inputId: options?.inputId ?? INPUT_ID, assertAuthority: () => {}, ...options },
    (scope) => {
      publish = (contribution) => scope.publish(contribution) as ReturnType<Publish>;
      return {
        onAssistantText,
        async flush(deadlineAtMs: number) {
          await flush(deadlineAtMs);
          if (options?.publishDuringFlush) {
            scope.publish({
              id: options.publishDuringFlush,
              text: "late material",
            });
          }
        },
        dispose,
      };
    },
  );
  expect(outcome).toEqual({ status: "attached" });
  return { publish: publish!, onAssistantText, flush, dispose };
}

async function withManager(
  run: (
    manager: NonNullable<ReturnType<typeof ensureAttemptTurnContextManager>>,
  ) => void | Promise<void>,
): Promise<void> {
  const manager = ensureAttemptTurnContextManager(RUN_ID, INPUT_ID);
  assert(manager);
  try {
    await run(manager);
  } finally {
    await forgetAttemptTurnContextManager(RUN_ID);
  }
}

describe("attempt turn-context contributions", () => {
  it("attaches once per key and rejects attaches after the terminal gate ran", async () => {
    await withManager((manager) => {
      attachHarness(manager, "same-key");
      const second = manager.attach({ key: "same-key", assertAuthority: () => {} }, () => ({
        async flush() {},
        async dispose() {},
      }));
      expect(second).toEqual({ status: "already-attached" });
    });
    await withManager(async (manager) => {
      await resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => false,
        sendFollowUp: async () => {},
      });
      const afterGate = manager.attach({ key: "fresh-key", assertAuthority: () => {} }, () => ({
        async flush() {},
        async dispose() {},
      }));
      expect(afterGate).toEqual({ status: "unsupported" });
    });
  });

  it("publishes with duplicate and budget rejection, then drains one batch exactly once", async () => {
    await withManager((manager) => {
      const { publish } = attachHarness(manager, "publisher");
      expect(publish({ id: "m1", text: "memory one" })).toEqual({
        status: "queued",
        id: "m1",
      });
      expect(publish({ id: "m1", text: "memory one" }).status).toBe("duplicate");
      expect(
        publish({
          id: "m2",
          text: "x".repeat(MAX_TURN_CONTEXT_CONTRIBUTION_CHARS + 1),
        }).status,
      ).toBe("budget-exceeded");
      const carriers = drainAttemptTurnContextContributionsForModelRequest(RUN_ID);
      expect(carriers).toHaveLength(1);
      const carrier = carriers[0]!;
      expect(carrier.pluginKey).toBe("publisher");
      expect(carrier.contributionId).toBe("m1");
      expect(carrier.message.customType).toBe(TURN_CONTEXT_CUSTOM_TYPE);
      expect(carrier.message.content).toBe("memory one");
      expect(carrier.message.display).toBe(false);
      // The boundary consumed the batch; later publishes wait for the next one.
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)).toEqual([]);
      expect(publish({ id: "m3", text: "late memory" }).status).toBe("queued");
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)).toHaveLength(1);
    });
  });

  it("fans projected assistant text out to live sources", async () => {
    await withManager((manager) => {
      const { onAssistantText } = attachHarness(manager, "text");
      observeAttemptTurnContextAssistantText(RUN_ID, {
        text: "hello",
        kind: "append",
      });
      expect(onAssistantText).toHaveBeenCalledWith({
        text: "hello",
        kind: "append",
      });
    });
  });

  it("continues the turn once for unconsumed material, then finalizes later gates", async () => {
    await withManager(async (manager) => {
      const { publish } = attachHarness(manager, "gate", {
        terminalWaitMs: 25,
      });
      expect(publish({ id: "g1", text: "material" }).status).toBe("queued");
      const sent: unknown[][] = [];
      const first = await resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => true,
        sendFollowUp: async (messages) => {
          sent.push(messages);
        },
      });
      expect(first).toBe("continue");
      expect(sent).toHaveLength(1);
      expect((sent[0] as unknown[]).length).toBe(1);
      const second = await resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => true,
        sendFollowUp: async () => {
          throw new Error("must not send twice");
        },
      });
      expect(second).toBe("finalize");
    });
  });

  it("flushes before deciding, counts material published during flush, and respects failed guards", async () => {
    await withManager(async (manager) => {
      const { flush } = attachHarness(manager, "flushed", {
        terminalWaitMs: 40,
        publishDuringFlush: "late-id",
      });
      const outcome = await resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => false,
        sendFollowUp: async () => {
          throw new Error("guards failed; follow-up must not send");
        },
      });
      expect(outcome).toBe("finalize");
      expect(flush).toHaveBeenCalledTimes(1);
      expect(Number(flush.mock.calls[0]?.[0])).toBeGreaterThan(Date.now() - 1);
      // Guards failed: queued material stays unclaimed and the input is closed.
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)).toEqual([]);
    });
  });

  it("continues for material that only arrived during the flush window", async () => {
    await withManager(async (manager) => {
      attachHarness(manager, "late", {
        terminalWaitMs: 25,
        publishDuringFlush: "during-flush",
      });
      const sent: unknown[][] = [];
      const outcome = await resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => true,
        sendFollowUp: async (messages) => {
          sent.push(messages);
        },
      });
      expect(outcome).toBe("continue");
      expect((sent[0] as unknown[]).length).toBe(1);
    });
  });

  it("closes publishes and disposes sources at run settlement", async () => {
    const manager = ensureAttemptTurnContextManager(RUN_ID, INPUT_ID);
    assert(manager);
    const { publish, dispose } = attachHarness(manager, "bye");
    expect(publish({ id: "b1", text: "x" }).status).toBe("queued");
    await forgetAttemptTurnContextManager(RUN_ID);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(publish({ id: "b2", text: "y" }).status).toBe("closed");
    // A settled run id admits a fresh manager for its next input.
    expect(ensureAttemptTurnContextManager(RUN_ID, INPUT_ID)).toBeDefined();
    await forgetAttemptTurnContextManager(RUN_ID);
  });

  it("rotates inputs: the old source closes, retries keep state, stale attach fails", async () => {
    await withManager((manager) => {
      attachHarness(manager, "same-key");
      // Same-input re-entry reports already-attached (parallel stays selected).
      const reentry = manager.attach(
        { key: "same-key", inputId: INPUT_ID, assertAuthority: () => {} },
        () => ({ async flush() {}, async dispose() {} }),
      );
      expect(reentry).toEqual({ status: "already-attached" });
    });
    await withManager(async (manager) => {
      const { publish, dispose, onAssistantText } = attachHarness(manager, "a");
      expect(publish({ id: "p1", text: "x" }).status).toBe("queued");
      expect(onAssistantText).not.toHaveBeenCalled();
      // A different admitted input rotates: the previous input closes.
      manager.rotateInput("input-b");
      expect(publish({ id: "p2", text: "y" }).status).toBe("closed");
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)).toEqual([]);
      // The old input cannot re-attach into the rotated manager.
      const stale = manager.attach(
        { key: "a", inputId: "input-a", assertAuthority: () => {} },
        () => ({ async flush() {}, async dispose() {} }),
      );
      expect(stale).toEqual({ status: "unsupported" });
      // The new input can attach and observe.
      attachHarness(manager, "b", { inputId: "input-b" });
      expect(onAssistantText).not.toHaveBeenCalled();
      observeAttemptTurnContextAssistantText(RUN_ID, { text: "hi", kind: "append" });
      expect(dispose).toHaveBeenCalled();
    });
  });

  it.each(["queued", "terminal"] as const)(
    "drops only revoked sources at the %s boundary",
    async (stage) => {
      await withManager(async (manager) => {
        let authorized = true;
        const flush = vi.fn<(deadlineAtMs: number) => Promise<void>>(async () => {});
        const dispose = vi.fn(async () => {});
        let publishRef: Publish | undefined;
        if (stage === "terminal") {
          const live = attachHarness(manager, "live");
          live.publish({ id: "live", text: "still authorized" });
        }
        manager.attach(
          {
            key: "revoked",
            inputId: INPUT_ID,
            assertAuthority: () => {
              if (!authorized) {
                throw new Error("authority revoked");
              }
            },
          },
          (scope) => {
            publishRef = (contribution) => scope.publish(contribution) as ReturnType<Publish>;
            return {
              async flush(deadlineAtMs: number) {
                await flush(deadlineAtMs);
              },
              dispose,
            };
          },
        );
        expect(publishRef!({ id: "r1", text: "material" }).status).toBe("queued");
        if (stage === "terminal") {
          await resolveAttemptTurnContextTerminalContinuation({
            runId: RUN_ID,
            canContinue: () => true,
            sendFollowUp: async () => {},
          });
        }
        authorized = false;
        const carriers = drainAttemptTurnContextContributionsForModelRequest(RUN_ID);
        expect(carriers.map((carrier) => carrier.contributionId)).toEqual(
          stage === "terminal" ? ["live"] : [],
        );
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ dropped: 1 });
        // Re-authorized publish still works, but the source was stopped by the drop.
        authorized = true;
        expect(publishRef!({ id: "r2", text: "later" }).status).toBe("closed");
        expect(dispose).not.toHaveBeenCalled();
      });
    },
  );

  it("reports settled receipts and drop reasons across input rotation without rewriting terminal receipts", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      await withManager(async (manager) => {
        const { publish } = attachHarness(manager, "receipts");
        expect(publish({ id: "c1", text: "material" }).status).toBe("queued");
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ queued: 1 });
        const carriers = drainAttemptTurnContextContributionsForModelRequest(RUN_ID);
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ leased: 1 });
        markAttemptTurnContextCarriers(RUN_ID, carriers, "installed");
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ installed: 1 });
        markAttemptTurnContextCarriers(RUN_ID, carriers, "submitted");
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ submitted: 1 });
        // Submitted is terminal: a late drop or re-install cannot rewrite it.
        markAttemptTurnContextCarriers(RUN_ID, carriers, "dropped", "late-revoke");
        markAttemptTurnContextCarriers(RUN_ID, carriers, "installed");
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ submitted: 1 });
        // Unknown carriers for missing sources are inert.
        markAttemptTurnContextCarriers(
          RUN_ID,
          [{ ...carriers[0]!, pluginKey: "missing", contributionId: "x" }],
          "installed",
        );
        expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({ submitted: 1 });

        publish({ id: "c2", text: "private rejected material" });
        const rejected = drainAttemptTurnContextContributionsForModelRequest(RUN_ID);
        markAttemptTurnContextCarriers(RUN_ID, rejected, "dropped", "token-budget");
        publish({ id: "c-private", text: "private failure material" });
        markAttemptTurnContextCarriers(
          RUN_ID,
          drainAttemptTurnContextContributionsForModelRequest(RUN_ID),
          "dropped",
          "private failure reason",
        );
        publish({ id: "c3", text: "private retired material" });
        manager.rotateInput("input-b");
        const next = attachHarness(manager, "receipts", { inputId: "input-b" });
        next.publish({ id: "c4", text: "private unsettled material" });
      });
      expect(info).toHaveBeenCalledTimes(1);
      const summary = String(info.mock.calls[0]?.[0]);
      expect(summary).toContain("accepted=5");
      expect(summary).toContain("submitted=1");
      expect(summary).toContain("dropped=4");
      expect(summary).toContain('"token-budget":1');
      expect(summary).toContain('"input-closed":1');
      expect(summary).toContain('"run-settled":1');
      expect(summary).toContain('"other":1');
      expect(summary).not.toContain("late-revoke");
      expect(summary).not.toContain("private");
    } finally {
      info.mockRestore();
    }
  });

  it("steering rotation with a real identity closes the old input and admits a new source", async () => {
    await withManager(async (manager) => {
      const { publish } = attachHarness(manager, "a");
      expect(publish({ id: "s1", text: "x" }).status).toBe("queued");
      rotateAttemptTurnContextForSteeringInput(RUN_ID, "steered-b");
      // The previous input's queued material and publishes are gone.
      expect(publish({ id: "s2", text: "y" }).status).toBe("closed");
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)).toEqual([]);
      expect(manager.currentInputId).toBe("steered-b");
      // The steered input's own preparation boundary attaches fresh.
      attachHarness(manager, "b", { inputId: "steered-b" });
    });
  });

  it("steering rotation without an identity closes without inventing one", async () => {
    await withManager(async (manager) => {
      attachHarness(manager, "a");
      rotateAttemptTurnContextForSteeringInput(RUN_ID, undefined);
      expect(manager.currentInputId).toBe(INPUT_ID);
      const afterClose = manager.attach(
        { key: "b", inputId: INPUT_ID, assertAuthority: () => {} },
        () => ({ async flush() {}, async dispose() {} }),
      );
      expect(afterClose).toEqual({ status: "unsupported" });
    });
  });
  it("rejects an A lease after B reuses the same source and contribution keys", async () => {
    await withManager(async (manager) => {
      const a = attachHarness(manager, "shared");
      a.publish({ id: "same", text: "A material" });
      const leasedA = drainAttemptTurnContextContributionsForModelRequest(RUN_ID);
      manager.rotateInput("input-b");
      const b = attachHarness(manager, "shared", { inputId: "input-b" });
      b.publish({ id: "same", text: "B material" });
      expect(assertAttemptTurnContextCarriersCurrent(RUN_ID, leasedA)).toBe(false);
      markAttemptTurnContextCarriers(RUN_ID, leasedA, "submitted");
      expect(readAttemptTurnContextReceiptCounts(RUN_ID)).toMatchObject({
        queued: 1,
        dropped: 1,
        submitted: 0,
      });
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)[0]?.message.content).toBe(
        "B material",
      );
    });
  });

  it("does not close B when A's terminal flush settles after input rotation", async () => {
    await withManager(async (manager) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a = attachHarness(manager, "a");
      a.flush.mockReturnValue(pending);
      a.publish({ id: "a", text: "A material" });
      const sendFollowUp = vi.fn(async () => {});
      const decision = resolveAttemptTurnContextTerminalContinuation({
        runId: RUN_ID,
        canContinue: () => true,
        sendFollowUp,
      });
      manager.rotateInput("input-b");
      const b = attachHarness(manager, "b", { inputId: "input-b" });
      release();
      expect(await decision).toBe("finalize");
      expect(sendFollowUp).not.toHaveBeenCalled();
      expect(b.publish({ id: "b", text: "B material" }).status).toBe("queued");
      expect(drainAttemptTurnContextContributionsForModelRequest(RUN_ID)[0]?.message.content).toBe(
        "B material",
      );
    });
  });
});
