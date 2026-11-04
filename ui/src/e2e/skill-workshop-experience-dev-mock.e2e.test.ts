// Proves the standalone dev mock advertises and serves the Experience section
// end to end, not just the Playwright fixture Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";
import {
  startControlUiMockDevServer,
  stopControlUiMockDevServer,
  type ControlUiMockDevServer,
} from "../test-helpers/control-ui-mock-dev-server.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeDevMock = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiMockDevServer;

describeDevMock("Skill Workshop Experience dev mock", () => {
  beforeAll(async () => {
    server = await startControlUiMockDevServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await stopControlUiMockDevServer(server);
  });

  it("edits and promotes an experience through the advertised dev-mock methods", async () => {
    const artifacts = createControlUiE2eArtifactDir("workshop-experience-dev-mock");
    const context = await browser.newContext({
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    try {
      await page.goto(new URL("/skills/workshop", server.url).toString(), {
        waitUntil: "networkidle",
      });
      await page.locator(".sw-collection__shelf").waitFor();
      await page.locator("#skill-workshop-mode-tab-experience").click();
      await page.locator(".sw-experience__row").first().waitFor();

      await page.locator(".sw-experience__row", { hasText: "release-rollback-check" }).click();
      const edit = page.getByRole("button", { name: "Edit", exact: true });
      await expect.poll(async () => edit.isEnabled()).toBe(true);
      await edit.click();
      const editor = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await editor.waitFor();
      await editor.getByLabel("Summary").fill("Updated through the standalone dev mock.");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(async () => page.locator("openclaw-modal-dialog").count()).toBe(0);
      await page
        .locator(".sw-experience__detail")
        .getByText("Updated through the standalone dev mock.")
        .waitFor();

      await page.getByRole("button", { name: "Promote to skill", exact: true }).click();
      const promote = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await promote.waitFor();
      await promote
        .locator(".sw-experience__fixed-target")
        .getByText("release-rollback-check", { exact: true })
        .waitFor();
      await promote.getByLabel("Skill description").fill("Rollback check from the dev mock.");
      await promote.getByRole("button", { name: "Create draft suggestion" }).click();
      await page.locator("#skill-workshop-mode-tab-suggestions[active]").waitFor();
      await page.getByText("Promote release-rollback-check", { exact: true }).first().waitFor();
      await page.screenshot({ path: `${artifacts}/dev-mock-promoted.png` });

      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.getByText("Applied", { exact: true }).first().waitFor();
      await page.locator("#skill-workshop-mode-tab-experience").click();
      const promotedChip = page.locator(".sw-experience__chip", { hasText: "Promoted" });
      await expect.poll(async () => promotedChip.getAttribute("aria-pressed")).toBe("true");
      await page.getByText("Promoted to release-rollback-check").first().waitFor();
      await page.screenshot({ path: `${artifacts}/dev-mock-applied.png` });

      await page.locator(".sw-experience__chip", { hasText: "Candidate" }).click();
      await page.locator(".sw-experience__row", { hasText: "proxy-header-recovery" }).click();
      await page.getByRole("button", { name: "Promote to skill", exact: true }).click();
      const rejectPromote = page.locator("openclaw-modal-dialog .sw-experience-dialog");
      await rejectPromote.waitFor();
      await rejectPromote
        .locator(".sw-experience__fixed-target")
        .getByText("proxy-header-recovery", { exact: true })
        .waitFor();
      await rejectPromote.getByLabel("Skill description").fill("Proxy recovery from the dev mock.");
      await rejectPromote.getByRole("button", { name: "Create draft suggestion" }).click();
      await page.locator("#skill-workshop-mode-tab-suggestions[active]").waitFor();
      await page.getByText("Promote proxy-header-recovery", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByText("Rejected", { exact: true }).first().waitFor();
      await page.locator("#skill-workshop-mode-tab-experience").click();
      await page.locator(".sw-experience__chip", { hasText: "Candidate" }).click();
      await page.getByText("Promotion rejected. This stays a candidate.").first().waitFor();
      await page.screenshot({ path: `${artifacts}/dev-mock-rejected.png` });
    } finally {
      await context.close();
    }
  }, 120_000);
});
