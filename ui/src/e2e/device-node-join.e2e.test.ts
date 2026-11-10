// Control UI tests cover the guided gateway-side node join: join URL primary,
// bare setup-code fallback for plaintext LAN, and expiry/redeem/approval
// recovery — through the mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

const PLAINTEXT_JOIN_REFUSAL =
  "Join URLs require a TLS gateway endpoint, except for loopback. Use the setup code directly for plaintext LAN pairing.";

const nodeJoinSetup = (
  setupId: string,
  setupCode: string,
  joinUrl?: string,
  expiresAtMs = Date.now() + 10 * 60_000,
) => ({
  setupId,
  setupCode,
  ...(joinUrl ? { joinUrl } : {}),
  gatewayUrl: joinUrl ? "wss://gateway.example.com" : "ws://gateway.example.com",
  auth: "token",
  urlSource: "test",
  access: "node",
  expiresAtMs,
});

async function openConnectMachine(page: Page) {
  await page.locator("#new-session-where-trigger").click();
  const connect = page.getByRole("button", { name: "Connect a device" });
  await connect.waitFor();
  await connect.click();
  return page.locator('openclaw-modal-dialog[label="Connect a machine"]');
}

suite.define(() => {
  // Visual proof rides the behavioral scenarios so every captured state is one
  // the assertions above it already proved, at whatever SHA the lane ran.
  let proofDir = "";
  beforeEach(() => {
    proofDir = captureUiProofEnabled ? createControlUiE2eArtifactDir("device-node-join") : "";
  });
  const capture = async (page: Page, fileName: string) => {
    if (!captureUiProofEnabled) {
      return;
    }
    await page.screenshot({ animations: "disabled", path: path.join(proofDir, fileName) });
  };

  it("settles a redeemed join URL into success with inventory and approval links", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"],
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const joinUrl = "https://gateway.example.com/j/join-success";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": nodeJoinSetup("setup-join", "JOIN_CODE", joinUrl),
        "device.pair.setupStatus": {},
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const dialog = await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      const secret = dialog.locator(".device-pair-setup__secret code");
      await dialog.getByText(/This link is single-use and expires in/u).waitFor();
      expect((await secret.textContent()) ?? "").not.toContain(joinUrl);
      await capture(page, "01-join-waiting.png");

      // The joining machine redeems the link; the Gateway broadcasts completion.
      await gateway.emitGatewayEvent("device.pair.setup.completed", {
        setupId: "setup-join",
        deviceId: "machine-join",
        deviceName: "Lab Mac",
        access: "node",
        ts: Date.now(),
      });
      await dialog.getByText("Lab Mac", { exact: true }).waitFor();
      expect(
        await dialog.getByText("Device paired · Node access", { exact: true }).isVisible(),
      ).toBe(true);
      // The redeemed secret must be retired from the DOM, not left revealed or masked.
      expect(await dialog.locator(".device-pair-setup__secret").count()).toBe(0);
      expect((await dialog.textContent()) ?? "").not.toContain(joinUrl);
      await capture(page, "02-join-success.png");

      await dialog.getByRole("button", { name: "Open device inventory" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
    } finally {
      await context.close();
    }
  });

  it("falls back to the bare setup code when the gateway refuses a plaintext join URL", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      permissions: ["clipboard-read", "clipboard-write"],
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": {
          sequence: [
            { __mockError: { code: "UNAVAILABLE", message: PLAINTEXT_JOIN_REFUSAL } },
            nodeJoinSetup("setup-plain", "PLAIN_CODE"),
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const dialog = await openConnectMachine(page);
      await dialog.getByText("Share the setup code instead", { exact: true }).waitFor();

      const requests = await gateway.getRequests("device.pair.setupCode");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.params).toEqual({
        bootstrapProfile: "node",
        includeQr: false,
        joinUrl: true,
      });
      expect(requests[1]?.params).toEqual({ bootstrapProfile: "node", includeQr: false });

      const guidedText = (await dialog.textContent()) ?? "";
      expect(guidedText).toContain(
        "This Gateway address is not encrypted, so one-time links are unavailable.",
      );
      // The fallback secret is masked like the join URL; only reveal shows the code.
      expect(guidedText).not.toContain("PLAIN_CODE");
      expect(await dialog.locator(".device-pair-setup__fallback").count()).toBe(0);
      await dialog.getByText(/This setup code expires in/u).waitFor();

      const code = dialog.locator(".device-pair-setup__secret code");
      expect((await code.textContent()) ?? "").not.toContain("PLAIN_CODE");
      await capture(page, "03-plaintext-fallback-mobile.png");
      await dialog.locator('.device-pair-setup__secret button[aria-pressed="false"]').click();
      await expect.poll(() => code.textContent()).toContain("PLAIN_CODE");
      await dialog.locator(".device-pair-setup__secret .chat-copy-btn").click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("PLAIN_CODE");
      await capture(page, "04-plaintext-revealed-mobile.png");

      // Phone layout: guided steps stay inside the viewport without clipping.
      const overflow = await page.evaluate(() => {
        const step = document.querySelector<HTMLElement>(".device-pair-setup__step");
        const secretRow = document.querySelector<HTMLElement>(".device-pair-setup__secret");
        return {
          pageOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          stepOverflow: step ? step.scrollWidth > step.clientWidth + 1 : false,
          secretOverflow: secretRow ? secretRow.scrollWidth > secretRow.clientWidth + 1 : false,
        };
      });
      expect(overflow).toEqual({ pageOverflow: false, stepOverflow: false, secretOverflow: false });
    } finally {
      await context.close();
    }
  });

  it("recovers an expired setup into its recorded outcome instead of a dead end", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": nodeJoinSetup(
          "setup-expiry",
          "EXPIRY_CODE",
          "https://gateway.example.com/j/expiry-link",
          Date.now() + 2_000,
        ),
        "device.pair.setupStatus": {
          completion: {
            setupId: "setup-expiry",
            deviceId: "machine-expiry",
            deviceName: "Recovered Mac",
            access: "node",
            ts: Date.now(),
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      const dialog = await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");
      await dialog.getByText(/This link is single-use and expires in/u).waitFor();

      await page.clock.fastForward(2_100);
      await dialog.getByText("Recovered Mac", { exact: true }).waitFor();
      expect(await dialog.getByText("Setup code expired", { exact: true }).count()).toBe(0);
      await expect
        .poll(async () => (await gateway.getRequests("device.pair.setupStatus")).length)
        .toBe(1);
      await capture(page, "05-expiry-reconciled-success.png");
    } finally {
      await context.close();
    }
  });

  it("surfaces delivery uncertainty as a recoverable terminal state", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "device.pair.setupCode": nodeJoinSetup(
          "setup-uncertain",
          "UNCERTAIN_CODE",
          "https://gateway.example.com/j/uncertain-link",
          Date.now() + 2_000,
        ),
        "device.pair.setupStatus": {
          deliveryUncertain: {
            setupId: "setup-uncertain",
            deviceId: "machine-uncertain",
            access: "node",
            ts: Date.now(),
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.clock.install();
      const dialog = await openConnectMachine(page);
      await gateway.waitForRequest("device.pair.setupCode");

      await page.clock.fastForward(2_100);
      await dialog
        .getByRole("heading", { name: "Pairing delivery could not be confirmed" })
        .waitFor();
      await capture(page, "06-delivery-uncertain.png");
      await dialog.getByRole("button", { name: "Generate new code" }).click();
      await gateway.setMethodResponse(
        "device.pair.setupCode",
        nodeJoinSetup(
          "setup-regenerated",
          "REGEN_CODE",
          "https://gateway.example.com/j/regen-link",
          Date.now() + 10 * 60_000,
        ),
      );
      await dialog.getByText(/This link is single-use and expires in/u).waitFor();
    } finally {
      await context.close();
    }
  });
});
