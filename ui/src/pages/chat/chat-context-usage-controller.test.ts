/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../../src/config/sessions/session-system-prompt-report.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { ChatContextUsageController } from "./chat-context-usage-controller.ts";

const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  systemPrompt: { chars: 400, projectContextChars: 0, nonProjectContextChars: 400 },
  injectedWorkspaceFiles: [],
  skills: { promptChars: 0, entries: [] },
  tools: { listChars: 0, schemaChars: 0, entries: [] },
};

const catalog: ToolsEffectiveResult = {
  agentId: "main",
  profile: "full",
  groups: [],
};

type UsageResponder = () => Promise<unknown>;

function createHarness(options: { advertiseTools?: boolean; usage?: UsageResponder } = {}) {
  const client = new GatewayBrowserClient({
    url: window.location.origin.replace(/^http/u, "ws"),
  });
  const request = vi.spyOn(client, "request").mockImplementation(async (method: string) => {
    if (method === "sessions.usage") {
      return options.usage
        ? options.usage()
        : {
            sessions: [{ key: "main", sessionId: "s1", agentId: "main", contextWeight: report }],
          };
    }
    if (method === "tools.effective") {
      return catalog;
    }
    throw new Error(`unexpected method ${method}`);
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: options.advertiseTools === false ? null : gatewayHelloForMethods(["tools.effective"]),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const session = { sessionKey: "main", agentId: "main", sessionId: "s1", totalTokens: 1000 };
  const controller = new ChatContextUsageController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    },
    () => ({ snapshot, connectionRevision: 1 }),
    () => session,
  );
  return { request, controller, session };
}

describe("ChatContextUsageController", () => {
  it("loads once on intent and caches per token snapshot", async () => {
    const { request, controller } = createHarness();
    controller.intent();
    expect(controller.detail.status).toBe("loading");
    await vi.waitFor(() => expect(controller.detail.status).toBe("ready"));
    expect(controller.detail.report).toBe(report);
    expect(controller.detail.toolsEffective).toBe(catalog);
    expect(request).toHaveBeenCalledTimes(2);

    controller.intent();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refetches when the context snapshot moves", async () => {
    const { request, controller, session } = createHarness();
    controller.intent();
    await vi.waitFor(() => expect(controller.detail.status).toBe("ready"));
    expect(request).toHaveBeenCalledTimes(2);

    session.totalTokens = 2000;
    controller.intent();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("resets cached detail when the session changes", async () => {
    const { controller, session } = createHarness();
    controller.intent();
    await vi.waitFor(() => expect(controller.detail.status).toBe("ready"));

    session.sessionKey = "other";
    controller.hostUpdate();
    expect(controller.detail.status).toBe("idle");
    expect(controller.detail.report).toBeNull();
  });

  it("discards a response from a superseded session id", async () => {
    const { controller } = createHarness({
      usage: async () => ({
        sessions: [{ key: "main", sessionId: "predecessor", contextWeight: report }],
      }),
    });
    controller.intent();
    await vi.waitFor(() => expect(controller.detail.status).toBe("ready"));
    expect(controller.detail.report).toBeNull();
  });

  it("skips the catalog request when tools.effective is not advertised", async () => {
    const { request, controller } = createHarness({ advertiseTools: false });
    controller.intent();
    await vi.waitFor(() => expect(controller.detail.status).toBe("ready"));
    expect(controller.detail.toolsEffective).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("sessions.usage");
  });

  it("reports an error when the usage request fails and retries on the next intent", async () => {
    const { controller } = createHarness({
      usage: async () => {
        throw new Error("gateway offline");
      },
    });
    controller.intent();
    await vi.waitFor(() => expect(controller.detail.status).toBe("error"));
    expect(controller.detail.report).toBeNull();

    controller.intent();
    expect(controller.detail.status).toBe("loading");
  });
});
