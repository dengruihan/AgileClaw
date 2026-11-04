// Control UI Security page transcript-redaction toggle mocked Gateway E2E.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI security redaction toggle mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

// CAPTURE_BEFORE=1 renders the same page without asserting the new row, for
// before/after comparison against a checkout that predates the toggle.
const captureBefore = process.env.CAPTURE_BEFORE === "1";

function configResponse(redact: "tools" | "off" | undefined, hash: string) {
  const config = redact === undefined ? {} : { logging: { redact } };
  return {
    config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config mutation params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

async function captureProof(fileName: string, content: Locator): Promise<void> {
  const page = content.page();
  await writeFile(
    path.join(suite.artifactDir, fileName),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
  );
}

async function switchChecked(toggle: Locator): Promise<boolean> {
  return toggle.evaluate((element) =>
    Boolean((element as HTMLElement & { checked?: boolean }).checked),
  );
}

suite.define(() => {
  it("toggles logging.redact from the Security overview and warns while off", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        const defaultConfig = configResponse(undefined, "hash-1");
        const offConfig = configResponse("off", "hash-2");
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": { sequence: [defaultConfig, offConfig] },
            "config.set": offConfig,
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/security`);
        const row = page.locator(".settings-row", {
          has: page.getByText("Sensitive-value redaction", { exact: true }),
        });
        if (captureBefore) {
          await page.locator(".security-page .settings-section").first().waitFor();
          expect(await row.count()).toBe(0);
          await captureProof("before-security-overview.png", page.locator(".security-page"));
          return;
        }

        const onSwitch = row.locator("wa-switch");
        await onSwitch.waitFor();
        expect(await switchChecked(onSwitch)).toBe(true);
        expect(await row.textContent()).not.toContain("Off:");
        await captureProof("after-redaction-on.png", row);

        await onSwitch.click();
        const raw = requestRaw(await gateway.waitForRequest("config.set"));
        expect(raw).toEqual({ logging: { redact: "off" } });

        const offPage = await page.context().newPage();
        await installMockGateway(offPage, { methodResponses: { "config.get": offConfig } });
        await offPage.goto(`${suite.server.baseUrl}settings/security`);
        const offRow = offPage.locator(".settings-row", {
          has: offPage.getByText("Sensitive-value redaction", { exact: true }),
        });
        const offSwitch = offRow.locator("wa-switch");
        await offSwitch.waitFor();
        expect(await switchChecked(offSwitch)).toBe(false);
        const offText = await offRow.textContent();
        expect(offText).toContain("Off:");
        expect(offText).toContain("masking is disabled, including registered secret values");
        await writeFile(
          path.join(suite.artifactDir, "after-redaction-off.png"),
          await takeControlUiViewportScreenshot(offPage, offPage.locator(".shell"), [offRow]),
        );
        await offPage.close();
      },
    );
  });
});
