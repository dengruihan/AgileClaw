import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite(
  "Control UI sidebar navigation spacing mocked Gateway E2E",
);

suite.define(() => {
  // The Pages zone seats its route entries as console keys (layout.css); the
  // zone grid's row gap is the only separation between adjacent key faces, so
  // it must keep a visible pause and the keys' faces and click targets must
  // stay clear at ordinary heights and inside the bounded compact rail.
  const navSpacingMatrix = [
    { height: 800, width: 1280 },
    { height: 500, width: 1280 },
    { height: 360, width: 1280 },
  ] as const;

  it.each(navSpacingMatrix)(
    "keeps the Dashboard and Automations nav keys separated with clear faces at $width x $height",
    async ({ height, width }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height, width },
      });
      const page = await context.newPage();
      await installMockGateway(page, { sessionKey: "agent:main:main" });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const dashboards = page.locator(
          '.sidebar-zone-entry[data-sidebar-entry="route:dashboards"] .nav-item',
        );
        const automations = page.locator(
          '.sidebar-zone-entry[data-sidebar-entry="route:cron"] .nav-item',
        );
        await dashboards.waitFor();
        await automations.waitFor();

        const readNavGeometry = () =>
          page.evaluate(() => {
            const face = (entry: string) => {
              const element = document.querySelector<HTMLElement>(
                `.sidebar-zone-entry[data-sidebar-entry="${entry}"] .nav-item`,
              );
              if (!element) {
                return null;
              }
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, height: rect.height };
            };
            const receivesClickAtFace = (entry: string) => {
              const element = document.querySelector<HTMLElement>(
                `.sidebar-zone-entry[data-sidebar-entry="${entry}"] .nav-item`,
              );
              if (!element) {
                return false;
              }
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return hit !== null && (element === hit || element.contains(hit));
            };
            const railRect = document
              .querySelector<HTMLElement>(".sidebar-nav")
              ?.getBoundingClientRect();
            const sessionTop = document
              .querySelector<HTMLElement>(".sidebar-session-content")
              ?.getBoundingClientRect().top;
            return {
              railTop: railRect?.top ?? -1,
              railBottom: railRect?.bottom ?? -1,
              sessionTop: sessionTop ?? -1,
              dashboards: face("route:dashboards"),
              automations: face("route:cron"),
              dashboardsClickable: receivesClickAtFace("route:dashboards"),
              automationsClickable: receivesClickAtFace("route:cron"),
            };
          });
        const rail = page.locator(".sidebar-nav");
        // The bounded compact rail may scroll: bring one key fully into the
        // rail's visible box before judging its face and click target.
        const revealNavKey = (entry: string) =>
          rail.evaluate((element, entrySelector) => {
            const key = document.querySelector(
              `.sidebar-zone-entry[data-sidebar-entry="${entrySelector}"] .nav-item`,
            );
            if (!key) {
              return;
            }
            const keyRect = key.getBoundingClientRect();
            const railRect = element.getBoundingClientRect();
            if (keyRect.top < railRect.top) {
              element.scrollTop += keyRect.top - railRect.top;
            } else if (keyRect.bottom > railRect.bottom) {
              element.scrollTop += keyRect.bottom - railRect.bottom;
            }
          }, entry);

        // Retain the rendered state before asserting so a failing gap floor
        // still leaves inspectable evidence of the pre-fix spacing.
        await captureSidebarUiProof(suite, page, `nav-spacing-sidebar-${height}.png`);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await writeFile(
            path.join(suite.artifactDir, `nav-spacing-nav-rail-${height}.png`),
            await takeControlUiElementScreenshot(page, rail, [dashboards, automations]),
          );
        }

        const resting = await readNavGeometry();
        expect(resting.dashboards, "the Dashboard key renders").not.toBeNull();
        expect(resting.automations, "the Automations key renders").not.toBeNull();
        const gap = resting.automations!.top - resting.dashboards!.bottom;
        // Floor sits just under the styled 6px gap so sub-pixel rounding
        // cannot flake, while the pre-fix 2px separation still fails it.
        expect(
          gap,
          "the Dashboard and Automations keys keep a visible separation",
        ).toBeGreaterThanOrEqual(5.5);
        expect(
          resting.dashboards!.bottom,
          "the Dashboard key never reaches into the Automations key",
        ).toBeLessThanOrEqual(resting.automations!.top);
        expect(
          resting.sessionTop - resting.railBottom,
          "the nav rail and session content containers keep their own visible separation",
        ).toBeGreaterThanOrEqual(11.5);
        for (const [label, entry] of [
          ["Dashboard", "route:dashboards"],
          ["Automations", "route:cron"],
        ] as const) {
          await revealNavKey(entry);
          const revealed = await readNavGeometry();
          const keyFace = entry === "route:dashboards" ? revealed.dashboards : revealed.automations;
          expect(
            keyFace !== null &&
              keyFace.top >= revealed.railTop - 0.5 &&
              keyFace.bottom <= revealed.railBottom + 0.5,
            `${label} shows its whole face inside the nav rail`,
          ).toBe(true);
          expect(
            entry === "route:dashboards"
              ? revealed.dashboardsClickable
              : revealed.automationsClickable,
            `${label} receives clicks on its own face`,
          ).toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
