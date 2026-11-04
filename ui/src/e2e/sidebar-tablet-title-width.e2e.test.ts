// Tablet rails split the viewport with a narrow content column. Their session
// titles must keep a reading width instead of collapsing to a few glyphs.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  sessionsListResponse,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const longTitle = "Quarterly infrastructure cost review with the platform team";
const secondTitle = "Release readiness checklist for the November cutover";

const viewports = [
  { name: "tablet-portrait-768", width: 768, height: 1024, touch: true, drawer: true, wrap: false },
  { name: "tablet-portrait-834", width: 834, height: 1112, touch: true, drawer: true, wrap: false },
  {
    name: "tablet-landscape-1024",
    width: 1024,
    height: 768,
    touch: true,
    drawer: false,
    wrap: true,
  },
  {
    name: "tablet-landscape-1180",
    width: 1180,
    height: 820,
    touch: true,
    drawer: false,
    wrap: true,
  },
  // Guards: a desktop pointer keeps one-line titles, a phone keeps its drawer.
  { name: "desktop-1280", width: 1280, height: 900, touch: false, drawer: false, wrap: false },
  { name: "phone-390", width: 390, height: 844, touch: true, drawer: true, wrap: false },
] as const;

async function installTabletRoster(page: Page) {
  await installMockGateway(page, {
    sessionGroups: ["Research"],
    sessionKey: "agent:main:main",
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          key: "agent:main:main",
          kind: "direct",
          label: longTitle,
          updatedAt: 4_000,
          unread: true,
        },
        {
          key: "agent:main:research",
          kind: "direct",
          label: longTitle,
          category: "Research",
          updatedAt: 3_000,
          status: "done",
          lastMessagePreview: "The tablet layout sweep keeps every action reachable",
        },
        {
          key: "agent:main:release",
          kind: "direct",
          label: secondTitle,
          category: "Research",
          updatedAt: 2_000,
          hasActiveRun: true,
          status: "running",
        },
        {
          key: "agent:main:docs",
          kind: "direct",
          label: "Docs polish for the tablet layout sweep",
          updatedAt: 1_000,
          lastMessagePreview: "Wrapping and width budget notes",
        },
      ]),
    },
  });
}

suite.define(() => {
  it.each(viewports)("keeps a readable session title at $name", async (viewport) => {
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      hasTouch: viewport.touch,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: viewport.height, width: viewport.width },
    });
    const page = await context.newPage();
    try {
      await installTabletRoster(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.locator("openclaw-app-sidebar").waitFor({ state: "attached" });
      if (viewport.drawer) {
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        await waitForMobileSidebarDrawerOpen(page);
      }
      const anchored = page.locator('.sidebar-recent-session[data-session-key="agent:main:main"]');
      await anchored.waitFor({ state: "visible", timeout: 10_000 });

      const reading = await anchored.evaluate((row) => {
        const name = row.querySelector<HTMLElement>(".sidebar-recent-session__name");
        const actions = row.querySelector<HTMLElement>(".session-row-actions");
        const pin = row.querySelector<HTMLElement>("[data-sidebar-session-pin]");
        const archive = row.querySelector<HTMLElement>("[data-sidebar-session-archive]");
        const menu = row.querySelector<HTMLElement>(".session-action--touch-menu");
        return {
          actionsRight: actions ? Math.round(actions.getBoundingClientRect().right) : 0,
          archivesVisible: archive ? getComputedStyle(archive).display !== "none" : false,
          menuVisible: menu ? getComputedStyle(menu).display !== "none" : false,
          nameRight: name ? Math.round(name.getBoundingClientRect().right) : 0,
          pinsVisible: pin ? getComputedStyle(pin).display !== "none" : false,
          rowWidth: Math.round(row.getBoundingClientRect().width),
          titleHeight: name ? Math.round(name.getBoundingClientRect().height) : 0,
          titleLineHeight: name ? Number.parseFloat(getComputedStyle(name).lineHeight) || 0 : 0,
          titleWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
        };
      });

      // Capture and report before asserting, so a regression still leaves proof.
      await captureUiProof(suite, page, `${viewport.name}-${reading.titleWidth}px.png`);
      console.log(
        `[m48] tablet-title ${viewport.name} title=${reading.titleWidth}px/${reading.titleHeight}px row=${reading.rowWidth}px`,
      );

      // A tablet rail wraps the title instead of starving it, and the row still
      // ends before the trailing controls that own its actions.
      if (viewport.wrap) {
        expect(reading.titleWidth).toBeGreaterThanOrEqual(140);
        expect(reading.titleHeight).toBeGreaterThanOrEqual(reading.titleLineHeight * 1.9);
      } else {
        expect(reading.titleHeight).toBeLessThanOrEqual(reading.titleLineHeight * 1.3);
      }
      expect(reading.nameRight).toBeLessThanOrEqual(reading.actionsRight);
      // Every documented touch action stays available. A phone drawer keeps Pin
      // and Archive inside the menu; a fixed touch rail keeps both in the row.
      if (viewport.touch) {
        expect(reading.menuVisible).toBe(true);
        if (!viewport.drawer) {
          expect(reading.pinsVisible).toBe(true);
          expect(reading.archivesVisible).toBe(true);
        }
      }

      // Crossing out of the tablet band drops the floor again, so a tablet docked
      // to a large display keeps the rail the operator stored.
      if (viewport.wrap) {
        await page.setViewportSize({ height: 900, width: 1400 });
        await expect
          .poll(() =>
            page
              .locator(".shell-nav")
              .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
          )
          .toBe(258);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(viewports.filter((viewport) => viewport.wrap))(
    "keeps an expanded child row readable at $name",
    async (viewport) => {
      const context = await suite.newBrowserContext({
        colorScheme: "dark",
        hasTouch: viewport.touch,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: viewport.height, width: viewport.width },
      });
      const page = await context.newPage();
      // The anchor promotes its children to roots by contract, so the nesting
      // disclosure belongs to an ordinary parent session.
      const parentKey = "agent:main:release";
      const childKey = "agent:main:release-child";
      try {
        await installMockGateway(page, {
          sessionKey: parentKey,
          methodResponses: {
            "sessions.list": sessionsListResponse([
              {
                key: parentKey,
                kind: "direct",
                label: longTitle,
                updatedAt: 3_000,
                hasActiveRun: true,
                status: "running",
                childSessions: [childKey],
              },
              {
                key: childKey,
                kind: "direct",
                label: "A very long child session name for the tablet sweep",
                spawnedBy: parentKey,
                updatedAt: 2_000,
                status: "done",
              },
              {
                key: "agent:main:main",
                kind: "direct",
                label: secondTitle,
                updatedAt: 1_000,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
        const parentRow = page.locator(`.sidebar-recent-session[data-session-key="${parentKey}"]`);
        await parentRow.waitFor({ state: "visible", timeout: 10_000 });
        const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
        const childRow = page.locator(`.sidebar-recent-session[data-session-key="${childKey}"]`);
        await childRow.waitFor({ state: "visible", timeout: 10_000 });

        const reading = await childRow.evaluate((row) => {
          const name = row.querySelector<HTMLElement>(".sidebar-recent-session__name");
          const title = name?.getBoundingClientRect();
          return {
            childTitleWidth: title ? Math.round(title.width) : 0,
            rowWidth: Math.round(row.getBoundingClientRect().width),
          };
        });
        await captureUiProof(
          suite,
          page,
          `${viewport.name}-child-${reading.childTitleWidth}px.png`,
        );
        console.log(
          `[m48] tablet-child ${viewport.name} child=${reading.childTitleWidth}px row=${reading.rowWidth}px`,
        );

        // The expanded child is indented beside the same compact actions, so its
        // title budget is smaller than the parent's but must stay readable.
        expect(reading.childTitleWidth).toBeGreaterThanOrEqual(70);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
