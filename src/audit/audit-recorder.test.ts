import { afterEach, describe, expect, it } from "vitest";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { AuditEventWriter } from "./audit-event-writer.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { emitTrustedMessageAuditEvent } from "./message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "./message-audit-events.test-support.js";
import {
  clearToolActionDeviceScopesForTest,
  publishToolActionDeviceScope,
} from "./tool-action-device-scope.js";

afterEach(() => {
  clearToolActionDeviceScopesForTest();
});

function captureWriter(inputs: AuditEventInput[]): AuditEventWriter {
  return {
    ready: Promise.resolve(),
    record: (input) => {
      inputs.push(input);
      return true;
    },
    recordExecutionIdentity: () => true,
    recordExecutionDecision: () => true,
    recordExecutionDecisionWork: () => true,
    stop: async () => {},
  };
}

function emitMessage(conversationKind: "direct" | "group") {
  emitTrustedMessageAuditEvent({
    occurredAt: 1,
    kind: "message",
    action: "message.inbound.processed",
    status: "succeeded",
    actorType: "channel_sender",
    actorId: "sender-raw",
    direction: "inbound",
    channel: "telegram",
    conversationKind,
    outcome: "completed",
  });
}

describe("message audit recorder", () => {
  it("keeps message events off by default policy", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({ logging: { audit: { messages: "off" } } }),
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("direct");

    unsubscribe();
    await recorder.stop();
    expect(inputs).toEqual([]);
  });

  it("records only known direct conversations in direct mode", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({ logging: { audit: { messages: "direct" } } }),
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("group");
    emitMessage("direct");

    unsubscribe();
    await recorder.stop();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: "message",
      conversationKind: "direct",
      sourceId: expect.stringMatching(/^message:/u),
      sourceSequence: 1,
    });
  });

  it("records group metadata only in all mode", async () => {
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({ logging: { audit: { messages: "all" } } }),
      writer: captureWriter(inputs),
    });
    const unsubscribe = onTrustedMessageAuditEvent(recorder.recordMessage);

    emitMessage("group");

    unsubscribe();
    await recorder.stop();
    expect(inputs[0]).toMatchObject({ kind: "message", conversationKind: "group" });
  });
});

function toolEvent(sessionKey: string, seq: number): TrustedToolExecutionEvent {
  return {
    type: "tool.execution.started",
    seq,
    ts: 1,
    runId: "run-1",
    sessionKey,
    sessionId: "session-1",
    toolName: "read",
    toolCallId: `call-${seq}`,
  } as TrustedToolExecutionEvent;
}

describe("tool action device scope lifecycle", () => {
  it("reports no device ref without an injected resolver", async () => {
    // The CLI local-audit path has no gateway session owner: the projection
    // is cache-only, so an unpublished session stays gateway-scoped.
    const inputs: AuditEventInput[] = [];
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({}),
      writer: captureWriter(inputs),
    });

    recorder.recordTool(toolEvent("agent:main:main", 1));
    await recorder.stop();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("deviceRef");
  });

  it("forgets a cached device scope when the session is deleted and recreated gateway-scoped", async () => {
    const sessionKey = "agent:main:main";
    const inputs: AuditEventInput[] = [];
    publishToolActionDeviceScope({ sessionKey, deviceId: "device-a" });
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({}),
      writer: captureWriter(inputs),
      // The recreated entry is gateway-scoped; a stale cache must not win.
      resolveSessionDeviceScope: () => null,
    });

    recorder.recordTool(toolEvent(sessionKey, 1));
    // No scope write or placement call follows the delete, so only the
    // identity-mutation subscription can retire the cached device.
    emitSessionIdentityMutation({
      agentId: "main",
      databaseIdentity: "state-db",
      kind: "delete",
      previous: { sessionKeys: [sessionKey] },
    });
    recorder.recordTool(toolEvent(sessionKey, 2));
    await recorder.stop();

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ deviceRef: expect.stringMatching(/^sha256:/u) });
    expect(inputs[1]).not.toHaveProperty("deviceRef");
  });
});
