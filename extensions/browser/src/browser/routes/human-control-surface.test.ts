import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { humanControlRegistry } from "../human-control.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  clearAllVaultFillSessions,
  hasActiveVaultFill,
  registerVaultFillSecret,
} from "../vault-fill-scrub.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { registerBrowserAgentScreencastRoutes } from "./agent.screencast.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const calls = {
  close: vi.fn(async (targetId: string) =>
    targetId === "t1" ? "target-1" : targetId === "t2" ? "target-2" : targetId,
  ),
  focus: vi.fn(async () => undefined),
  label: vi.fn(async () => ({
    targetId: "t1",
    tabId: "t1",
    title: "One",
    url: "https://one.test",
  })),
  open: vi.fn(async () => ({ targetId: "t9", tabId: "t9", title: "New", url: "about:blank" })),
};

function tabs() {
  return [
    { targetId: "target-1", tabId: "t1", title: "One", url: "https://one.test", type: "page" },
    { targetId: "target-2", tabId: "t2", title: "Two", url: "https://two.test", type: "page" },
  ];
}

function routeContext(reachable = true): BrowserRouteContext {
  const resolved = resolveBrowserConfig({
    defaultProfile: "openclaw",
    evaluateEnabled: true,
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    profiles: {
      openclaw: { cdpUrl: "http://127.0.0.1:19999", color: "#123456", attachOnly: true },
    },
  });
  const profile = resolveProfile(resolved, "openclaw");
  if (!profile) {
    throw new Error("synthetic profile missing");
  }
  const state = { port: 0, resolved, profiles: new Map() };
  const profileCtx = {
    profile,
    ensureTabAvailable: async (targetId?: string) =>
      tabs().find((tab) => tab.targetId === targetId || tab.tabId === targetId) ?? tabs()[0],
    listTabs: async () => tabs(),
    isReachable: async () => reachable,
    isHttpReachable: async () => true,
    isTransportAvailable: async () => true,
    closeTab: calls.close,
    focusTab: calls.focus,
    labelTab: calls.label,
    openTab: calls.open,
    ensureBrowserAvailable: async () => undefined,
    stopRunningBrowser: async () => ({ stopped: false }),
    resetProfile: async () => ({ moved: false, from: "" }),
  };
  return {
    state: () => state as never,
    forProfile: () => profileCtx as never,
    listProfiles: async () => [],
  };
}

function app() {
  const routes = createBrowserRouteApp();
  const ctx = routeContext();
  registerBrowserAgentActRoutes(routes.app, ctx);
  registerBrowserAgentSnapshotRoutes(routes.app, ctx);
  registerBrowserAgentScreencastRoutes(routes.app, ctx);
  registerBrowserAgentStorageRoutes(routes.app, ctx);
  registerBrowserTabRoutes(routes.app, ctx);
  return routes;
}

function request(body: Record<string, unknown> = {}) {
  return {
    params: {},
    query: { profile: "openclaw" },
    body,
    signal: new AbortController().signal,
  };
}

async function call(handler: (req: never, res: never) => void | Promise<void>, req: unknown) {
  const response = createBrowserRouteResponse();
  await handler(req as never, response.res as never);
  return response;
}

function claim(tabId = "t1", requestedBy: "agent" | "human" = "agent") {
  return humanControlRegistry.claim({
    profile: "openclaw",
    targetId: tabId === "t2" ? "target-2" : "target-1",
    tabId,
    reason: "captcha",
    requestedBy,
  });
}

describe.each(["requested", "active"] as const)(
  "human control covers every agent tab surface (%s)",
  (leaseState) => {
    afterEach(() => {
      humanControlRegistry.revokeAll();
      clearAllVaultFillSessions();
      vi.clearAllMocks();
    });

    function seed() {
      humanControlRegistry.revokeAll();
      claim("t1", leaseState === "requested" ? "agent" : "human");
    }

    it.each([
      ["pdf", "/pdf", { targetId: "t1" }, "post"],
      ["download", "/download", { targetId: "t1", ref: "e1", path: "/tmp/proof" }, "post"],
      ["upload", "/hooks/file-chooser", { targetId: "t1", paths: ["/tmp/proof"] }, "post"],
      ["dialog", "/hooks/dialog", { targetId: "t1", accept: true }, "post"],
      ["emulate", "/set/media", { targetId: "t1", colorScheme: "dark" }, "post"],
      ["screencast", "/screencast", { targetId: "t1" }, "post"],
    ] as const)("blocks agent %s", async (_name, path, body, method) => {
      seed();
      const routes = app();
      const handler =
        method === "post" ? routes.postHandlers.get(path) : routes.deleteHandlers.get(path);
      expect(handler).toBeDefined();
      const response = await call(handler!, request(body));
      expect(response.statusCode).toBe(423);
      expect(response.body).toMatchObject({
        code: "ACT_HUMAN_CONTROL",
        status: "needs_human",
        reasonCode: "human_control",
      });
    });

    it("blocks agent snapshots", async () => {
      seed();
      const response = await call(app().getHandlers.get("/snapshot")!, {
        params: {},
        query: { profile: "openclaw", targetId: "t1" },
        body: undefined,
        signal: new AbortController().signal,
      });
      expect(response.statusCode).toBe(423);
      expect(response.body).toMatchObject({ code: "ACT_HUMAN_CONTROL" });
    });

    it("blocks agent focus and target close", async () => {
      seed();
      const routes = app();
      const focus = await call(
        routes.postHandlers.get("/tabs/focus")!,
        request({ targetId: "t1" }),
      );
      expect(focus.statusCode).toBe(423);
      expect(calls.focus).not.toHaveBeenCalled();

      const close = await call(routes.deleteHandlers.get("/tabs/:targetId")!, {
        ...request(),
        params: { targetId: "t1" },
      });
      expect(close.statusCode).toBe(423);
      expect(calls.close).not.toHaveBeenCalled();
    });

    it("keeps an unowned sibling tab available", async () => {
      seed();
      const focus = await call(app().postHandlers.get("/tabs/focus")!, request({ targetId: "t2" }));
      expect(focus.statusCode).toBe(200);
      expect(calls.focus).toHaveBeenCalledWith(
        "target-2",
        expect.objectContaining({ exactTargetId: true }),
      );
    });

    it("clears sensitive masking on panel close and on an authoritative tab prune", async () => {
      humanControlRegistry.revokeAll();
      const routes = app();
      registerVaultFillSecret("target-1", "m37-close-canary", "doc-1", "openclaw");
      expect(hasActiveVaultFill("target-1")).toBe(true);
      const closed = await call(routes.deleteHandlers.get("/tabs/:targetId")!, {
        ...request(),
        params: { targetId: "t1" },
      });
      expect(closed.statusCode).toBe(200);
      expect(hasActiveVaultFill("target-1")).toBe(false);

      registerVaultFillSecret("target-gone", "m37-prune-canary", "doc-2", "openclaw");
      registerVaultFillSecret("target-2", "m37-live-canary", "doc-3", "openclaw");
      const listed = await call(routes.getHandlers.get("/tabs")!, request());
      expect(listed.statusCode).toBe(200);
      expect(hasActiveVaultFill("target-gone")).toBe(false);
      expect(hasActiveVaultFill("target-2")).toBe(true);
    });

    it("keeps the read-only tab listing available and reports ownership", async () => {
      seed();
      const listed = await call(app().getHandlers.get("/tabs")!, request());
      expect(listed.statusCode).toBe(200);
      const body = listed.body as {
        running: boolean;
        tabs: Array<{ tabId?: string; control?: { status: string } }>;
      };
      expect(body.running).toBe(true);
      expect(body.tabs.find((tab) => tab.tabId === "t1")?.control?.status).toBe(
        leaseState === "requested" ? "requested" : "active",
      );
    });
  },
);

describe("stopped profile tab listing", () => {
  afterEach(() => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    vi.clearAllMocks();
  });

  it("does not treat a transient unreachable probe as document destruction", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    const claimed = claim("t1", "human");
    expect(claimed.control.status).toBe("active");
    registerVaultFillSecret("target-1", "stopped-list-canary", "doc-1", "openclaw");
    registerVaultFillSecret("target-other", "other-canary", "doc-2", "other-profile");

    const routes = createBrowserRouteApp();
    registerBrowserTabRoutes(routes.app, routeContext(false));
    const response = await call(routes.getHandlers.get("/tabs")!, request());

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ running: false, tabs: [] });
    expect(
      humanControlRegistry.status({ profile: "openclaw", targetId: "target-1", tabId: "t1" }),
    ).not.toBeNull();
    expect(hasActiveVaultFill("target-1")).toBe(true);
    expect(hasActiveVaultFill("target-other")).toBe(true);
  });
});
