import { describe, expect, it } from "vitest";
// @vitest-environment node
import type { ModelRetryStatus } from "../../../../packages/gateway-protocol/src/chat-retry.ts";
import { modelRetrySummary } from "./chat-retry.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;

it.each([
  { code: "ECONNRESET", summary: "Network error (ECONNRESET)" },
  { code: "ECONNREFUSED", summary: "Network error (ECONNREFUSED)" },
  { status: 503, summary: "Service temporarily unavailable (HTTP 503)" },
  { code: "ETIMEDOUT", summary: "Request timed out (ETIMEDOUT)" },
])("uses structured transport details for legacy timeout errors ($summary)", (details) => {
  expect(
    modelRetrySummary({
      id: "retry-1",
      number: 1,
      stage: "waiting",
      reason: "timeout",
      errorMessage: "Synthetic provider diagnostic",
      at: 1,
      ...details,
    }),
  ).toBe(details.summary);
});

function createStartupHost() {
  return createHost({
    chatRunId: "run-1",
    chatRunStartup: { state: "status", runId: "run-1", phase: "starting_model" },
    toolStreamSyncTimer: 1,
  });
}

function toolStart(runId: string, toolCallId: string): AgentEvent {
  return {
    runId,
    seq: 1,
    stream: "tool",
    ts: 1,
    sessionKey: "main",
    data: { phase: "start", toolCallId, name: "read", args: {} },
  };
}

describe("app-tool-stream startup status", () => {
  it.each(["tool", "preamble"])("clears the active run status on matching %s activity", (kind) => {
    const host = createStartupHost();

    handleAgentEvent(
      host,
      kind === "tool"
        ? toolStart("run-1", "tool-1")
        : {
            runId: "run-1",
            seq: 1,
            stream: "item",
            ts: 1,
            sessionKey: "main",
            data: { kind: "preamble", itemId: "opening", progressText: "Checking the workspace" },
          },
    );

    expect(host.chatRunStartup).toEqual({ state: "activity", runId: "run-1", seq: 1 });
  });

  it("keeps active status for a tool from another run", () => {
    const host = createStartupHost();

    handleAgentEvent(host, toolStart("run-2", "tool-2"));

    expect(host.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "starting_model",
    });
  });

  it.each(["tool", "preamble", "assistant"])(
    "keeps retry waits transient and ordered across %s progress and delayed replay",
    (kind) => {
      const host = createStartupHost();
      const retry: AgentEvent = {
        runId: "run-1",
        seq: 3,
        stream: "run_status",
        ts: 3,
        sessionKey: "main",
        data: { phase: "retrying", message: "Rate limited. Retrying in 2 seconds (attempt 2/8)." },
      };
      const retryLabel = () =>
        chatStartupStatusLabel(activeChatRunStartupStatus(host.chatRunStartup), null);
      handleAgentEvent(host, toolStart("run-1", "tool-1"));
      handleAgentEvent(host, retry);
      handleAgentEvent(host, { ...retry, runId: "run-other", seq: 4 });
      handleAgentEvent(host, { ...toolStart("run-1", "tool-old"), seq: 2 });
      expect(host.chatRunId).toBe("run-1");
      expect(retryLabel()).toBe(retry.data.message);

      handleAgentEvent(host, {
        ...retry,
        seq: 4,
        stream: kind === "preamble" ? "item" : kind,
        data:
          kind === "tool"
            ? { phase: "start", toolCallId: "tool-next", name: "read" }
            : kind === "preamble"
              ? { kind: "preamble", itemId: "resumed", progressText: "Continuing" }
              : { text: "Continuing" },
      });
      handleAgentEvent(host, retry);
      expect(retryLabel()).toBeUndefined();
      expect(host.chatRunId).toBe("run-1");

      handleAgentEvent(host, { ...retry, seq: 5 });
      expect(retryLabel()).toBe(retry.data.message);
    },
  );
});

it("reconciles structured errors across transports without reviving an older retry", async () => {
  const { handleChatGatewayEvent } = await import("./chat-gateway.ts");
  const { makeChatHost } = await import("./chat-host.test-support.ts");
  const host = makeChatHost({ sessionKey: "main" });
  host.chatRunId = "run-1";
  host.chatStreamStartedAt = 100;
  host.chatStream = "Partial answer stays visible";
  const retry = {
    id: "retry-1",
    number: 1,
    stage: "waiting",
    reason: "server_error",
    status: 503,
    errorMessage: "Upstream temporarily unavailable",
    at: 200,
  } satisfies ModelRetryStatus;
  const label = () => chatStartupStatusLabel(activeChatRunStartupStatus(host.chatRunStartup), null);
  handleChatGatewayEvent(host, {
    sessionKey: "main",
    runId: "run-1",
    state: "status",
    seq: 2,
    retry: { status: retry },
  });
  expect(label()).toBe("Service temporarily unavailable (HTTP 503) · Retry 1 · Waiting to retry");
  handleAgentEvent(host, {
    sessionKey: "main",
    runId: "run-1",
    seq: 2,
    ts: 200,
    stream: "run_status",
    data: {
      phase: "retrying",
      message: "English fallback must not replace the structured summary",
      retry,
    },
  });
  expect(label()).toContain("HTTP 503");
  handleAgentEvent(host, {
    sessionKey: "main",
    runId: "run-1",
    seq: 3,
    ts: 201,
    stream: "run_status",
    data: { phase: "retrying", retry: { ...retry, stage: "requesting", at: 201 } },
  });
  expect(label()).toContain("Retry 1 · Retrying");
  expect(host.chatStreamStartedAt).toBe(100);
  expect(host.chatStream).toBe("Partial answer stays visible");
  handleChatGatewayEvent(host, {
    sessionKey: "main",
    runId: "run-1",
    state: "delta",
    message: { role: "assistant", content: "Partial answer stays visible and resumes" },
  });
  expect(label()).toBeUndefined();
  handleChatGatewayEvent(host, {
    sessionKey: "main",
    runId: "run-1",
    state: "status",
    seq: 2,
    retry: { status: retry },
  });
  expect(label()).toBeUndefined();
});
