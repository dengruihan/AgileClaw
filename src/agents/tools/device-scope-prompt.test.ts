import { afterEach, describe, expect, it, vi } from "vitest";

const resolveSessionScopeRoot = vi.fn();
const publishSessionDeviceScopePrompt = vi.fn();
const publishPromptDeviceScopeSnapshot = vi.fn();
const gatewayContext = vi.fn();

vi.mock("../../gateway/server-methods/session-device-scope.js", () => ({
  resolveSessionScopeRoot: (...args: unknown[]) => resolveSessionScopeRoot(...args),
  publishSessionDeviceScopePrompt: (...args: unknown[]) => publishSessionDeviceScopePrompt(...args),
}));
vi.mock("../prompt-device-scope.js", () => ({
  publishPromptDeviceScopeSnapshot: (...args: unknown[]) =>
    publishPromptDeviceScopeSnapshot(...args),
}));
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => gatewayContext(),
}));

const { resolveTurnDeviceScopePrompt } = await import("./device-scope-prompt.js");

afterEach(() => {
  resolveSessionScopeRoot.mockReset();
  publishSessionDeviceScopePrompt.mockReset();
  publishPromptDeviceScopeSnapshot.mockReset();
  gatewayContext.mockReset();
});

describe("resolveTurnDeviceScopePrompt", () => {
  it("publishes the root scope fact with the live registry and a currency guard", () => {
    const registry = { invoke: vi.fn() };
    gatewayContext.mockReturnValue({ nodeRegistry: registry });
    resolveSessionScopeRoot.mockReturnValue({
      rootSessionKey: "agent:main:root",
      agentId: "main",
      entry: { sessionId: "sess-1", scopeDeviceId: "device-a", execCwd: "/ws" },
    });
    const snapshot = { target: { kind: "node", deviceId: "device-a" }, devices: [] };
    publishSessionDeviceScopePrompt.mockReturnValue(snapshot);
    expect(
      resolveTurnDeviceScopePrompt({
        cfg: {} as never,
        sessionKey: "agent:main:subagent:child",
        agentId: "main",
      }),
    ).toBe(snapshot);
    expect(publishSessionDeviceScopePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:root",
        registry,
        scopeDeviceId: "device-a",
        scopeCwd: "/ws",
        isCurrent: expect.any(Function),
      }),
    );
  });

  it("withdraws the fact when the session is gone", () => {
    gatewayContext.mockReturnValue({ nodeRegistry: { invoke: vi.fn() } });
    resolveSessionScopeRoot.mockReturnValue(undefined);
    expect(
      resolveTurnDeviceScopePrompt({
        cfg: {} as never,
        sessionKey: "agent:main:root",
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(publishPromptDeviceScopeSnapshot).toHaveBeenCalledWith({
      sessionKey: "agent:main:root",
    });
  });

  it("does not publish outside the Gateway process", () => {
    gatewayContext.mockReturnValue(undefined);
    expect(
      resolveTurnDeviceScopePrompt({
        cfg: {} as never,
        sessionKey: "agent:main:root",
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(publishSessionDeviceScopePrompt).not.toHaveBeenCalled();
  });
});
