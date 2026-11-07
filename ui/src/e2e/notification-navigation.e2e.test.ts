import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import type { BrowserContext, Page } from "playwright";
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
const otherGatewayUrl = "wss://other.example/openclaw?tenant=second";

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

/**
 * Dispatches the worker's real notificationclick listener. Playwright cannot
 * click an OS notification, but evaluating in the service-worker scope drives
 * the shipped handler, its handshake, and its document fallback for real.
 */
async function dispatchNotificationClick(
  context: BrowserContext,
  data: { url: string; explicitUrl?: boolean },
): Promise<void> {
  const worker =
    context.serviceWorkers().find((candidate) => candidate.url().includes("/sw.js")) ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(async (notificationData) => {
    let completion: Promise<unknown> | undefined;
    const event = new Event("notificationclick") as Event & {
      notification: { close(): void; data: unknown };
      waitUntil(promise: Promise<unknown>): void;
    };
    event.notification = { close() {}, data: notificationData };
    event.waitUntil = (promise) => {
      completion = promise;
    };
    self.dispatchEvent(event);
    if (!completion) {
      throw new Error("notificationclick did not register waitUntil work");
    }
    await completion;
  }, data);
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

async function markDocument(page: Page): Promise<number> {
  return await page.evaluate(() => {
    (window as Window & { notificationDocumentMarker?: string }).notificationDocumentMarker =
      "same-document";
    return performance.timeOrigin;
  });
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
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ context, page }) => {
      const gateway = await installNotificationGateway(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, currentKey));
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      const timeOrigin = await markDocument(page);
      const socketCount = await gateway.getSocketCount();
      const connectCount = (await gateway.getRequests("connect")).length;
      // Child-session lists are scoped to the visible pane; only the roster read
      // proves whether the roster restarted.
      const rosterReadMatch = { agentId: "main", includeGlobal: true };
      const rosterListCount = (await gateway.getRequests("sessions.list", rosterReadMatch)).length;
      const rosterSubscribeCount = (await gateway.getRequests("sessions.subscribe")).length;

      await dispatchNotificationClick(context, {
        explicitUrl: true,
        url: controlUiSessionUrl(suite.server.baseUrl, targetKey),
      });

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
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ context, page }) => {
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
      const timeOrigin = await markDocument(page);
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

      await dispatchNotificationClick(context, {
        explicitUrl: true,
        url: controlUiSessionUrl(suite.server.baseUrl, targetKey),
      });

      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(await gateway.getSocketCount()).toBe(socketCount);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(targetKey));
      await waitForVisibleSessionPane(page, targetKey);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(targetKey));
    });
  });

  it("loads the approval document for an approval notification", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ context, page }) => {
      await installNotificationGateway(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, currentKey));
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      const timeOrigin = await markDocument(page);
      const approvalPath = "/approve/exec%3A1";

      await dispatchNotificationClick(context, {
        explicitUrl: true,
        url: `${suite.server.baseUrl.replace(/\/$/u, "")}${approvalPath}`,
      });

      // Shellless approvals need a fresh document; the worker fallback owns it.
      await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
      expect(new URL(page.url()).pathname).toBe(approvalPath);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { notificationDocumentMarker?: string }).notificationDocumentMarker,
        ),
      ).toBeUndefined();
    });
  });

  it("loads the owning Gateway document for a same-path cross-Gateway notification", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ context, page }) => {
      await installNotificationGateway(page);
      const currentPath = controlUiSessionUrl(suite.server.baseUrl, currentKey);
      await page.goto(currentPath);
      await waitForVisibleSessionPane(page, currentKey);
      await registerNotificationWorker(page);
      const timeOrigin = await markDocument(page);
      const handoffUrl = new URL(page.url());
      handoffUrl.hash = new URLSearchParams({ gatewayUrl: otherGatewayUrl }).toString();

      await dispatchNotificationClick(context, { explicitUrl: true, url: handoffUrl.href });

      // A fragment-only navigation never leaves the document; the fallback must
      // force the owning-Gateway bootstrap instead of staying on this tenant.
      await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const url = new URL(window.location.href);
            return { hash: url.hash, search: url.search };
          }),
        )
        .toEqual({ hash: "", search: "" });
      const confirmation = page.locator("openclaw-gateway-url-confirmation");
      await confirmation.waitFor();
      expect(await confirmation.textContent()).toContain(otherGatewayUrl);
      await page.locator(".gateway-switch__actions .btn.primary").click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: {
                context: { gateway: { connection: { gatewayUrl: string } } };
              };
            };
            return app.runtime?.context.gateway.connection.gatewayUrl;
          }),
        )
        .toBe(otherGatewayUrl);
    });
  });
});
