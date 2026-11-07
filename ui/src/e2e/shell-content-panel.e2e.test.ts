import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI shell content panel" });

type Rect = { left: number; top: number; right: number; bottom: number };

type CanvasFrame = {
  background: string;
  borderWidth: string;
  content: Rect & { background: string; borderWidth: string; radius: string };
  nav: Rect;
  radius: string;
  shell: Rect;
  viewport: { width: number; height: number };
};

async function readCanvasFrame(page: Page): Promise<CanvasFrame> {
  return page.evaluate(() => {
    const shell = document.querySelector(".shell");
    const content = document.querySelector(".content");
    const nav = document.querySelector(".shell-nav");
    if (!shell || !content || !nav) {
      throw new Error("Expected the shell plate, its navigation, and its content");
    }
    const rect = (element: Element): Rect => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const shellStyle = getComputedStyle(shell);
    const contentStyle = getComputedStyle(content);
    return {
      background: shellStyle.backgroundColor,
      borderWidth: shellStyle.borderTopWidth,
      content: {
        ...rect(content),
        background: contentStyle.backgroundColor,
        borderWidth: contentStyle.borderTopWidth,
        radius: contentStyle.borderTopLeftRadius,
      },
      nav: rect(nav),
      radius: shellStyle.borderTopLeftRadius,
      shell: rect(shell),
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });
}

function expectRoundedPlate(frame: CanvasFrame, label: string) {
  // One rounded base plate floats on the window canvas: the external
  // background stays exposed on every side, and navigation, the settings rail,
  // and the main content all ride inside the same frame.
  expect(frame.shell.left, `${label}: leading inset`).toBeGreaterThanOrEqual(7);
  expect(frame.shell.top, `${label}: top inset`).toBeGreaterThanOrEqual(7);
  expect(
    frame.viewport.width - frame.shell.right,
    `${label}: trailing inset`,
  ).toBeGreaterThanOrEqual(7);
  expect(
    frame.viewport.height - frame.shell.bottom,
    `${label}: bottom inset`,
  ).toBeGreaterThanOrEqual(7);
  expect(Number.parseFloat(frame.radius), `${label}: plate radius`).toBeGreaterThanOrEqual(18);
  expect(frame.borderWidth, `${label}: plate edge`).toBe("1px");
  expect(frame.background, `${label}: plate fill`).not.toBe("rgba(0, 0, 0, 0)");
  // The navigation column and the main column sit on the plate itself.
  expect(frame.nav.left, `${label}: nav on plate`).toBeGreaterThanOrEqual(frame.shell.left);
  expect(frame.nav.top, `${label}: nav top on plate`).toBeGreaterThanOrEqual(frame.shell.top);
  expect(frame.nav.bottom, `${label}: nav bottom on plate`).toBeLessThanOrEqual(frame.shell.bottom);
  expect(frame.content.left, `${label}: content on plate`).toBeGreaterThanOrEqual(frame.nav.right);
  expect(frame.content.right, `${label}: content edge on plate`).toBeLessThanOrEqual(
    frame.shell.right,
  );
  // No nested second card: the content column keeps no panel frame of its own.
  expect(frame.content.background, `${label}: content repaints the plate`).toBe("rgba(0, 0, 0, 0)");
  expect(frame.content.borderWidth, `${label}: content edge`).toBe("0px");
  expect(frame.content.radius, `${label}: content radius`).toBe("0px");
}

suite.define(() => {
  it("floats one rounded base plate across new, dashboards, and settings", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("connect");
        await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        const home = await readCanvasFrame(page);
        await writeFile(
          path.join(suite.artifactDir, "canvas-new.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".new-session-page__message"),
          ]),
        );

        await page.goto(`${suite.server.baseUrl}dashboards`);
        await page.locator(".dashboards-gallery, [data-dashboards-empty]").first().waitFor({
          state: "visible",
        });
        const dashboards = await readCanvasFrame(page);
        await writeFile(
          path.join(suite.artifactDir, "canvas-dashboards.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page
              .locator(".dashboards-toolbar, .dashboards-gallery, [data-dashboards-empty]")
              .first(),
          ]),
        );

        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await page.locator(".settings-sidebar__nav").waitFor({ state: "visible" });
        const settings = await readCanvasFrame(page);
        await writeFile(
          path.join(suite.artifactDir, "canvas-settings.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".settings-workspace"),
          ]),
        );

        expectRoundedPlate(home, "new");
        expectRoundedPlate(dashboards, "dashboards");
        expectRoundedPlate(settings, "settings");
        // One shared visual language: the settings takeover and the app shell
        // must not each grow their own radius, fill, or edge.
        expect(settings.radius).toBe(home.radius);
        expect(settings.background).toBe(home.background);
        expect(settings.borderWidth).toBe(home.borderWidth);
        expect(dashboards.radius).toBe(home.radius);
      },
    );
  });

  it("keeps the primary new-session action full width, left aligned, and navigable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}dashboards`);
        const action = page.locator(".sidebar-primary-actions .sidebar-new-session-action");
        await action.waitFor({ state: "visible" });

        const layout = await action.evaluate((element) => {
          const icon = element.querySelector("svg");
          const label = element.querySelector(".new-session-link__label");
          const slot = element.closest(".sidebar-primary-actions");
          if (!icon || !label || !slot) {
            throw new Error("Expected the new-session icon, label, and full-width slot");
          }
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          const iconBox = icon.getBoundingClientRect();
          const labelBox = label.getBoundingClientRect();
          return {
            actionWidth: box.width,
            background: style.backgroundColor,
            borderRadius: Number.parseFloat(style.borderTopLeftRadius),
            iconBeforeLabel: iconBox.right <= labelBox.left,
            iconLeftInset: Math.round(iconBox.left - box.left),
            justify: style.justifyContent,
            slotWidth: slot.getBoundingClientRect().width,
          };
        });

        expect(layout.actionWidth).toBeCloseTo(layout.slotWidth, 0);
        expect(layout.justify).toBe("flex-start");
        expect(layout.iconBeforeLabel).toBe(true);
        expect(layout.iconLeftInset).toBeGreaterThan(0);
        expect(layout.borderRadius).toBeGreaterThanOrEqual(10);

        await action.hover();
        // The surface eases over --duration-fast; poll past the transition.
        await expect
          .poll(() => action.evaluate((element) => getComputedStyle(element).backgroundColor))
          .not.toBe(layout.background);

        await action.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      },
    );
  });

  it("keeps mobile content full bleed while the drawer keeps the new-session action", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        isMobile: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--mobile-nav");

        const frame = await readCanvasFrame(page);
        // The drawer shell owns the window edge: no plate frame may squeeze
        // phone content or leave a sliver of canvas beside it.
        expect(frame.shell.left).toBe(0);
        expect(frame.shell.top).toBe(0);
        expect(frame.shell.right).toBe(frame.viewport.width);
        expect(frame.shell.bottom).toBe(frame.viewport.height);
        expect(frame.radius).toBe("0px");
        expect(frame.borderWidth).toBe("0px");
        expect(frame.content.left).toBeCloseTo(frame.shell.left, 0);
        expect(frame.content.right).toBeCloseTo(frame.shell.right, 0);
        expect(frame.content.radius).toBe("0px");
        expect(frame.content.background).toBe("rgba(0, 0, 0, 0)");
        expect(frame.content.borderWidth).toBe("0px");

        await page.locator(".topbar-nav-toggle").first().click({ force: true });
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-drawer-open");
        // The drawer slides in; wait for its settled edge before capture/assertions.
        await expect
          .poll(() =>
            page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().left),
          )
          .toBe(0);
        const drawerAction = page.locator(".sidebar-primary-actions .sidebar-new-session-action");
        await drawerAction.waitFor({ state: "visible" });
        await writeFile(
          path.join(suite.artifactDir, "canvas-mobile-drawer.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [drawerAction]),
        );
        const drawer = await drawerAction.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            justify: style.justifyContent,
            radius: Number.parseFloat(style.borderTopLeftRadius),
            withinViewport: element.getBoundingClientRect().right <= window.innerWidth,
          };
        });
        expect(drawer.justify).toBe("flex-start");
        expect(drawer.radius).toBeGreaterThanOrEqual(10);
        expect(drawer.withinViewport).toBe(true);
      },
    );
  });
});
