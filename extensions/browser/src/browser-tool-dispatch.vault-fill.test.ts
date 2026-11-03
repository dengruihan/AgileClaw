import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import { executeBrowserTabAction } from "./browser-tool-dispatch.js";
import {
  clearAllVaultFillSessions,
  hasActiveVaultFill,
  registerVaultFillSecret,
  scrubVaultFillText,
} from "./browser/vault-fill-scrub.js";

const runtimeMocks = vi.hoisted(() => ({
  browserNavigate: vi.fn(),
  browserVaultIdentity: vi.fn(),
  browserAct: vi.fn(),
  browserSnapshot: vi.fn(),
}));

vi.mock("./browser-tool.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-tool.runtime.js")>();
  return { ...actual, ...runtimeMocks };
});

const CANARY = "canary-dispatch-value";
const ORIGIN = { scheme: "http" as const, host: "127.0.0.1", port: 11111 };

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
      actKinds: ["batch", "evaluate", "press", "wait", "click", "close"],
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

  it("keeps protection for downloads and same-document navigation, clears only on replacement", async () => {
    runtimeMocks.browserSnapshot.mockRejectedValue(new Error("synthetic snapshot unavailable"));
    runtimeMocks.browserVaultIdentity.mockResolvedValue({
      ok: true,
      targetId: "target-1",
      documentId: "doc-1",
      frameId: "frame-1",
      origin: ORIGIN,
    });
    runtimeMocks.browserNavigate.mockResolvedValue({
      ok: true,
      targetId: "target-1",
      url: "http://127.0.0.1:11111/login",
      download: {
        url: "http://127.0.0.1:11111/file.txt",
        suggestedFilename: "file.txt",
        path: "/tmp/file.txt",
      },
    });
    registerVaultFillSecret("target-1", CANARY, "doc-1");
    await executeBrowserTabAction({
      ...dispatchParams({}),
      action: "navigate",
      actRequest: undefined,
      params: { url: "http://127.0.0.1:11111/login", targetId: "target-1" },
    });
    expect(hasActiveVaultFill("target-1")).toBe(true);
    expect(scrubVaultFillText("target-1", CANARY)).toBe("***");

    runtimeMocks.browserNavigate.mockResolvedValue({
      ok: true,
      targetId: "target-1",
      url: "http://127.0.0.1:11111/login#section",
    });
    await executeBrowserTabAction({
      ...dispatchParams({}),
      action: "navigate",
      actRequest: undefined,
      params: { url: "http://127.0.0.1:11111/login#section", targetId: "target-1" },
    });
    expect(hasActiveVaultFill("target-1")).toBe(true);

    runtimeMocks.browserVaultIdentity.mockResolvedValue({
      ok: true,
      targetId: "target-1",
      documentId: "doc-2",
      frameId: "frame-2",
      origin: ORIGIN,
    });
    runtimeMocks.browserNavigate.mockResolvedValue({
      ok: true,
      targetId: "target-1",
      url: "http://127.0.0.1:11111/next",
    });
    await executeBrowserTabAction({
      ...dispatchParams({}),
      action: "navigate",
      actRequest: undefined,
      params: { url: "http://127.0.0.1:11111/next", targetId: "target-1" },
    });
    expect(hasActiveVaultFill("target-1")).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });

  it("clears the fill session when act:close closes the tab", async () => {
    runtimeMocks.browserAct.mockResolvedValue({ ok: true, targetId: "target-1" });
    const untrack = vi.fn(async () => {});
    registerVaultFillSecret("target-1", CANARY, "doc-1");
    await executeBrowserTabAction({
      ...dispatchParams({ kind: "close", targetId: "target-1" }),
      sessionTabs: {
        ...dispatchParams({}).sessionTabs,
        untrack,
      },
    });
    expect(untrack).toHaveBeenCalledWith("target-1");
    expect(hasActiveVaultFill("target-1")).toBe(false);
    expect(scrubVaultFillText("target-1", CANARY)).toBe(CANARY);
  });

  it("rejects a batch-wrapped evaluate before dispatch", async () => {
    registerVaultFillSecret("target-1", CANARY);
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
    registerVaultFillSecret("target-1", CANARY);
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
