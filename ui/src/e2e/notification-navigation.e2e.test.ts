import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI notification navigation",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const currentKey = "agent:main:notification-current";
const targetKey = "agent:main:notification-target";
const unreadMarker = 1_800_000_000_001;

/**
 * The bundled E2E bundle is built outside production mode, so main.ts never
 * registers the worker itself. Register the same shipped sw.js the app uses.
 */
async function registerNotificationWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?v=notification-navigation-e2e");
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(
    () => navigator.serviceWorker.controller?.state === "activated",
    undefined,
    { timeout: 60_000 },
  );
}

// Mirrors the exact message and port the service worker transfers on a
// notification click; the real click cannot be synthesized in the browser.
async function dispatchNotificationNavigation(page: Page, targetUrl: string) {
  return await page.evaluate(async (url) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      throw new Error("Control UI is not controlled by its service worker");
    }
    const channel = new MessageChannel();
    const acknowledged = new Promise<unknown>((resolve) => {
      channel.port2.addEventListener("message", (event) => resolve(event.data), { once: true });
      channel.port2.start();
    });
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "openclaw-notification-navigate", url },
        ports: [channel.port1],
        source: controller,
      }),
    );
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), 5_000);
    });
    return (await Promise.race([acknowledged, timeout])) ?? null;
  }, targetUrl);
}

async function waitForVisibleSessionPane(page: Page, sessionKey: string): Promise<void> {
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")].some(
        (pane) =>
          pane.classList.contains("chat-pane-cache__pane--visible") &&
          (pane as HTMLElement & { sessionKey?: string }).sessionKey === key,
      ),
    sessionKey,
  );
}

async function visibleSessionKeys(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")]
      .filter((pane) => pane.classList.contains("chat-pane-cache__pane--visible"))
      .map((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey ?? ""),
  );
}

async function installNotificationGateway(page: Page) {
  const unreadTarget = sessionRow(targetKey, "Notification target", 20, {
    icon: "📬",
    markedUnreadAt: unreadMarker,
    unread: true,
  });
  const current = sessionRow(currentKey, "Current thread", 10, { unread: false });
  const sessions = [unreadTarget, current];
  return await installMockGateway(page, {
    featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
    hasMultipleSessionSharingIdentities: false,
    operatorScopes: ["operator.write"],
    sessionKey: currentKey,
    sessions,
    methodResponses: { "sessions.list": sessionsListResponse(sessions) },
  });
}

suite.define(() => {
  it("routes an unread notification target without rebuilding the document", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const gateway = await installNotificationGateway(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, currentKey));
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      await page.evaluate(() => {
        (window as Window & { notificationDocumentMarker?: string }).notificationDocumentMarker =
          "same-document";
      });
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const socketCount = await gateway.getSocketCount();
      const connectCount = (await gateway.getRequests("connect")).length;
      // Child-session lists are scoped to the visible pane; only the roster read
      // proves whether the roster restarted.
      const rosterReadMatch = { agentId: "main", includeGlobal: true };
      const rosterListCount = (await gateway.getRequests("sessions.list", rosterReadMatch)).length;
      const rosterSubscribeCount = (await gateway.getRequests("sessions.subscribe")).length;

      const reply = await dispatchNotificationNavigation(
        page,
        controlUiSessionUrl(suite.server.baseUrl, targetKey),
      );

      expect(reply).toEqual({ handled: true });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(targetKey));
      await waitForVisibleSessionPane(page, targetKey);

      // The click must not rebuild the document, its Gateway socket, or roster.
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { notificationDocumentMarker?: string }).notificationDocumentMarker,
        ),
      ).toBe("same-document");
      expect(await gateway.getSocketCount()).toBe(socketCount);
      await expectRequestCountStable(gateway, "connect", connectCount);
      await expectRequestCountStable(
        gateway,
        "sessions.list",
        rosterListCount,
        500,
        rosterReadMatch,
      );
      await expectRequestCountStable(gateway, "sessions.subscribe", rosterSubscribeCount);

      // The target session is selected, read, and acknowledged in app.
      const acknowledgement = await gateway.waitForRequest("sessions.patch", {
        match: { key: targetKey, unread: false },
      });
      expect(acknowledgement.params).toMatchObject({ expectedMarkedUnreadAt: unreadMarker });
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(targetKey));
    });
  });

  it("settles a retained session preview without rebuilding the document", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const gateway = await installNotificationGateway(page);
      // Visit the target first so the chat page retains its pane in this document.
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, targetKey));
      await waitForVisibleSessionPane(page, targetKey);
      await navigateToControlUiSession(page, currentKey);
      await waitForVisibleSessionPane(page, currentKey);
      await navigateToControlUiSession(page, targetKey);
      await waitForVisibleSessionPane(page, targetKey);
      await navigateToControlUiSession(page, currentKey);
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      const socketCount = await gateway.getSocketCount();

      // The sidebar's navigation intent presents the retained target as a
      // preview while the route still belongs to the current session.
      await page.evaluate((sessionKey) => {
        window.dispatchEvent(
          new CustomEvent("openclaw:session-navigation-intent", {
            cancelable: true,
            detail: { commit: () => true, face: "chat", sessionKey },
          }),
        );
      }, targetKey);
      await expect.poll(() => visibleSessionKeys(page)).toContain(targetKey);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(currentKey));

      const reply = await dispatchNotificationNavigation(
        page,
        controlUiSessionUrl(suite.server.baseUrl, targetKey),
      );

      expect(reply).toEqual({ handled: true });
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(await gateway.getSocketCount()).toBe(socketCount);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(targetKey));
      await waitForVisibleSessionPane(page, targetKey);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(targetKey));
    });
  });

  it.each([
    {
      name: "an approval document route",
      target: (baseUrl: string) => `${baseUrl}approve/exec%3A1`,
    },
    {
      name: "another Gateway's handoff",
      target: (_baseUrl: string, targetUrl: string) =>
        `${targetUrl}#gatewayUrl=wss%3A%2F%2Fother.example`,
    },
  ])("leaves $name to the service worker's document navigation", async ({ target }) => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      await installNotificationGateway(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, currentKey));
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      const documentUrl = page.url();
      const targetUrl = target(
        suite.server.baseUrl,
        controlUiSessionUrl(suite.server.baseUrl, targetKey),
      );

      const reply = await dispatchNotificationNavigation(page, targetUrl);

      expect(reply).toEqual({ handled: false });
      expect(page.url()).toBe(documentUrl);
      await waitForVisibleSessionPane(page, currentKey);
    });
  });
});
