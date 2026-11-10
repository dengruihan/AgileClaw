import { describe, expect, it } from "vitest";
import type { PendingInvoke } from "./node-registry.invoke-stream.js";
import { NodeInvokeStreamController } from "./node-registry.invoke-stream.js";

function createController() {
  const pendingInvokes = new Map<string, PendingInvoke>();
  const controller = new NodeInvokeStreamController({
    pendingInvokes,
    sendCancel: () => {},
    isConnectionActive: () => true,
    isCommandAllowed: () => true,
    sendInput: () => true,
    onFailedResult: () => {},
    disconnectPending: () => {},
  });
  return { pendingInvokes, controller };
}

function armPending(
  pendingInvokes: Map<string, PendingInvoke>,
  resolve: (value: Parameters<PendingInvoke["resolve"]>[0]) => void,
) {
  pendingInvokes.set("invoke-1", {
    nodeId: "node-a",
    connId: "conn-1",
    command: "occupancy.acquire.v1",
    resolve,
    reject: () => {},
    nextProgressSeq: 0,
    progressChunks: new Map(),
    nextInputSeq: 0,
  });
}

function deliver(payload: string) {
  const { pendingInvokes, controller } = createController();
  let result: Parameters<PendingInvoke["resolve"]>[0] | undefined;
  armPending(pendingInvokes, (value) => {
    result = value;
  });
  expect(
    controller.handleResult({
      id: "invoke-1",
      nodeId: "node-a",
      connId: "conn-1",
      ok: true,
      payloadJSON: payload,
    }),
  ).toBe(true);
  return result;
}

describe("NodeInvokeStreamController.handleResult", () => {
  it("normalizes a real node host's payloadJSON into the structured payload", () => {
    const grant = {
      ok: true,
      holder: { sessionKey: "agent:main:root", sessionId: "sess-1", runId: "run-1" },
      leaseToken: "lease-1",
      acquiredAtMs: 1,
    };
    const result = deliver(JSON.stringify(grant));

    // The occupancy lease owner reads result.payload; a payloadJSON-only node
    // reply must not look like a malformed grant.
    expect(result).toEqual({
      ok: true,
      payload: grant,
      payloadJSON: JSON.stringify(grant),
      error: null,
    });
  });

  it("preserves valid payloads whose shape is an object with only a payloadJSON string", () => {
    const nested = { payloadJSON: "legitimate-inner-text" };
    const result = deliver(JSON.stringify(nested));

    expect(result?.payload).toEqual(nested);
    expect(result?.payloadJSON).toBe(JSON.stringify(nested));
  });

  it("treats unparseable payloadJSON as no payload while retaining the raw text", () => {
    const result = deliver("{not-json");

    expect(result?.payload).toBeUndefined();
    expect(result?.payloadJSON).toBe("{not-json");
  });

  it("keeps an explicit payload", () => {
    const { pendingInvokes, controller } = createController();
    const explicit = { holder: { sessionKey: "agent:main:root" } };
    let result: Parameters<PendingInvoke["resolve"]>[0] | undefined;
    armPending(pendingInvokes, (value) => {
      result = value;
    });

    controller.handleResult({
      id: "invoke-1",
      nodeId: "node-a",
      connId: "conn-1",
      ok: true,
      payload: explicit,
      payloadJSON: JSON.stringify({ ignored: true }),
    });

    expect(result?.payload).toEqual(explicit);
  });
});
