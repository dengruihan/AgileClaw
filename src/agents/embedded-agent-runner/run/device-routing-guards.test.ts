import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { bindAgentToolExecutionLocation } from "../../agent-tool-metadata.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { textResult } from "../../tools/tool-results.js";

const resolveSessionScopeRoot = vi.fn();

vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../../gateway/server-methods/session-device-scope.js", () => ({
  resolveSessionScopeRoot: (...args: unknown[]) => resolveSessionScopeRoot(...args),
}));
// The step rule needs only the tool-name constant; the real module pulls the
// gateway tool context graph, which this focused test must not load.
vi.mock("../../tools/use-device-tool.js", () => ({ USE_DEVICE_TOOL_NAME: "use_device" }));

const { applyDeviceControlSerialization } = await import("../../tools/device-serialization.js");
const { applyDeviceStepRuleBatchGuard } = await import("./device-step-rule.js");

function makeTool(
  name: string,
  kind: "placement" | "gateway",
  execute: AnyAgentTool["execute"] = vi.fn(async () => textResult(`${name} ok`, {})),
) {
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  };
  bindAgentToolExecutionLocation(tool, { kind });
  return { tool, execute: execute as ReturnType<typeof vi.fn> };
}

/** One agent-loop execution context; the assistant message is the batch identity. */
function batchStep(name: string) {
  return {
    assistantMessage: { role: "assistant", id: name } as never,
    toolCall: { id: `${name}-call`, name: "exec", arguments: {} } as never,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

/** Deterministic microtask drain; no timers. */
async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resolveSessionScopeRoot.mockReset();
});

describe("applyDeviceStepRuleBatchGuard", () => {
  it("keeps the catalog constant, leaves gateway tools untouched, and is a no-op without use_device", () => {
    const exec = makeTool("exec", "placement");
    const message = makeTool("message", "gateway");
    const useDevice = makeTool("use_device", "gateway");
    const routed = applyDeviceStepRuleBatchGuard([exec.tool, message.tool, useDevice.tool]);
    expect(routed.map((tool) => tool.name)).toEqual(["exec", "message", "use_device"]);
    expect(routed[1]).toBe(message.tool);
    expect(routed[0]).not.toBe(exec.tool);
    // Re-wrapping a guarded surface must not swap in a fresh step tracker.
    expect(applyDeviceStepRuleBatchGuard(routed)).toEqual(routed);
    // Without use_device the surface is returned unchanged.
    expect(applyDeviceStepRuleBatchGuard([exec.tool, message.tool])).toEqual([
      exec.tool,
      message.tool,
    ]);
  });

  it("rejects the switch when placement calls already ran in the same step (before ordering)", async () => {
    const exec = makeTool("exec", "placement");
    const useDevice = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    const stepOne = batchStep("m1");
    await runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-1", {}));
    expect(exec.execute).toHaveBeenCalledTimes(1);
    // use_device starts later in the same sequential batch: rejected before the
    // patch runs, so no call ran and no call will run on an unintended scope.
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-2", {})),
    ).rejects.toThrow(
      /only placement-affecting call in its step; exec already ran in this step\. The switch was not attempted/,
    );
    expect(useDevice.execute).not.toHaveBeenCalled();
  });

  it("rejects placement calls after a use_device attempt in the same step (after ordering)", async () => {
    const exec = makeTool("exec", "placement");
    const useDevice = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    const stepOne = batchStep("m1");
    await runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-1", {}));
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-2", {})),
    ).rejects.toThrow(/use_device ran earlier in this step.*retry exec in the next step/);
    expect(exec.execute).not.toHaveBeenCalled();
    // The next step boundary frees placement calls again.
    const stepTwo = batchStep("m2");
    await runWithAgentToolExecutionContext(stepTwo, () => tools[0]!.execute("call-3", {}));
    expect(exec.execute).toHaveBeenCalledTimes(1);
  });

  it("a failed switch attempt still consumes its step", async () => {
    const exec = makeTool("exec", "placement");
    const useDevice = makeTool("use_device", "gateway", async () => {
      throw new Error("device-a is occupied: device occupied by session agent:other");
    });
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    const stepOne = batchStep("m1");
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-1", {})),
    ).rejects.toThrow(/DEVICE_OCCUPIED|occupied/);
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-2", {})),
    ).rejects.toThrow(/use_device ran earlier in this step/);
    expect(exec.execute).not.toHaveBeenCalled();
    const stepTwo = batchStep("m2");
    await runWithAgentToolExecutionContext(stepTwo, () => tools[0]!.execute("call-3", {}));
    expect(exec.execute).toHaveBeenCalledTimes(1);
  });

  it("sees an in-flight placement call when the switch starts in the same step (parallel ordering)", async () => {
    const release = deferred<void>();
    const exec = makeTool("exec", "placement", () =>
      release.promise.then(() => textResult("exec ok", {})),
    );
    const useDevice = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    const stepOne = batchStep("m1");
    const inFlight = runWithAgentToolExecutionContext(stepOne, () =>
      tools[0]!.execute("call-1", {}),
    );
    await flush();
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-2", {})),
    ).rejects.toThrow(/exec already ran in this step/);
    release.resolve();
    await inFlight;
  });

  it("sees an in-flight switch when a placement call starts in the same step (parallel ordering)", async () => {
    const release = deferred<void>();
    const useDevice = makeTool("use_device", "gateway", () =>
      release.promise.then(() => textResult("scope: gateway", {})),
    );
    const exec = makeTool("exec", "placement");
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    const stepOne = batchStep("m1");
    const inFlight = runWithAgentToolExecutionContext(stepOne, () =>
      tools[1]!.execute("call-1", {}),
    );
    await flush();
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-2", {})),
    ).rejects.toThrow(/use_device ran earlier in this step/);
    release.resolve();
    await inFlight;
    expect(exec.execute).not.toHaveBeenCalled();
  });

  it("rejects a second use_device in the same step after a committed switch", async () => {
    const first = makeTool("use_device", "gateway");
    const second = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([first.tool, second.tool]);
    const stepOne = batchStep("m1");
    await runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-1", {}));
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-2", {})),
    ).rejects.toThrow(/use_device already ran in this step.*keeps the scope committed/s);
    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).not.toHaveBeenCalled();
    // The next step accepts a switch again.
    const stepTwo = batchStep("m2");
    await runWithAgentToolExecutionContext(stepTwo, () => tools[1]!.execute("call-3", {}));
    expect(second.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a second use_device in the same step after a failed switch attempt", async () => {
    const first = makeTool("use_device", "gateway", async () => {
      throw new Error("device-a is occupied: device occupied by session agent:other");
    });
    const second = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([first.tool, second.tool]);
    const stepOne = batchStep("m1");
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[0]!.execute("call-1", {})),
    ).rejects.toThrow(/occupied/);
    await expect(
      runWithAgentToolExecutionContext(stepOne, () => tools[1]!.execute("call-2", {})),
    ).rejects.toThrow(/use_device already ran in this step/);
    expect(second.execute).not.toHaveBeenCalled();
  });

  it("does not guard calls outside an agent-loop batch context", async () => {
    const exec = makeTool("exec", "placement");
    const useDevice = makeTool("use_device", "gateway");
    const tools = applyDeviceStepRuleBatchGuard([exec.tool, useDevice.tool]);
    await tools[0]!.execute("call-1", {});
    await tools[1]!.execute("call-2", {});
    await tools[0]!.execute("call-3", {});
    expect(exec.execute).toHaveBeenCalledTimes(2);
    expect(useDevice.execute).toHaveBeenCalledTimes(1);
  });
});

describe("applyDeviceControlSerialization", () => {
  function deviceRoot(rootSessionKey: string, deviceId: string) {
    return {
      rootSessionKey,
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: deviceId },
    };
  }

  it("serializes control calls within one lease in FIFO order while exec stays parallel", async () => {
    resolveSessionScopeRoot.mockReturnValue(deviceRoot("agent:main:root", "device-a"));
    const events: string[] = [];
    const releaseBrowser = deferred<void>();
    const browser = makeTool("browser", "placement", () => {
      events.push("browser:start");
      return releaseBrowser.promise.then(() => textResult("browser done", {}));
    });
    const computer = makeTool("computer", "placement", async () => {
      events.push("computer:start");
      return textResult("computer done", {});
    });
    const exec = makeTool("exec", "placement", async () => {
      events.push("exec:start");
      return textResult("exec done", {});
    });
    const tools = applyDeviceControlSerialization({
      tools: [browser.tool, computer.tool, exec.tool],
      sessionKey: "agent:main:root",
      agentId: "main",
    });
    const browserRun = tools[0]!.execute("call-1", {});
    await flush();
    expect(events).toEqual(["browser:start"]);
    const computerRun = tools[1]!.execute("call-2", {});
    await flush();
    // The second control call queues at the Gateway; its body has not started.
    expect(events).toEqual(["browser:start"]);
    const execRun = tools[2]!.execute("call-3", {});
    await execRun;
    // Exec bypasses the control gate and completes while browser holds it.
    expect(events).toEqual(["browser:start", "exec:start"]);
    releaseBrowser.resolve();
    await browserRun;
    await computerRun;
    expect(events).toEqual(["browser:start", "exec:start", "computer:start"]);
  });

  it("does not queue control calls that share no lease", async () => {
    const events: string[] = [];
    const releaseBrowser = deferred<void>();
    const browser = makeTool("browser", "placement", () => {
      events.push("browser:start");
      return releaseBrowser.promise.then(() => textResult("browser done", {}));
    });
    const computer = makeTool("computer", "placement", async () => {
      events.push("computer:start");
      return textResult("computer done", {});
    });
    const tools = applyDeviceControlSerialization({
      tools: [browser.tool, computer.tool],
      sessionKey: "agent:main:root",
      agentId: "main",
    });
    const browserRun = tools[0]!.execute("call-1", {});
    await flush();
    // A different lease (another root) is a different interactive surface.
    resolveSessionScopeRoot.mockReturnValue(deviceRoot("agent:other:root", "device-b"));
    const computerRun = tools[1]!.execute("call-2", {});
    await flush();
    expect(events).toEqual(["browser:start", "computer:start"]);
    releaseBrowser.resolve();
    await browserRun;
    await computerRun;
  });

  it("keeps gateway-scoped control calls unqueued and leaves exec and file tools unwrapped", async () => {
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1" },
    });
    const events: string[] = [];
    const releaseBrowser = deferred<void>();
    const browser = makeTool("browser", "placement", () => {
      events.push("browser:start");
      return releaseBrowser.promise.then(() => textResult("browser done", {}));
    });
    const computer = makeTool("computer", "placement", async () => {
      events.push("computer:start");
      return textResult("computer done", {});
    });
    const exec = makeTool("exec", "placement");
    const write = makeTool("write", "placement");
    const tools = applyDeviceControlSerialization({
      tools: [browser.tool, computer.tool, exec.tool, write.tool],
      sessionKey: "agent:main:root",
      agentId: "main",
    });
    expect(tools[2]).toBe(exec.tool);
    expect(tools[3]).toBe(write.tool);
    const browserRun = tools[0]!.execute("call-1", {});
    const computerRun = tools[1]!.execute("call-2", {});
    await flush();
    // No device lease: both control calls start immediately.
    expect(events).toEqual(["browser:start", "computer:start"]);
    releaseBrowser.resolve();
    await browserRun;
    await computerRun;
  });

  it("re-serializing a guarded surface keeps one queue per control tool", () => {
    resolveSessionScopeRoot.mockReturnValue(deviceRoot("agent:main:root", "device-a"));
    const browser = makeTool("browser", "placement");
    const once = applyDeviceControlSerialization({
      tools: [browser.tool],
      sessionKey: "agent:main:root",
      agentId: "main",
    });
    const twice = applyDeviceControlSerialization({
      tools: once,
      sessionKey: "agent:main:root",
      agentId: "main",
    });
    expect(twice[0]).toBe(once[0]);
  });
});
