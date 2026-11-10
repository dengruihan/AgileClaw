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

describe("NodeInvokeStreamController.handleResult", () => {
  it("normalizes a real node host's payloadJSON into the structured payload", () => {
    const { pendingInvokes, controller } = createController();
    const grant = {
      ok: true,
      holder: { sessionKey: "agent:main:root", sessionId: "sess-1", runId: "run-1" },
      leaseToken: "lease-1",
      acquiredAtMs: 1,
    };
    let result: unknown;
    armPending(pendingInvokes, (value) => {
      result = value;
    });

    expect(
      controller.handleResult({
        id: "invoke-1",
        nodeId: "node-a",
        connId: "conn-1",
        ok: true,
        payloadJSON: JSON.stringify(grant),
      }),
    ).toBe(true);

    // The occupancy lease owner reads result.payload; a payloadJSON-only node
    // reply must not look like a malformed grant.
    expect(result).toEqual({
      ok: true,
      payload: grant,
      payloadJSON: JSON.stringify(grant),
      error: null,
    });
  });

  it("keeps an explicit payload and treats unparseable payloadJSON as no payload", () => {
    const { pendingInvokes, controller } = createController();
    const explicit = { holder: { sessionKey: "agent:main:root" } };
    let result: { payload?: unknown } | undefined;
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

    const second = createController();
    armPending(second.pendingInvokes, (value) => {
      result = value;
    });
    second.controller.handleResult({
      id: "invoke-1",
      nodeId: "node-a",
      connId: "conn-1",
      ok: true,
      payloadJSON: "{not-json",
    });
    expect(result?.payload).toBeUndefined();
  });
});
