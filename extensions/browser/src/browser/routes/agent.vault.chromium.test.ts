import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test-support.js";
import { resolveBrowserConfig } from "../config.js";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../pw-session.js";
import { createBrowserRouteContext, type BrowserServerState } from "../server-context.js";
import { getFreePort } from "../test-port.js";
import {
  assertVaultFillActAllowed,
  clearAllVaultFillSessions,
  clearVaultFillSession,
  hasActiveVaultFill,
  scrubVaultFillText,
} from "../vault-fill-scrub.js";
import { registerBrowserVaultRoutes } from "./agent.vault.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CANARY = "chromium-canary-fill-4f8a2c";

type VaultObservation = {
  ok: true;
  targetId: string;
  origin: { scheme: "https" | "http"; host: string; port: number };
  documentId: string;
  frameId: string;
  fieldSignature: string;
};

function expectedFrom(observation: VaultObservation) {
  return {
    origin: observation.origin,
    documentId: observation.documentId,
    frameId: observation.frameId,
    fieldSignature: observation.fieldSignature,
  };
}

describe.runIf(process.env.OPENCLAW_BROWSER_VAULT_E2E === "1")(
  "synthetic Chromium vault fill",
  () => {
    afterEach(() => {
      clearAllVaultFillSessions();
    });

    it("fills exact origin, masks the document, rejects nested reads, and clears on approved submit", async () => {
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-vault-fill-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.route("http://127.0.0.1:11111/**", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Synthetic login</title>
              <form onsubmit="event.preventDefault(); document.body.dataset.submitted='yes'">
                <input id="username" autocomplete="username">
                <input id="password" type="password" autocomplete="current-password">
                <button type="submit">Sign in</button>
              </form>`,
          });
        });
        await page.goto("http://127.0.0.1:11111/login");
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const targetId = targetInfo.targetId;

        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "vault",
            evaluateEnabled: true,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: { vault: { cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        registerBrowserVaultRoutes(
          routes.app,
          createBrowserRouteContext({ getState: () => state }),
        );
        const observe = expectDefined(
          routes.postHandlers.get("/vault/observe"),
          "registered vault observe route",
        );
        const fill = expectDefined(
          routes.postHandlers.get("/vault/fill"),
          "registered vault fill route",
        );
        const submit = expectDefined(
          routes.postHandlers.get("/vault/submit"),
          "registered vault submit route",
        );

        const observeResponse = createBrowserRouteResponse();
        await observe(
          { params: {}, query: { profile: "vault" }, body: { targetId } },
          observeResponse.res,
        );
        expect(observeResponse.statusCode, JSON.stringify(observeResponse.body)).toBe(200);
        const observation = observeResponse.body as VaultObservation;
        expect(observation.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 11111 });
        expect(observation.documentId.length).toBeGreaterThan(0);

        const fillResponse = createBrowserRouteResponse();
        await fill(
          {
            params: {},
            query: { profile: "vault" },
            body: {
              targetId,
              password: CANARY,
              username: "person@example.com",
              expected: expectedFrom(observation),
            },
          },
          fillResponse.res,
        );
        expect(fillResponse.statusCode, JSON.stringify(fillResponse.body)).toBe(200);
        expect(fillResponse.body).toMatchObject({ ok: true, status: "filled" });
        expect(JSON.stringify(fillResponse.body)).not.toContain(CANARY);
        expect(await page.locator("#password").inputValue()).toBe(CANARY);
        expect(await page.locator("#username").inputValue()).toBe("person@example.com");
        expect(hasActiveVaultFill(targetId)).toBe(true);
        expect(scrubVaultFillText(targetId, CANARY)).toBe("***");
        expect(() =>
          assertVaultFillActAllowed(targetId, {
            kind: "batch",
            actions: [{ kind: "batch", actions: [{ kind: "evaluate", fn: "() => 1" }] }],
          }),
        ).toThrow(/evaluate/u);
        expect(() => assertVaultFillActAllowed(targetId, { kind: "press", key: "Enter" })).toThrow(
          /interactions are blocked/u,
        );

        const submitResponse = createBrowserRouteResponse();
        await submit(
          {
            params: {},
            query: { profile: "vault" },
            body: { targetId, expected: expectedFrom(observation) },
          },
          submitResponse.res,
        );
        expect(submitResponse.statusCode, JSON.stringify(submitResponse.body)).toBe(200);
        expect(await page.locator("body").getAttribute("data-submitted")).toBe("yes");
        expect(await page.locator("#password").inputValue()).toBe("");
        expect(hasActiveVaultFill(targetId)).toBe(false);
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);

    it("invalidates a same-URL reload and rejects a cross-origin password iframe", async () => {
      const port = await getFreePort();
      const cdpUrl = `http://127.0.0.1:${port}`;
      const context = await getPlaywrightCore().chromium.launchPersistentContext(
        path.join(tempDirs.make("openclaw-vault-reload-"), "profile"),
        {
          headless: true,
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
          args: [`--remote-debugging-port=${port}`],
        },
      );
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.route("http://127.0.0.1:11111/**", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Reload login</title>
              <input id="password" type="password" autocomplete="current-password">`,
          });
        });
        await page.route("http://127.0.0.1:22222/**", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Cross-origin password</title>
              <input id="password" type="password">`,
          });
        });
        await page.goto("http://127.0.0.1:11111/login");
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        const targetId = targetInfo.targetId;

        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "vault",
            evaluateEnabled: true,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: { vault: { cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const routes = createBrowserRouteApp();
        registerBrowserVaultRoutes(
          routes.app,
          createBrowserRouteContext({ getState: () => state }),
        );
        const observe = expectDefined(routes.postHandlers.get("/vault/observe"));
        const identity = expectDefined(routes.postHandlers.get("/vault/identity"));
        const fill = expectDefined(routes.postHandlers.get("/vault/fill"));

        const firstObserve = createBrowserRouteResponse();
        await observe(
          { params: {}, query: { profile: "vault" }, body: { targetId } },
          firstObserve.res,
        );
        const first = firstObserve.body as VaultObservation;
        expect(first.ok).toBe(true);

        await page.evaluate(() => {
          location.hash = "section";
        });
        const hashIdentity = createBrowserRouteResponse();
        await identity(
          { params: {}, query: { profile: "vault" }, body: { targetId } },
          hashIdentity.res,
        );
        expect(hashIdentity.body).toMatchObject({
          ok: true,
          documentId: first.documentId,
        });

        await page.reload();
        const secondObserve = createBrowserRouteResponse();
        await observe(
          { params: {}, query: { profile: "vault" }, body: { targetId } },
          secondObserve.res,
        );
        const second = secondObserve.body as VaultObservation;
        expect(second.ok).toBe(true);
        expect(second.documentId).not.toBe(first.documentId);

        const staleFill = createBrowserRouteResponse();
        await fill(
          {
            params: {},
            query: { profile: "vault" },
            body: {
              targetId,
              password: CANARY,
              expected: expectedFrom(first),
            },
          },
          staleFill.res,
        );
        expect(staleFill.statusCode, JSON.stringify(staleFill.body)).toBe(200);
        expect(staleFill.body).toMatchObject({
          ok: false,
          status: "document_changed",
          reasonCode: "page_changed_after_approval",
        });
        expect(await page.locator("#password").inputValue()).toBe("");

        const iframePage = await context.newPage();
        await iframePage.route("http://127.0.0.1:11111/frame-login", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Frame login</title>
              <input id="password" type="password">
              <iframe src="http://127.0.0.1:22222/frame"></iframe>`,
          });
        });
        await iframePage.route("http://127.0.0.1:22222/**", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Cross-origin password</title>
              <input id="password" type="password">`,
          });
        });
        await iframePage.goto("http://127.0.0.1:11111/frame-login");
        await iframePage.frameLocator("iframe").locator("#password").waitFor();
        const frameSession = await context.newCDPSession(iframePage);
        const frameTarget = await frameSession.send("Target.getTargetInfo");
        await frameSession.detach();
        const iframeObserve = createBrowserRouteResponse();
        await observe(
          {
            params: {},
            query: { profile: "vault" },
            body: { targetId: frameTarget.targetInfo.targetId },
          },
          iframeObserve.res,
        );
        expect(iframeObserve.body).toMatchObject({
          ok: false,
          status: "iframe_denied",
          reasonCode: "cross_origin_iframe",
        });

        const readonlyPage = await context.newPage();
        await readonlyPage.route("http://127.0.0.1:11111/readonly", async (route) => {
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>Readonly login</title>
              <input id="password" type="password" readonly>`,
          });
        });
        await readonlyPage.goto("http://127.0.0.1:11111/readonly");
        const readonlySession = await context.newCDPSession(readonlyPage);
        const readonlyTarget = await readonlySession.send("Target.getTargetInfo");
        await readonlySession.detach();
        const readonlyObserve = createBrowserRouteResponse();
        await observe(
          {
            params: {},
            query: { profile: "vault" },
            body: { targetId: readonlyTarget.targetInfo.targetId },
          },
          readonlyObserve.res,
        );
        const readonlyObservation = readonlyObserve.body as VaultObservation;
        expect(readonlyObservation.ok).toBe(true);
        const failedFill = createBrowserRouteResponse();
        await fill(
          {
            params: {},
            query: { profile: "vault" },
            body: {
              targetId: readonlyTarget.targetInfo.targetId,
              password: CANARY,
              expected: expectedFrom(readonlyObservation),
            },
          },
          failedFill.res,
        );
        expect(failedFill.body).toMatchObject({
          ok: false,
          status: "unavailable",
          reasonCode: "fill_failed",
        });
        // Protection is armed before insertion even when the fill fails.
        expect(hasActiveVaultFill(readonlyTarget.targetInfo.targetId)).toBe(true);
        expect(scrubVaultFillText(readonlyTarget.targetInfo.targetId, CANARY)).toBe("***");
        clearVaultFillSession(readonlyTarget.targetInfo.targetId);
      } finally {
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context.close();
      }
    }, 30_000);
  },
);
