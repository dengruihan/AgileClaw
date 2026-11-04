import { describe, expect, it, vi } from "vitest";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import {
  assertHumanControlAgentAllowed,
  HumanControlError,
  humanControlRegistry,
} from "../human-control.js";
import type { BrowserRouteContext } from "../server-context.js";
import { clearAllVaultFillSessions, scrubVaultFillText } from "../vault-fill-scrub.js";
import { registerBrowserHumanControlRoutes } from "./human-control.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const h = vi.hoisted(() => ({
  pageUrl: "https://example.test/login",
  focused: true,
  failIdentity: false,
  insertError: false,
  inserted: [] as string[],
  cookies: [{ name: "sid", domain: "example.test", path: "/", expires: -1 }],
  failCookies: false,
  focusGate: null as Promise<boolean> | null,
  resolveFocusStarted: null as (() => void) | null,
  cookiesGate: null as Promise<void> | null,
  resolveCookiesStarted: null as (() => void) | null,
}));

vi.mock("../pw-session-connection.js", () => ({
  getPageForTargetId: async () => ({
    url: () => h.pageUrl,
    evaluate: async () => {
      if (h.focusGate) {
        h.resolveFocusStarted?.();
        return await h.focusGate;
      }
      return h.focused;
    },
    keyboard: {
      insertText: async (text: string) => {
        if (h.insertError) {
          throw new Error(`synthetic transport echoed ${text}`);
        }
        h.inserted.push(text);
      },
    },
    context: () => ({
      cookies: async () => {
        if (h.cookiesGate) {
          h.resolveCookiesStarted?.();
          await h.cookiesGate;
        }
        if (h.failCookies) {
          throw new Error("cookie read failed");
        }
        return h.cookies;
      },
      newCDPSession: async () => ({
        send: async (method: string) => {
          if (h.failIdentity) {
            throw new Error("no document identity");
          }
          return method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "frame-1", loaderId: "doc-1" } } }
            : {};
        },
        detach: async () => undefined,
      }),
    }),
  }),
}));

const CANARY = "m37-sensitive-canary-9f3c";

function tab() {
  return {
    targetId: "target-1",
    tabId: "t1",
    title: "Synthetic login",
    url: h.pageUrl,
    type: "page",
  };
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
    ensureTabAvailable: async () => tab(),
    listTabs: async () => [tab()],
  };
  return {
    state: () => state as never,
    forProfile: () => profileCtx as never,
    listProfiles: async () => [],
  };
}

function request(body: Record<string, unknown>, connId = "conn-1", sharedSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = sharedSignal ?? controller.signal;
  return {
    req: {
      params: {},
      query: { profile: "openclaw" },
      body,
      signal,
      requester: {
        connId,
        signal,
        isCurrent: () => !signal.aborted,
      },
    },
    controller,
  };
}

function app() {
  const routes = createBrowserRouteApp();
  registerBrowserHumanControlRoutes(routes.app, routeContext());
  return routes;
}

async function call(handler: (req: never, res: never) => void | Promise<void>, req: unknown) {
  const response = createBrowserRouteResponse();
  await handler(req as never, response.res as never);
  return response;
}

describe("human takeover routes", () => {
  it("claims, exposes ownership, and releases with revalidated handback", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const status = routes.getHandlers.get("/human-control")!;
    const release = routes.postHandlers.get("/human-control/release")!;

    const claimed = await call(claim, request({ targetId: "t1", reason: "user_request" }).req);
    expect(claimed.statusCode).toBe(200);
    const claimBody = claimed.body as { control: { status: string }; humanControlToken: string };
    expect(claimBody.control.status).toBe("active");
    expect(claimBody.humanControlToken).toBeTruthy();
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrowError(
      HumanControlError,
    );

    const statusBody = (await call(status, request({}, "conn-1").req)).body as {
      control: { status: string };
      supported: boolean;
    };
    expect(statusBody.supported).toBe(true);
    expect(statusBody.control.status).toBe("active");

    h.pageUrl = "https://verify.example.test/verify";
    h.cookies = [{ name: "sid", domain: "example.test", path: "/", expires: -1 }];
    const released = await call(
      release,
      request({
        targetId: "t1",
        humanControlToken: claimBody.humanControlToken,
      }).req,
    );
    expect(released.statusCode).toBe(200);
    expect(released.body).toMatchObject({
      ok: true,
      control: null,
      handback: { originChanged: true, revalidated: true, documentId: "doc-1" },
    });
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).not.toThrow();
  });

  it("keeps the lease when the handback cannot revalidate the document", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const release = routes.postHandlers.get("/human-control/release")!;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    h.failIdentity = true;
    const released = await call(release, request({ targetId: "t1", humanControlToken: token }).req);
    h.failIdentity = false;
    expect(released.statusCode).toBe(409);
    expect(released.body).toMatchObject({ code: "HUMAN_CONTROL_REVALIDATION_FAILED" });
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrow();
    humanControlRegistry.revokeAll();
  });

  it("pauses the tab on an agent request without issuing a capability", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const requested = await call(
      routes.postHandlers.get("/human-control/request")!,
      request({ targetId: "t1", reason: "captcha" }).req,
    );
    expect(requested.statusCode).toBe(200);
    expect(requested.body).toMatchObject({
      control: { status: "requested", requestedBy: "agent", reason: "captcha" },
    });
    expect(requested.body).not.toHaveProperty("humanControlToken");
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrowError(
      /waiting for a human takeover/u,
    );
    humanControlRegistry.revokeAll();
  });

  it("accepts a human token on panel actions but not from an agent body", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    expect(() =>
      assertHumanControlAgentAllowed({
        profile: "openclaw",
        tab: tab(),
        body: { humanControlToken: token },
      }),
    ).not.toThrow();
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrow();
    humanControlRegistry.revokeAll();
  });

  it("inserts sensitive input without echoing it into the response or scrub output", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    h.inserted = [];
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const sensitive = routes.postHandlers.get("/human-input")!;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    const response = await call(
      sensitive,
      request({ targetId: "t1", text: CANARY, humanControlToken: token }).req,
    );
    expect(response.statusCode).toBe(200);
    expect(h.inserted).toEqual([CANARY]);
    expect(JSON.stringify(response.body)).not.toContain(CANARY);
    expect(scrubVaultFillText("target-1", `value=${CANARY}`)).toBe("value=***");
    clearAllVaultFillSessions();
    humanControlRegistry.revokeAll();
  });

  it("keeps a failed sensitive insert opaque and never logs the value", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    h.inserted = [];
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const sensitive = routes.postHandlers.get("/human-input")!;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    h.insertError = true;
    const response = await call(
      sensitive,
      request({ targetId: "t1", text: CANARY, humanControlToken: token }).req,
    );
    h.insertError = false;
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: false, reasonCode: "sensitive_input_failed" });
    expect(JSON.stringify(response.body)).not.toContain(CANARY);
    clearAllVaultFillSessions();
    humanControlRegistry.revokeAll();
  });

  it("requires an active human capability for sensitive input", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const sensitive = routes.postHandlers.get("/human-input")!;
    const response = await call(
      sensitive,
      request({ targetId: "t1", text: CANARY, humanControlToken: "wrong" }).req,
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain(CANARY);
  });

  it("does not create a lease when the requester disconnects during claim reads", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const closing = request({ targetId: "t1" }, "conn-claim-delay");

    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseCookies!: () => void;
    h.cookiesGate = new Promise<void>((resolve) => {
      releaseCookies = resolve;
    });
    h.resolveCookiesStarted = resolveStarted;
    const pending = call(claim, closing.req);
    await started;
    closing.controller.abort();
    releaseCookies();
    const response = await pending;
    h.cookiesGate = null;
    h.resolveCookiesStarted = null;

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toHaveProperty("humanControlToken");
    expect(
      humanControlRegistry.status({ profile: "openclaw", targetId: "target-1", tabId: "t1" }),
    ).toBeNull();
    humanControlRegistry.revokeAll();
  });

  it("fails closed when the claim-time document identity is unavailable", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const release = routes.postHandlers.get("/human-control/release")!;

    h.failIdentity = true;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    h.failIdentity = false;
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;
    const released = await call(release, request({ targetId: "t1", humanControlToken: token }).req);
    expect(released.statusCode).toBe(409);
    expect(released.body).toMatchObject({
      code: "HUMAN_CONTROL_REVALIDATION_FAILED",
      reasonCode: "baseline_unavailable",
    });
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrow();
    humanControlRegistry.revokeAll();
  });

  it("fails closed when the before/after login fingerprint is unavailable", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const release = routes.postHandlers.get("/human-control/release")!;

    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;
    h.failCookies = true;
    const released = await call(release, request({ targetId: "t1", humanControlToken: token }).req);
    h.failCookies = false;
    expect(released.statusCode).toBe(409);
    expect(released.body).toMatchObject({
      code: "HUMAN_CONTROL_REVALIDATION_FAILED",
      reasonCode: "login_state_unavailable",
    });
    expect(() => assertHumanControlAgentAllowed({ profile: "openclaw", tab: tab() })).toThrow();
    humanControlRegistry.revokeAll();
  });

  it("fails closed when the claim could not capture a login fingerprint", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const release = routes.postHandlers.get("/human-control/release")!;

    h.failCookies = true;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    h.failCookies = false;
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;
    const released = await call(release, request({ targetId: "t1", humanControlToken: token }).req);
    expect(released.statusCode).toBe(409);
    expect(released.body).toMatchObject({ reasonCode: "login_state_unavailable" });
    humanControlRegistry.revokeAll();
  });

  it("revalidates the capability after delayed focus work and refuses a disconnected insert", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    h.inserted = [];
    const routes = app();
    const sensitive = routes.postHandlers.get("/human-input")!;
    const closing = request({ targetId: "t1" }, "conn-disconnect");
    const claimed = await call(routes.postHandlers.get("/human-control/claim")!, closing.req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseFocus!: (value: boolean) => void;
    h.focusGate = new Promise<boolean>((resolve) => {
      releaseFocus = resolve;
    });
    h.resolveFocusStarted = resolveStarted;
    const pending = call(
      sensitive,
      request(
        { targetId: "t1", text: CANARY, humanControlToken: token },
        "conn-disconnect",
        closing.controller.signal,
      ).req,
    );
    await started;
    closing.controller.abort();
    releaseFocus(true);
    const response = await pending;
    h.focusGate = null;
    h.resolveFocusStarted = null;
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ reasonCode: "human_control_revoked" });
    expect(h.inserted).toEqual([]);
    clearAllVaultFillSessions();
    humanControlRegistry.revokeAll();
  });

  it("refuses insertion when another claim replaces the capability during delayed focus", async () => {
    humanControlRegistry.revokeAll();
    clearAllVaultFillSessions();
    h.inserted = [];
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const sensitive = routes.postHandlers.get("/human-input")!;
    const claimed = await call(claim, request({ targetId: "t1" }).req);
    const token = (claimed.body as { humanControlToken: string }).humanControlToken;

    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseFocus!: (value: boolean) => void;
    h.focusGate = new Promise<boolean>((resolve) => {
      releaseFocus = resolve;
    });
    h.resolveFocusStarted = resolveStarted;
    const pending = call(
      sensitive,
      request({ targetId: "t1", text: CANARY, humanControlToken: token }).req,
    );
    await started;
    await call(claim, request({ targetId: "t1" }).req);
    releaseFocus(true);
    const response = await pending;
    h.focusGate = null;
    h.resolveFocusStarted = null;
    expect(response.statusCode).toBe(409);
    expect(h.inserted).toEqual([]);
    clearAllVaultFillSessions();
    humanControlRegistry.revokeAll();
  });

  it("releases ownership when the claiming Gateway connection ends", async () => {
    humanControlRegistry.revokeAll();
    const routes = app();
    const claim = routes.postHandlers.get("/human-control/claim")!;
    const closing = request({ targetId: "t1" }, "conn-closing");
    await call(claim, closing.req);
    expect(
      humanControlRegistry.status({ profile: "openclaw", targetId: "target-1", tabId: "t1" }),
    ).not.toBeNull();
    closing.controller.abort();
    expect(
      humanControlRegistry.status({ profile: "openclaw", targetId: "target-1", tabId: "t1" }),
    ).toBeNull();
  });
});
