import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
let proofDir: string;
beforeEach(() => {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    proofDir = createControlUiE2eArtifactDir("inference-setup-gate");
  }
});

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

suite.define(() => {
  it("keeps help available on empty chat home while messages require a model", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { agentModel: null });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(1);
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      const welcome = page.locator(".agent-chat__welcome--setup");
      const setupAction = page.getByRole("button", { name: "Connect an AI provider", exact: true });
      await expect.poll(() => setupAction.count()).toBe(1);
      await captureProof(page, "chat-home-desktop.png");
      await setupAction.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
      await page.goBack();
      const sendButton = page.getByRole("button", { name: "Send message", exact: true });
      await textarea.fill("/help");
      await expect.poll(() => sendButton.isDisabled()).toBe(false);
      await sendButton.click();
      await page.getByText("Available Commands", { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => welcome.count()).toBe(0);
      await expect.poll(() => setupAction.count()).toBe(1);
      await expect
        .poll(() =>
          page.locator(".agent-chat__composer-shell").evaluate((shell) => {
            const banner = shell.querySelector(".agent-chat__disabled-banner");
            const input = shell.querySelector(".agent-chat__input");
            if (!banner || !input) {
              throw new Error("expected setup notice above the composer");
            }
            const bannerStyle = getComputedStyle(banner);
            const inputStyle = getComputedStyle(input);
            const bannerBox = banner.getBoundingClientRect();
            const inputBox = input.getBoundingClientRect();
            return {
              radiusMatches: bannerStyle.borderRadius === inputStyle.borderRadius,
              shapeMatches:
                bannerStyle.getPropertyValue("corner-shape") ===
                inputStyle.getPropertyValue("corner-shape"),
              edgesMatch:
                Math.abs(bannerBox.left - inputBox.left) <= 1 &&
                Math.abs(bannerBox.right - inputBox.right) <= 1,
            };
          }),
        )
        .toEqual({ radiusMatches: true, shapeMatches: true, edgesMatch: true });
      await captureProof(page, "chat-help-desktop.png");
      await setupAction.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
      await page.goBack();
      await textarea.fill("Start a conversation.");
      await expect.poll(() => sendButton.isDisabled()).toBe(true);
      expect(await textarea.inputValue()).toBe("Start a conversation.");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("blocks the new-session composer until a model is connected", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, { agentModel: null });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();

      await expect.poll(() => page.locator(".new-session-page__composer").count()).toBe(0);
      await expect.poll(() => page.locator("textarea").count()).toBe(0);
      await captureProof(page, "new-session-desktop.png");
      await page.getByRole("button", { name: "Connect an AI provider" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
    } finally {
      await context.close();
    }
  });
});
