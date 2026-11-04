import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { humanControlRegistry } from "../human-control.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  clearAllVaultFillSessions,
  hasActiveVaultFill,
  registerVaultFillSecret,
} from "../vault-fill-scrub.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserHumanControlRoutes } from "./human-control.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const h = vi.hoisted(() => ({
  pageUrl: "https://one.test/login",
  loaderId: "doc-1",
  download: false,
}));

vi.mock("../pw-session-connection.js", () => ({
  getPageForTargetId: async () => ({
    url: () => h.pageUrl,
    context: () => ({
      cookies: async () => [{ name: "sid", domain: "one.test", path: "/", expires: -1 }],
      newCDPSession: async () => ({
        send: async (method: string) =>
          method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "frame-1", loaderId: h.loaderId } } }
            : {},
        detach: async () => undefined,
      }),
    }),
  }),
}));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    navigateViaPlaywright: async () => ({
      targetId: "target-1",
      url: h.pageUrl,
      ...(h.download ? { download: { suggestedFilename: "proof.pdf" } } : {}),
    }),
  }),
  getLoadedPwAiModule: () => undefined,
}));

function tabs() {
  return [{ targetId: "target-1", tabId: "t1", title: "Login", url: h.pageUrl, type: "page" }];
}

function routeContext(): BrowserRouteContext {
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
    ensureTabAvailable: async () => tabs()[0],
    listTabs: async () => tabs(),
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
  registerBrowserAgentSnapshotRoutes(routes.app, ctx);
  registerBrowserHumanControlRoutes(routes.app, ctx);
  return routes;
}

function request(body: Record<string, unknown>) {
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

async function claim(routes: ReturnType<typeof app>) {
  const response = await call(
    routes.postHandlers.get("/human-control/claim")!,
    request({ targetId: "t1" }),
  );
  return (response.body as { humanControlToken: string }).humanControlToken;
}

describe("human navigation retires sensitive masking", () => {
  afterEach(() => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    h.pageUrl = "https://one.test/login";
    h.loaderId = "doc-1";
    h.download = false;
  });

  it("clears masking on navigation, and Cancel does not resurrect it", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    const routes = app();
    const token = await claim(routes);
    registerVaultFillSecret("target-1", "navigation-canary", "doc-1", "openclaw");
    expect(hasActiveVaultFill("target-1")).toBe(true);

    h.loaderId = "doc-2";
    h.pageUrl = "https://two.test/welcome";
    const navigated = await call(
      routes.postHandlers.get("/navigate")!,
      request({ targetId: "t1", url: h.pageUrl, humanControlToken: token }),
    );
    expect(navigated.statusCode).toBe(200);
    expect(hasActiveVaultFill("target-1")).toBe(false);

    const cancelled = await call(
      routes.postHandlers.get("/human-control/cancel")!,
      request({ targetId: "t1", humanControlToken: token }),
    );
    expect(cancelled.statusCode).toBe(200);
    expect(hasActiveVaultFill("target-1")).toBe(false);
  });

  it("keeps masking across a same-document navigation and a download", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    const routes = app();
    const token = await claim(routes);
    registerVaultFillSecret("target-1", "same-doc-canary", "doc-1", "openclaw");

    h.pageUrl = "https://one.test/login#section";
    const sameDocument = await call(
      routes.postHandlers.get("/navigate")!,
      request({ targetId: "t1", url: h.pageUrl, humanControlToken: token }),
    );
    expect(sameDocument.statusCode).toBe(200);
    expect(hasActiveVaultFill("target-1")).toBe(true);

    h.download = true;
    h.loaderId = "doc-2";
    const downloaded = await call(
      routes.postHandlers.get("/navigate")!,
      request({ targetId: "t1", url: "https://one.test/report.pdf", humanControlToken: token }),
    );
    expect(downloaded.statusCode).toBe(200);
    expect(hasActiveVaultFill("target-1")).toBe(true);
  });
});
