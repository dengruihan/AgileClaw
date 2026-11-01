import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { FailoverError } from "../failover-error.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildAgentRuntimePlan,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent retry-limit metadata", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.retry-limit" });
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each([false, true])(
    "reports the latest physical attempt after ordinary retry-budget exhaustion (fallback=%s)",
    async (fallback) => {
      let physicalAttempt = 0;
      mockedBuildAgentRuntimePlan.mockImplementation(() => {
        physicalAttempt += 1;
        const isLatestAttempt = physicalAttempt === 32;
        return {
          resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
          auth: {
            authProfileProviderForAuth: "openai",
            providerForAuth: "openai",
            credentialSource: isLatestAttempt
              ? {
                  kind: "direct",
                  evidence: "environment",
                  authorization: "ambient",
                }
              : { kind: "profile" },
          },
          observability: {
            resolvedRef: "openai/gpt-5.6-luna",
            provider: "openai",
            modelId: "gpt-5.6-luna",
            harnessId: "codex",
          },
        } as never;
      });
      const accepted = {
        runId: "collector-before-retry",
        childSessionKey: "agent:main:subagent:collector",
        expectsCompletionMessage: false,
      };
      mockedRunEmbeddedAttempt.mockImplementation(async () => {
        if (physicalAttempt === 32) {
          const assistant = makeAssistantMessageFixture({
            provider: "openai",
            model: "gpt-5.6-luna",
            stopReason: "error",
            content: [],
            errorMessage: "HTTP 503: service unavailable",
          });
          return makeAttemptResult({
            promptError: new FailoverError("HTTP 503: service unavailable", {
              reason: "server_error",
              status: 503,
            }),
            promptErrorSource: "prompt",
            assistantTexts: [],
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
          });
        }
        return makeAttemptResult({
          acceptedSessionSpawns: physicalAttempt === 1 ? [accepted] : [],
          preflightRecovery: {
            route: "truncate_tool_results_only",
            source: "mid-turn",
            handled: true,
            truncatedCount: 0,
          },
        });
      });

      const onAgentEvent = vi.fn();
      const execution = runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.6-luna",
        runId: "run-retry-limit-physical-attempt-meta",
        modelFallbacksOverride: fallback ? ["openai/fallback-test-model"] : [],
        onAgentEvent,
      });

      const result = fallback ? undefined : await execution;
      if (fallback) {
        await expect(execution).rejects.toThrow("Exceeded retry limit");
      }
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
      if (result) {
        expect(result.meta.error?.kind).toBe("retry_limit");
      }
      const terminalRetry = onAgentEvent.mock.calls
        .map(([event]) => event.data.retry)
        .findLast((retry) => retry?.stage === "failed");
      expect([
        ...new Set(
          onAgentEvent.mock.calls
            .map(([event]) => event.data.retry)
            .filter((retry) => retry?.stage === "waiting" || retry?.stage === "requesting")
            .map((retry) => retry.number),
        ),
      ]).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
      expect(terminalRetry).toMatchObject({
        number: 31,
        status: 503,
        errorMessage: "HTTP 503: service unavailable",
        stopReason: "exhausted",
      });
      if (!result) {
        return;
      }
      expect(result.acceptedSessionSpawns).toEqual([accepted]);
      expect(result.meta.agentMeta).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      });
      expect(Object.keys(result.meta.agentMeta?.credentialSource ?? {}).toSorted()).toEqual([
        "authorization",
        "evidence",
        "kind",
      ]);
    },
  );
});
