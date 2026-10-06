import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import * as uuid from "../../lib/uuid.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

type RunnerOptions = ConstructorParameters<typeof ModelSetupWizardRunner>[0];

function createRunner(options: Pick<RunnerOptions, "getClient"> & Partial<RunnerOptions>) {
  return new ModelSetupWizardRunner({
    getAgentId: () => null,
    onChange: () => undefined,
    requestFailedMessage: () => "failed",
    cancelledMessage: () => "cancelled",
    sessionExpiredMessage: () => "expired",
    gatewayNotRespondingMessage: () => "not responding",
    ...options,
  });
}

describe("ModelSetupWizardRunner", () => {
  it("cleans a late MCP admission on the captured client without replaying or selecting an agent", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const generateUUID = vi.spyOn(uuid, "generateUUID").mockReturnValue(sessionId);
    const admission = createDeferred<WizardNextResult>();
    const original = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
    const replacement = new GatewayBrowserClient({ url: "ws://gateway-b.example.test" });
    const originalRequest = vi
      .spyOn(original, "request")
      .mockReturnValueOnce(admission.promise)
      .mockResolvedValue({ status: "cancelled" });
    const replacementRequest = vi.spyOn(replacement, "request");
    let client = original;
    const getAgentId = vi.fn(() => "selected-agent");
    const runner = createRunner({ getClient: () => client, getAgentId });
    try {
      const start = runner.startMcpLogin("docs");
      expect(originalRequest).toHaveBeenCalledWith(
        "mcp.authLogin",
        { sessionId, serverName: "docs" },
        { timeoutMs: null },
      );
      expect(getAgentId).not.toHaveBeenCalled();

      client = replacement;
      await runner.cancel();
      const cancellation = originalRequest.mock.calls[1];
      expect(cancellation).toEqual([
        "wizard.cancel",
        { sessionId, closeInput: true },
        { timeoutMs: 30_000 },
      ]);
      admission.resolve({ done: false, status: "running" });
      await expect(start).resolves.toBeNull();
      expect(originalRequest).toHaveBeenCalledTimes(3);
      expect(originalRequest.mock.calls[2]).toEqual(cancellation);
      expect(replacementRequest).not.toHaveBeenCalled();
      expect(runner.state).toEqual({ phase: "idle" });
    } finally {
      admission.resolve({ done: true, status: "cancelled" });
      await runner.cancel();
      originalRequest.mockRestore();
      replacementRequest.mockRestore();
      generateUUID.mockRestore();
    }
  });
});
