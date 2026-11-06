import { afterEach, describe, expect, it, vi } from "vitest";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  clearToolActionDeviceScopesForTest,
  publishToolActionDeviceScope,
  readToolActionDeviceRef,
} from "../../audit/tool-action-device-scope.js";
import {
  clearAllSessionScopeLeasesForTest,
  recordSessionScopeLease,
} from "../../gateway/session-scope-lease.js";
import {
  bindAgentToolExecutionLocation,
  getAgentToolExecutionLocation,
} from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { textResult } from "./tool-results.js";

const acquireDeviceScopeLease = vi.fn();
const resolveSessionScopeRoot = vi.fn();
const gatewayContext = vi.fn();
const nodeGet = vi.fn();
const callGatewayTool = vi.fn();
const planFileEdit = vi.fn();

vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  acquireDeviceScopeLease: (...args: unknown[]) => acquireDeviceScopeLease(...args),
  resolveSessionScopeRoot: (...args: unknown[]) => resolveSessionScopeRoot(...args),
}));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));
vi.mock("../sessions/tools/file-tool-planning.js", () => ({
  planFileEdit: (...args: unknown[]) => planFileEdit(...args),
}));

// The control adapters have their own focused suite; here a stub proves the
// routing layer dispatches control tools to them with the call identity.
const deviceControlCalls: Array<Record<string, unknown>> = [];
vi.mock("./device-control.js", () => ({
  deviceControlAdapter: (toolName: string, cacheKey: object) =>
    toolName === "browser" || toolName === "computer"
      ? (params: Record<string, unknown>) => {
          deviceControlCalls.push({ toolName, cacheKey, ...params });
          return Promise.resolve(textResult(`routed ${toolName}`, {}));
        }
      : undefined,
}));

const { applyDeviceScopeToolRouting, createDeviceScopeRoutingState } =
  await import("./device-routing.js");

function placementTool(name: string, execute = vi.fn(async () => textResult("local", {}))) {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind: "placement" });
  return { tool, execute };
}

function gatewayTool(name: string, execute = vi.fn(async () => textResult("gateway", {}))) {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind: "gateway" });
  return { tool, execute };
}

function routingState() {
  return createDeviceScopeRoutingState({
    sessionKey: "agent:main:root",
    agentId: "main",
    sessionId: "sess-1",
    runId: "run-1",
  });
}

afterEach(() => {
  clearAllSessionScopeLeasesForTest();
  clearToolActionDeviceScopesForTest();
  acquireDeviceScopeLease.mockReset();
  resolveSessionScopeRoot.mockReset();
  gatewayContext.mockReset();
  nodeGet.mockReset();
  callGatewayTool.mockReset();
  planFileEdit.mockReset();
  deviceControlCalls.length = 0;
});

function scopedDeviceFixture() {
  resolveSessionScopeRoot.mockReturnValue({
    rootSessionKey: "agent:main:root",
    agentId: "main",
    entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
  });
  gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
  nodeGet.mockReturnValue({ nodeId: "device-a", platform: "linux" });
  recordSessionScopeLease({
    rootSessionKey: "agent:main:root",
    deviceId: "device-a",
    holder: "agent:main:root",
    leaseToken: "lease-1",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
}

describe("applyDeviceScopeToolRouting", () => {
  it("keeps the tool catalog constant and leaves gateway tools untouched", () => {
    const exec = placementTool("exec");
    const useDevice = gatewayTool("use_device");
    const routed = applyDeviceScopeToolRouting([exec.tool, useDevice.tool], routingState());
    expect(routed.map((tool) => tool.name)).toEqual(["exec", "use_device"]);
    // Gateway tools keep their exact execute identity: they always run on A.
    expect(routed[1]).toBe(useDevice.tool);
    expect(routed[0]).not.toBe(exec.tool);
    expect(getAgentToolExecutionLocation(routed[0]!).kind).toBe("placement");
  });

  it("runs the original placement tool on the Gateway when scope is gateway", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    // A stale device fact must not outlive the return to gateway scope.
    publishToolActionDeviceScope({
      sessionKey: "agent:main:root",
      deviceId: "device-a",
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    const work: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((item) => {
      work.push(item);
      return true;
    });
    try {
      await routed!.execute("call-1", { command: "uname" });
    } finally {
      clear();
    }
    expect(exec.execute).toHaveBeenCalledWith("call-1", { command: "uname" }, undefined, undefined);
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(readToolActionDeviceRef("agent:main:root")).toBeUndefined();
    // A gateway-scoped turn owns no device lease transition, so it writes no fact.
    expect(work).toHaveLength(0);
  });

  it("routes exec to the scoped device with the mirrored lease token", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a", platform: "linux" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "ok" },
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    const result = await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).not.toHaveBeenCalled();
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
      expect.objectContaining({
        nodeId: "device-a",
        command: "system.run",
        sessionKey: "agent:main:root",
        params: expect.objectContaining({
          rawCommand: "uname",
          sessionKey: "agent:main:root",
          leaseToken: "lease-1",
        }),
      }),
      expect.any(Object),
    );
    expect(result.content[0]).toMatchObject({ type: "text" });
    // The routed call published the executing device for the audit projection.
    expect(readToolActionDeviceRef("agent:main:root")).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("routes edit to the device file adapter with the lease token on every invoke", async () => {
    scopedDeviceFixture();
    const fileText = "hello world";
    let statCalls = 0;
    callGatewayTool.mockImplementation(async (_method: string, _opts: unknown, invoke: unknown) => {
      const command = (invoke as { command: string }).command;
      if (command === "file.stat") {
        statCalls += 1;
        const size = statCalls > 1 ? "hello device".length : fileText.length;
        return { payload: { ok: true, path: "/ws/a.txt", type: "file", size } };
      }
      if (command === "file.fetch") {
        return {
          payload: {
            ok: true,
            path: "/ws/a.txt",
            size: fileText.length,
            mimeType: "text/plain",
            base64: Buffer.from(fileText).toString("base64"),
          },
        };
      }
      return { payload: { ok: true, path: "/ws/a.txt", size: 12, sha256: "z" } };
    });
    planFileEdit.mockResolvedValue({
      changed: true,
      editCount: 1,
      content: "hello device",
      receipt: { diff: "- world\n+ device", patch: "", firstChangedLine: 1 },
    });
    const edit = placementTool("edit");
    const [routed] = applyDeviceScopeToolRouting([edit.tool], routingState());
    const result = await routed!.execute("call-1", {
      path: "/ws/a.txt",
      edits: [{ oldText: "world", newText: "device" }],
    });
    expect(edit.execute).not.toHaveBeenCalled();
    const commands = callGatewayTool.mock.calls.map(
      (call) => (call[2] as { command: string }).command,
    );
    expect(commands).toEqual(["file.stat", "file.fetch", "file.write", "file.stat"]);
    for (const call of callGatewayTool.mock.calls) {
      expect((call[2] as { params: Record<string, unknown> }).params).toMatchObject({
        leaseToken: "lease-1",
      });
    }
    expect(result.content[0]).toMatchObject({
      text: "Successfully replaced 1 block(s) in /ws/a.txt.",
    });
  });

  it("routes apply_patch to the device file adapter and keeps unsupported hunks per-call failures", async () => {
    scopedDeviceFixture();
    const applyPatch = placementTool("apply_patch");
    const [routed] = applyDeviceScopeToolRouting([applyPatch.tool], routingState());
    await expect(
      routed!.execute("call-1", {
        input: ["*** Begin Patch", "*** Delete File: /ws/a.txt", "*** End Patch"].join("\n"),
      }),
    ).rejects.toThrow(/cannot delete/);
    expect(applyPatch.execute).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("passes the tool's onUpdate consumer through to the device exec adapter", async () => {
    scopedDeviceFixture();
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "ok", stderr: "" },
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    const updates: unknown[] = [];
    await routed!.execute("call-1", { command: "uname" }, undefined, () => {
      updates.push(true);
    });
    const extra = callGatewayTool.mock.calls[0]![3] as { nodeInvokeStream?: unknown };
    expect(extra.nodeInvokeStream).toBeDefined();
    const invoke = callGatewayTool.mock.calls[0]![2] as { params: Record<string, unknown> };
    expect(invoke.params.streamOutput).toBe(true);
    expect(typeof extra.nodeInvokeStream).toBe("object");
  });

  it("acquires a lease when no mirror exists and surfaces DEVICE_OCCUPIED without gateway fallback", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    acquireDeviceScopeLease.mockResolvedValue({
      ok: false,
      code: "DEVICE_OCCUPIED",
      message: "device-a is occupied: device occupied by session agent:other",
    });
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(/agent:other/);
    expect(exec.execute).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("routes the browser control tool to the scoped device with the call identity", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a", platform: "linux" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const browser = placementTool("browser");
    const state = routingState();
    const [routed] = applyDeviceScopeToolRouting([browser.tool], state);
    await routed!.execute("call-9", { action: "snapshot" });
    expect(deviceControlCalls).toHaveLength(1);
    expect(deviceControlCalls[0]).toMatchObject({
      toolName: "browser",
      toolCallId: "call-9",
      deviceId: "device-a",
      rootSessionKey: "agent:main:root",
      leaseToken: "lease-1",
      params: { action: "snapshot" },
    });
    expect(deviceControlCalls[0]).toHaveProperty("source", browser.tool);
    expect(deviceControlCalls[0]).toHaveProperty("cacheKey", state);
    expect(browser.execute).not.toHaveBeenCalled();
  });

  it("routes the computer control tool to the scoped device with the call identity", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a", platform: "linux" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const computer = placementTool("computer");
    const state = routingState();
    const [routed] = applyDeviceScopeToolRouting([computer.tool], state);
    await routed!.execute("call-10", { action: "screenshot" });
    expect(deviceControlCalls).toHaveLength(1);
    expect(deviceControlCalls[0]).toMatchObject({
      toolName: "computer",
      toolCallId: "call-10",
      deviceId: "device-a",
      leaseToken: "lease-1",
    });
    expect(computer.execute).not.toHaveBeenCalled();
  });

  it("fails a gateway-only control tool per call with a clear reason", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    const screen = placementTool("screen");
    const [routed] = applyDeviceScopeToolRouting([screen.tool], routingState());
    await expect(routed!.execute("call-1", { action: "list" })).rejects.toThrow(
      /Gateway-owned surface/,
    );
    expect(screen.execute).not.toHaveBeenCalled();
  });

  it("fails an unknown placement tool per call with a clear reason", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    const unknown = placementTool("mystery_tool");
    const [routed] = applyDeviceScopeToolRouting([unknown.tool], routingState());
    await expect(routed!.execute("call-1", {})).rejects.toThrow(/no device-routed adapter/);
    expect(unknown.execute).not.toHaveBeenCalled();
  });

  it("refuses the process tool under device scope with a foreground explanation", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    const process = placementTool("process");
    const [routed] = applyDeviceScopeToolRouting([process.tool], routingState());
    await expect(routed!.execute("call-1", { action: "list" })).rejects.toThrow(/foreground/);
    expect(process.execute).not.toHaveBeenCalled();
  });

  it("re-reads the committed scope after a failed switch attempt with unknown outcome", async () => {
    // Warm the cached root read on gateway scope.
    resolveSessionScopeRoot.mockReturnValueOnce({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    const state = routingState();
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], state);
    await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).not.toHaveBeenCalled();

    // The switch committed on the Gateway but its response was lost, so the
    // tool call failed after the entry write: the committed scope now names a
    // device even though the switch never reported success.
    scopedDeviceFixture();
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "ok" },
    });
    state.switchPending = true;
    state.switchPending = false;

    // The next placement call must route on the committed device scope, not the
    // stale pre-switch cache.
    await routed!.execute("call-2", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("applies a committed switch to the next placement call", async () => {
    // First call observes gateway scope; after markScope() the state re-reads
    // the entry and the very next call routes to the device.
    resolveSessionScopeRoot
      .mockReturnValueOnce({
        rootSessionKey: "agent:main:root",
        agentId: "main",
        entry: { sessionId: "sess-1" },
      })
      .mockReturnValue({
        rootSessionKey: "agent:main:root",
        agentId: "main",
        entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
      });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue({ nodeId: "device-a" });
    recordSessionScopeLease({
      rootSessionKey: "agent:main:root",
      deviceId: "device-a",
      holder: "agent:main:root",
      leaseToken: "lease-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    callGatewayTool.mockResolvedValue({
      payload: { success: true, exitCode: 0, stdout: "ok" },
    });
    const state = routingState();
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], state);
    await routed!.execute("call-1", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).not.toHaveBeenCalled();

    state.markScope();
    await routed!.execute("call-2", { command: "uname" });
    expect(exec.execute).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("refuses placement calls while a use_device switch is in flight", async () => {
    const state = routingState();
    state.switchPending = true;
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], state);
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(
      /only placement-affecting call in its step/,
    );
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("refuses device execution when the agent runs outside the Gateway process", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a" },
    });
    gatewayContext.mockReturnValue(undefined);
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    await expect(routed!.execute("call-1", { command: "uname" })).rejects.toThrow(
      /Gateway-hosted session/,
    );
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("queues a disconnected reject fact for an admitted turn before failing the call", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: {
        sessionId: "sess-1",
        scopeDeviceId: "device-a",
        permissionMode: "guarded",
      },
    });
    gatewayContext.mockReturnValue({ nodeRegistry: { get: nodeGet } });
    nodeGet.mockReturnValue(undefined);
    const exec = placementTool("exec");
    const [routed] = applyDeviceScopeToolRouting([exec.tool], routingState());
    const work: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((item) => {
      work.push(item);
      return true;
    });
    try {
      await expect(
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:root",
            executionIdentityToken: createExecutionIdentityAdmissionToken("run-1", {
              contextId: "context-1",
              executionId: "execution-1",
              now: 5,
            }),
            receiptAuthority: () => true,
          },
          () => routed!.execute("call-1", { command: "uname" }),
        ),
      ).rejects.toThrow(/not connected/);
    } finally {
      clear();
    }
    expect(work).toHaveLength(1);
    expect(work[0]?.receipt.decision).toEqual({
      outcome: "denied",
      reasonCode: "device_lease_rejected_disconnected",
    });
    expect(work[0]?.receipt.enforcement.policyRefs).toEqual(["session-permission-mode:guarded"]);
    expect(exec.execute).not.toHaveBeenCalled();
  });
});
