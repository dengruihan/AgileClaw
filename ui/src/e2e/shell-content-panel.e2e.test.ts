import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI shell content panel" });

type Rect = { left: number; top: number; right: number; bottom: number; width: number };

type PanelFrame = {
  background: string;
  borderWidth: string;
  content: Rect;
  radius: string;
  shell: Rect;
};

async function readPanelFrame(page: Page): Promise<PanelFrame> {
  return page.evaluate(() => {
    const shell = document.querySelector(".shell");
    const content = document.querySelector(".content");
    if (!shell || !content) {
      throw new Error("Expected the shell and content surfaces");
    }
    const rect = (element: Element): Rect => {
      const { left, top, right, bottom, width } = element.getBoundingClientRect();
      return { left, top, right, bottom, width };
    };
    const style = getComputedStyle(content);
    return {
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      content: rect(content),
      radius: style.borderTopLeftRadius,
      shell: rect(shell),
    };
  });
}

function expectRoundedPanel(frame: PanelFrame, label: string) {
  // The panel floats inside the shell grid on all four sides, not just below
  // the navigation rail: the same frame applies to home, settings, and routes.
  expect(frame.content.left - frame.shell.left, `${label}: leading inset`).toBeGreaterThanOrEqual(
    7,
  );
  expect(frame.content.top - frame.shell.top, `${label}: top inset`).toBeGreaterThanOrEqual(7);
  expect(
    frame.shell.right - frame.content.right,
    `${label}: trailing inset`,
  ).toBeGreaterThanOrEqual(7);
  expect(
    frame.shell.bottom - frame.content.bottom,
    `${label}: bottom inset`,
  ).toBeGreaterThanOrEqual(7);
  expect(Number.parseFloat(frame.radius), `${label}: corner radius`).toBeGreaterThanOrEqual(12);
  expect(frame.borderWidth, `${label}: panel edge`).toBe("1px");
  // A transparent surface cannot read as an inset panel; any paint (including a
  // translucent fill) proves the shell canvas is covered by the reading surface.
  expect(frame.background, `${label}: panel fill`).not.toBe("rgba(0, 0, 0, 0)");
}

suite.define(() => {
  it("draws one rounded content panel across home and settings", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("connect");
        await page.locator(".new-session-page__message").waitFor({ state: "visible" });
        const home = await readPanelFrame(page);
        await writeFile(
          path.join(suite.artifactDir, "content-panel-new.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".new-session-page__message"),
          ]),
        );

        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await page.locator(".settings-sidebar__nav").waitFor({ state: "visible" });
        const settings = await readPanelFrame(page);
        await writeFile(
          path.join(suite.artifactDir, "content-panel-settings.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".settings-workspace"),
          ]),
        );

        expectRoundedPanel(home, "new");
        expectRoundedPanel(settings, "settings");
        // One shared visual language: the takeover and the app shell must not
        // each grow their own radius, fill, or edge.
        expect(settings.radius).toBe(home.radius);
        expect(settings.background).toBe(home.background);
        expect(settings.borderWidth).toBe(home.borderWidth);
      },
    );
  });

  it("keeps the primary new-session action full width, left aligned, and navigable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}dashboard`);
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

        const frame = await readPanelFrame(page);
        // The drawer shell owns the window edge: no panel frame may squeeze
        // phone content or leave a sliver of canvas beside it.
        expect(frame.content.left).toBeCloseTo(frame.shell.left, 0);
        expect(frame.content.right).toBeCloseTo(frame.shell.right, 0);
        expect(frame.radius).toBe("0px");
        expect(frame.background).toBe("rgba(0, 0, 0, 0)");
        expect(frame.borderWidth).toBe("0px");

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
          path.join(suite.artifactDir, "content-panel-mobile-drawer.png"),
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
