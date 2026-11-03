import { afterEach, describe, expect, it } from "vitest";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import { executeBrowserTabAction } from "./browser-tool-dispatch.js";
import { clearAllVaultFillSessions, registerVaultFillSecret } from "./browser/vault-fill-scrub.js";

function proxyRecorder() {
  const calls: unknown[] = [];
  const proxy = Object.assign(
    async (request: unknown) => {
      calls.push(request);
      return { ok: true, targetId: "target-1" };
    },
    { isHostFallbackActive: () => false, route: () => undefined },
  ) as unknown as BrowserProxyRequest;
  return { proxy, calls };
}

function dispatchParams(request: Record<string, unknown>) {
  return {
    action: "act",
    actRequest: request as never,
    params: {},
    profile: "shared",
    proxyRequest: null,
    sessionTabs: {
      touch: async () => {},
      untrack: async () => {},
      trackOpened: async () => {},
    },
    capabilities: {
      actions: ["act"],
      actKinds: ["batch", "evaluate", "press", "wait", "click"],
      tabBound: false,
    },
    isUserBrowserProfile: false,
    onTabActivity: () => {},
  };
}

describe("browser vault fill dispatch guard", () => {
  afterEach(() => {
    clearAllVaultFillSessions();
  });

  it("rejects a batch-wrapped evaluate before dispatch", async () => {
    registerVaultFillSecret("target-1", "canary-dispatch-value");
    const { proxy, calls } = proxyRecorder();
    await expect(
      executeBrowserTabAction({
        ...dispatchParams({
          kind: "batch",
          actions: [{ kind: "batch", actions: [{ kind: "evaluate", fn: "() => document.title" }] }],
        }),
        proxyRequest: proxy,
      }),
    ).rejects.toThrow(/evaluate/u);
    expect(calls).toHaveLength(0);
  });

  it("rejects ordinary Enter and click submission paths at any batch depth", async () => {
    registerVaultFillSecret("target-1", "canary-dispatch-value");
    for (const request of [
      { kind: "press", key: "Enter" },
      { kind: "click", ref: "1" },
      { kind: "batch", actions: [{ kind: "batch", actions: [{ kind: "press", key: "Enter" }] }] },
    ] as const) {
      const { proxy, calls } = proxyRecorder();
      await expect(
        executeBrowserTabAction({ ...dispatchParams(request), proxyRequest: proxy }),
      ).rejects.toThrow(/interactions are blocked/u);
      expect(calls).toHaveLength(0);
    }
  });
});
