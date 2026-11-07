import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance control layout",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps appearance controls accessible across responsive layouts", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { height: 1000, width: 1440 } },
      async ({ page }) => {
        const config = { ui: { prefs: { themeMode: "dark" } } };
        await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "appearance-layout",
              config,
              configRevisionHash: "appearance-layout",
              hash: "appearance-layout",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await waitForControlUiSettingsTakeover(page);

        const appearanceHeadings = await page
          .locator(
            ".settings-page > .settings-section > .settings-section__header > .settings-section__heading",
          )
          .allTextContents();
        const colorModeIndex = appearanceHeadings.findIndex(
          (heading) => heading.trim() === "Color mode",
        );
        expect(
          appearanceHeadings
            .slice(colorModeIndex, colorModeIndex + 3)
            .map((heading) => heading.trim()),
        ).toEqual(["Color mode", "Typography", "Text size"]);

        const colorMode = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: "Color mode" }) });
        await page.setViewportSize({ height: 1000, width: 768 });
        await expect
          .poll(() => colorMode.evaluate((element) => getComputedStyle(element).flexDirection))
          .toBe("column");
        await page.setViewportSize({ height: 1000, width: 769 });
        await expect
          .poll(() => colorMode.evaluate((element) => getComputedStyle(element).flexDirection))
          .toBe("row");
      },
    );
  });
});
