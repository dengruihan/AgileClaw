import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const PAGE_URL = "https://login.example.test/verify";
const ACTIVE_CONTROL = {
  owner: "human" as const,
  status: "active" as const,
  reason: "two_factor",
  requestedBy: "agent" as const,
  profile: "openclaw",
  targetId: "raw-form",
  tabId: "form-tab",
  generation: 2,
  claimedAtMs: 1_760_000_000_000,
  expiresAtMs: 1_760_000_300_000,
};

const suite = createControlUiE2eSuite({
  name: "Control UI browser human takeover",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("shows ownership before and after takeover and routes sensitive text", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        // Synthesize the remote page image so the panel proof shows a realistic
        // verification screen without touching a live browser profile.
        const fixture = await page.context().newPage();
        await fixture.setContent(`<!doctype html><html><body style="margin:0;font-family:system-ui;background:#f8fafc;color:#0f172a">
          <main style="max-width:620px;margin:60px auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:16px">
            <h1 style="font-size:26px;margin:0 0 12px">Verify it’s you</h1>
            <p style="color:#475569;margin:0 0 24px">Enter the 6-digit code from your authenticator app.</p>
            <input aria-label="Verification code" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:18px" />
            <button style="margin-top:18px;padding:10px 18px;border:0;border-radius:10px;background:#0f172a;color:#fff;font-size:15px">Verify</button>
          </main></body></html>`);
        const fixtureImage = await fixture.screenshot({ type: "png" });
        await fixture.close();
        await page.route("**/__openclaw__/assistant-media**", (route) =>
          route.fulfill({ contentType: "image/png", body: fixtureImage }),
        );

        const gateway = await installMockGateway(page, {
          featureMethods: ["browser.request"],
          operatorScopes: ["operator.admin"],
          methodResponses: {
            "browser.request": {
              cases: [
                {
                  match: { path: "/tabs" },
                  response: {
                    running: true,
                    tabs: [
                      {
                        tabId: "form-tab",
                        targetId: "raw-form",
                        title: "Verify it’s you",
                        url: PAGE_URL,
                      },
                    ],
                  },
                },
                {
                  match: { path: "/human-control" },
                  response: { ok: true, supported: true, control: null },
                },
                {
                  match: { path: "/human-control/claim" },
                  response: {
                    ok: true,
                    targetId: "raw-form",
                    tabId: "form-tab",
                    control: ACTIVE_CONTROL,
                    humanControlToken: "synthetic-takeover-token",
                  },
                },
                { match: { path: "/human-input" }, response: { ok: true, targetId: "raw-form" } },
                {
                  match: { path: "/human-control/release" },
                  response: { ok: true, control: null },
                },
                {
                  match: { path: "/screencast" },
                  response: {
                    __mockError: { code: "UNAVAILABLE", message: "Screencast unavailable" },
                  },
                },
                {
                  match: { path: "/screenshot" },
                  response: { targetId: "raw-form", path: "/proof/verify.png", url: PAGE_URL },
                },
                {
                  match: { path: "/act" },
                  response: {
                    result: {
                      cssWidth: 800,
                      cssHeight: 600,
                      title: "Verify it’s you",
                      url: PAGE_URL,
                    },
                  },
                },
              ],
            },
          },
        });

        await page.goto(
          `${suite.server.baseUrl}focus/browser?sessionKey=agent%3Amain%3Awork&target=host&profile=openclaw&targetId=form-tab`,
        );
        const panel = page.locator("openclaw-browser-panel");
        await panel.locator(".bp-shot").waitFor();
        await panel.locator(".bp-controlbar").waitFor();
        await panel.getByRole("button", { name: "Take over this tab" }).waitFor();
        await captureUiProof(
          { artifactDir: suite.artifactDir },
          page,
          "browser-human-takeover",
          "desktop-before.png",
        );

        await page.setViewportSize({ width: 420, height: 800 });
        await panel.locator(".bp-controlbar").waitFor();
        await captureUiProof(
          { artifactDir: suite.artifactDir },
          page,
          "browser-human-takeover",
          "narrow-before.png",
        );

        await panel.getByRole("button", { name: "Take over this tab" }).click();
        await panel.locator(".bp-controlbar--human").waitFor();
        await captureUiProof(
          { artifactDir: suite.artifactDir },
          page,
          "browser-human-takeover",
          "narrow-after.png",
        );

        await page.setViewportSize({ width: 1280, height: 900 });
        await panel.locator(".bp-controlbar--human").waitFor();
        await captureUiProof(
          { artifactDir: suite.artifactDir },
          page,
          "browser-human-takeover",
          "desktop-after.png",
        );

        const input = panel.locator(".bp-input");
        await input.evaluate((element) => {
          element.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "insertText",
              data: "482913",
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        const sensitive = await gateway.waitForRequest("browser.request", {
          match: { path: "/human-input" },
        });
        expect(asNullableRecord(sensitive.params)).toMatchObject({
          method: "POST",
          path: "/human-input",
          body: {
            targetId: "form-tab",
            text: "482913",
            humanControlToken: "synthetic-takeover-token",
          },
        });
        const actBodies = (await gateway.getRequests("browser.request")).flatMap((request) => {
          const params = asNullableRecord(request.params);
          return params?.path === "/act" ? [asNullableRecord(params.body)] : [];
        });
        expect(actBodies.some((body) => body?.kind === "insertText")).toBe(false);
      },
    );
  });
});
