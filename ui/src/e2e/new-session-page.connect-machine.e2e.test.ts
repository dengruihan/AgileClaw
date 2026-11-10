import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

const joinSetup = (setupCode: string, joinUrl: string, expiresAtMs = Date.now() + 10 * 60_000) => ({
  setupId: `setup-${setupCode}`,
  setupCode,
  joinUrl,
  gatewayUrl: "wss://gateway.example.com",
  auth: "token",
  urlSource: "test",
  access: "node",
  expiresAtMs,
});

async function captureProof(
  page: Page,
  fileName: string,
  presentation?: { surface: Locator; content: readonly Locator[] },
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "connect-machine"), { recursive: true });
  if (page.video()) {
    await writeFile(
      path.join(suite.artifactDir, "connect-machine", fileName),
      await takeControlUiViewportScreenshot(
        page,
        presentation?.surface ?? page.locator(".shell"),
        presentation?.content ?? [page.locator(".new-session-page__message")],
      ),
    );
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(path.join(suite.artifactDir, "connect-machine"), fileName),
  });
}

async function openConnectMachine(page: Page) {
  await page.locator("#new-session-where-trigger").click();
  const connect = page.getByRole("button", { name: "Connect a device" });
  await connect.waitFor();
  await connect.click();
  return page.locator('openclaw-modal-dialog[label="Connect a machine"]');
}

suite.define(() => {
  it("lets admins transfer a guided one-paste machine pairing without a terminal command", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"],
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "connect-machine"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const firstJoinUrl = "https://gateway.example.com/j/first-code?label=alpha&next=$(whoami)";
    const secondJoinUrl = "https://gateway.example.com/j/second-code";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          sequence: [joinSetup("FIRST", firstJoinUrl), joinSetup("SECOND", secondJoinUrl)],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      const connect = place.getByRole("button", { name: "Connect a device" });
      await connect.waitFor();
      expect(await place.getByText("Your devices", { exact: true }).isVisible()).toBe(true);
      await captureProof(page, "01-picker-foot.png", {
        surface: place.locator('wa-popup [part="popup"]'),
        content: [connect],
      });
      await connect.click();

      const firstRequest = await gateway.waitForRequest("device.pair.setupCode");
      expect(firstRequest.params).toEqual({
        bootstrapProfile: "node",
        includeQr: false,
        joinUrl: true,
      });
      const dialog = openConnectMachineDialog(page);
      const steps = dialog.locator(".device-pair-setup__steps");
      await steps.waitFor();
      const guidedText = (await dialog.textContent()) ?? "";
      expect(guidedText).not.toContain("npx openclaw");
      expect(guidedText).not.toContain("openclaw node run");
      expect(guidedText).not.toContain(firstJoinUrl);
      expect(guidedText).toContain("Install the app on that machine");
      expect(guidedText).toContain("Send the one-time pairing link");
      await dialog.getByText(/This link is single-use and expires in/u).waitFor();
      const downloadLinks = dialog.locator(".device-pair-setup__downloads a");
      expect(await downloadLinks.count()).toBe(3);
      expect(await downloadLinks.first().getAttribute("target")).toBe("_blank");

      const copy = dialog.locator(".device-pair-setup__secret .chat-copy-btn");
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(firstJoinUrl);
      // Copying never unmasks; only the reveal toggle shows the secret.
      expect(
        (await dialog.locator(".device-pair-setup__secret code").textContent()) ?? "",
      ).not.toContain(firstJoinUrl);
      await captureProof(page, "02-connect-dialog.png", {
        surface: dialog.locator("dialog"),
        content: [copy],
      });

      await dialog.locator('.device-pair-setup__secret button[aria-pressed="false"]').click();
      await expect
        .poll(() => dialog.locator(".device-pair-setup__secret code").textContent())
        .toContain(firstJoinUrl);
      const fallback = dialog.locator(".device-pair-setup__fallback");
      expect((await fallback.locator("code").textContent()) ?? "").toContain("FIRST");
      await fallback.locator("summary").click();
      await fallback.locator(".chat-copy-btn").waitFor();

      await dialog.getByRole("button", { name: "New code" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("device.pair.setupCode")).length)
        .toBe(2);
      expect((await gateway.getRequests("device.pair.setupCode"))[1]?.params).toEqual({
        bootstrapProfile: "node",
        includeQr: false,
        joinUrl: true,
      });
      // A regenerated setup starts masked again; the retired URL is gone from the DOM.
      await steps.getByText(/This link is single-use and expires in/u).waitFor();
      const secret = dialog.locator(".device-pair-setup__secret code");
      await expect.poll(() => secret.textContent()).toContain(SECRET_MASK_PLACEHOLDER_CHECK);
      expect((await secret.textContent()) ?? "").not.toContain(firstJoinUrl);
      await dialog.locator('.device-pair-setup__secret button[aria-pressed="false"]').click();
      await expect.poll(() => secret.textContent()).toContain(secondJoinUrl);
    } finally {
      await context.close();
    }
  });

  it("hides machine connection from non-admin operators", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      await place.locator('[data-value="gateway"]').waitFor();
      expect(await place.getByRole("button", { name: "Connect a device" }).count()).toBe(0);
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("shows a retryable error with a connection-settings deep link when minting fails", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const joinUrl = "https://gateway.example.com/j/retried-code";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": joinSetup("RETRIED", joinUrl),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      await gateway.deferNext("device.pair.setupCode");
      const dialog = await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      await dialog.getByText("Creating a secure setup code…", { exact: true }).waitFor();
      await captureProof(page, "03-connect-loading.png");

      await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
      await page.clock.runFor(100);

      await dialog
        .getByRole("alert")
        .filter({ hasText: "gateway request timed out after 30000ms: device.pair.setupCode" })
        .waitFor();
      expect(await dialog.getByText("Creating a secure setup code…", { exact: true }).count()).toBe(
        0,
      );
      await captureProof(page, "04-connect-timeout.png");

      const deepLink = dialog.getByRole("button", { name: "Connection settings" });
      await deepLink.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/connection");
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");

      const reopened = await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      await reopened.getByText(/This link is single-use and expires in/u).waitFor();
      expect(await gateway.getRequests("device.pair.setupCode")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("redacts sensitive connection-link failures before rendering them", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });
    const secret = "e2e-pairing-bearer-secret";

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      await gateway.rejectDeferred("device.pair.setupCode", {
        message: `pairing failed: Authorization: Bearer ${secret}`,
      });

      const alert = page
        .locator('openclaw-modal-dialog[label="Connect a machine"]')
        .getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("Authorization: [redacted]");
      expect(await alert.textContent()).not.toContain(secret);
    } finally {
      await context.close();
    }
  });

  it("closes an in-flight connection dialog when the Gateway reconnects", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["device.pair.setupCode"],
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      const dialog = page.locator('openclaw-modal-dialog[label="Connect a machine"]');
      await dialog.getByText("Creating a secure setup code…", { exact: true }).waitFor();

      await gateway.closeLatest(1012, "test reconnect");

      await expect.poll(() => dialog.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

function openConnectMachineDialog(page: Page) {
  return page.locator('openclaw-modal-dialog[label="Connect a machine"]');
}

const SECRET_MASK_PLACEHOLDER_CHECK = "••••••";
