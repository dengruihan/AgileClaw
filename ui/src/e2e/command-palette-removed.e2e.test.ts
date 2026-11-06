// Control UI tests cover the retired command palette: no entry points or
// shortcut may reopen it, while slash commands and session search stay usable.
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiGatewayReady,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI command palette removal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
if (captureUiProof) {
  artifactDir = createControlUiE2eArtifactDir("command-palette-removed");
}

suite.define(() => {
  it("has no palette entry or shortcut while slash commands remain available", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 900 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await waitForControlUiGatewayReady(page);

        const header = page.locator(".chat-pane__header").first();
        await header.getByRole("button", { name: "Expand sidebar" }).waitFor();
        await expect
          .poll(() => header.getByRole("button", { name: "Open command palette" }).count())
          .toBe(0);
        await expect
          .poll(() => page.getByRole("button", { name: "Open command palette" }).count())
          .toBe(0);

        await header.locator(".chat-header-session-menu__trigger").click();
        await expect
          .poll(() => page.getByText("Open command palette", { exact: true }).count())
          .toBe(0);
        await page.keyboard.press("Escape");

        await page.keyboard.press("ControlOrMeta+k");
        await expect.poll(() => page.locator("openclaw-command-palette").count()).toBe(0);
        await expect.poll(() => page.locator(".cmd-palette").count()).toBe(0);

        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.focus();
        await page.keyboard.type("/");
        const slashMenu = page.locator(".slash-menu");
        await slashMenu.waitFor({ state: "visible" });
        expect(await slashMenu.getByText("Slash commands", { exact: true }).count()).toBe(1);

        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "narrow-header-and-slash-menu.png"),
          });
        }
      },
    );
  });

  it("keeps the Sessions transcript search entry", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}sessions`);
        await waitForControlUiGatewayReady(page);
        await page.getByRole("button", { name: "Search transcripts" }).waitFor();
      },
    );
  });
});
