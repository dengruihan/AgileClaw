import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  type ControlUiMockGatewayScenario,
  type MockGatewayRequest,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
  openSidebarCustomizationPage,
  openSidebarMoreMenu,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar interactions mocked Gateway E2E");

suite.define(() => {
  it("scrolls long session lists inside a fixed well without moving sidebar chrome", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        sessionRow(`agent:main:work-${index}`, `Work session ${index}`, baseTime - index * 60_000, {
          worktree: { branch: `openclaw/wt-${index}`, repoRoot: "/Users/dev/Projects/clawdbot" },
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - (index + 10) * 60_000),
      ),
    ];
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 620, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
      },
      sessionKey: "agent:main:main",
      presenceUsers: [{ self: true, id: "fixed-sidebar-user", name: "Riley" }],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.locator(".sidebar-online").waitFor({ state: "visible" });
      await page.locator('[data-session-section="work"] .sidebar-session-group-toggle').click();
      const loadMore = page
        .locator('[data-session-section="ungrouped"]')
        .getByRole("button", { name: "Show more" });
      for (let pageIndex = 0; pageIndex < 3 && (await loadMore.isVisible()); pageIndex += 1) {
        await loadMore.click();
      }
      await page.locator(".sidebar-sessions__scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(
          () =>
            page
              .locator('.sidebar-recent-session:not([data-session-key="agent:main:main"])')
              .count(),
          { timeout: 15_000 },
        )
        // The agent anchor is an ordinary row and renders on top of the fixture rows.
        .toBe(rows.length);
      await captureSidebarUiProof(suite, page, "short-window-session-sections.png");

      // Sections must stack below each other, not paint over the rows above.
      const overlaps = await page.evaluate(() => {
        const rects = [
          ...document.querySelectorAll(".sidebar-recent-session, .sidebar-recent-sessions__head"),
        ]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          })
          .filter((rect) => rect.bottom > rect.top)
          .toSorted((a, b) => a.top - b.top);
        let bad = 0;
        let previousBottom: number | undefined;
        for (const rect of rects) {
          if (previousBottom !== undefined && rect.top < previousBottom - 2) {
            bad += 1;
          }
          previousBottom = rect.bottom;
        }
        return bad;
      });
      expect(overlaps).toBe(0);

      const readLayout = () =>
        page.evaluate(() => {
          const bounds = (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, height: rect.height };
          };
          const body = document.querySelector<HTMLElement>(".sidebar-shell__body")!;
          const well = document.querySelector<HTMLElement>(".sidebar-sessions")!;
          const scroller = document.querySelector<HTMLElement>(".sidebar-sessions__scroll")!;
          return {
            bodyTop: body.scrollTop,
            bodyOverflow: body.scrollHeight - body.clientHeight,
            online: bounds(".sidebar-online"),
            well: bounds(".sidebar-sessions"),
            footer: bounds(".sidebar-shell__footer"),
            listClientHeight: scroller.clientHeight,
            listScrollHeight: scroller.scrollHeight,
            listTop: scroller.scrollTop,
            wellOverflow: well.scrollHeight - well.clientHeight,
            wellOverflowY: getComputedStyle(well).overflowY,
            outlet: getComputedStyle(well, "::before").content,
            strip: getComputedStyle(well, "::after").content,
          };
        });
      const resting = await readLayout();
      expect(resting.online.bottom).toBeLessThanOrEqual(resting.well.top);
      expect(resting.well.bottom).toBeLessThanOrEqual(resting.footer.top);
      expect(resting.bodyOverflow).toBeLessThanOrEqual(1);
      expect(resting.listScrollHeight).toBeGreaterThan(resting.listClientHeight);
      expect(resting.outlet).toBe("none");
      expect(resting.strip).toBe("none");

      await page.locator(".sidebar-sessions__scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => readLayout().then((layout) => layout.listTop)).toBeGreaterThan(0);
      const scrolled = await readLayout();
      expect(scrolled.bodyTop).toBe(0);
      expect(scrolled.bodyOverflow).toBeLessThanOrEqual(1);
      expect(scrolled.online).toEqual(resting.online);
      expect(scrolled.footer).toEqual(resting.footer);
      expect(scrolled.well).toEqual(resting.well);
      expect(scrolled.wellOverflow, "the decorative well does not scroll").toBeLessThanOrEqual(1);
      expect(scrolled.wellOverflowY, "the decorative well clips its nested scroller").toBe(
        "hidden",
      );
      await captureSidebarUiProof(suite, page, "short-window-session-well-scrolled.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([1, 8])(
    "keeps a full Online person row visible and reachable beside the well with %i users",
    async (userCount) => {
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const rows = Array.from({ length: 20 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
      );
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 500, width: 1280 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows),
        },
        sessionKey: "agent:main:main",
        presenceUsers: [
          { self: true, id: "online-self", name: "Riley" },
          ...Array.from({ length: userCount - 1 }, (_, index) => ({
            self: false,
            id: `online-user-${index}`,
            name: `Teammate ${index}`,
          })),
        ],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await page.locator(".sidebar-online").waitFor({ state: "visible" });
        await expect
          .poll(() => page.locator("[data-online-user-id]").count(), { timeout: 15_000 })
          .toBe(userCount);

        // A person row counts as visible only when the row and its name sit
        // entirely inside the roster scroller's clip box and the viewport;
        // overflow declarations and scrollTop deltas say nothing about what a
        // user can actually read.
        const readLayout = () =>
          page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(".sidebar-online__list")!;
            const listRect = list.getBoundingClientRect();
            const personRows = [...list.querySelectorAll<HTMLElement>("[data-online-user-id]")].map(
              (person) => {
                const rect = person.getBoundingClientRect();
                const name = person.querySelector<HTMLElement>(".sidebar-online__person-name")!;
                const nameRect = name.getBoundingClientRect();
                const insideClip = (r: DOMRect) =>
                  r.top >= listRect.top - 0.5 &&
                  r.bottom <= listRect.bottom + 0.5 &&
                  r.top >= -0.5 &&
                  r.bottom <= window.innerHeight + 0.5;
                return {
                  id: person.getAttribute("data-online-user-id"),
                  height: rect.height,
                  visible: insideClip(rect) && insideClip(nameRect),
                };
              },
            );
            const body = document.querySelector<HTMLElement>(".sidebar-shell__body")!;
            const well = document.querySelector<HTMLElement>(".sidebar-sessions")!;
            const scroller = document.querySelector<HTMLElement>(".sidebar-sessions__scroll")!;
            const bounds = (selector: string) => {
              const rect = document.querySelector(selector)!.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom };
            };
            return {
              bodyScrollTop: body.scrollTop,
              bodyOverflow: body.scrollHeight - body.clientHeight,
              listScrollTop: list.scrollTop,
              listClientHeight: list.clientHeight,
              listScrollHeight: list.scrollHeight,
              listOverflowY: getComputedStyle(list).overflowY,
              fullyVisibleRowCount: personRows.filter((row) => row.visible).length,
              fullyVisibleRowHeights: personRows
                .filter((row) => row.visible)
                .map((row) => row.height),
              wellClientHeight: well.clientHeight,
              onlineBottom: bounds(".sidebar-online").bottom,
              wellTop: bounds(".sidebar-sessions").top,
              wellBottom: bounds(".sidebar-sessions").bottom,
              footerTop: bounds(".sidebar-shell__footer").top,
              scrollerClientHeight: scroller.clientHeight,
            };
          });

        const resting = await readLayout();
        expect(
          resting.bodyOverflow,
          "the hidden sidebar body keeps no unreachable overflow",
        ).toBeLessThanOrEqual(1);
        expect(resting.onlineBottom).toBeLessThanOrEqual(resting.wellTop);
        expect(resting.wellBottom).toBeLessThanOrEqual(resting.footerTop);
        expect(resting.listOverflowY, "the roster is its own bounded scroller").toBe("auto");
        expect(
          resting.wellClientHeight,
          "the session well keeps usable height beside expanded Online",
        ).toBeGreaterThan(80);
        expect(resting.scrollerClientHeight).toBeGreaterThan(0);
        expect(
          resting.fullyVisibleRowCount,
          "at least one full person row and its name are visible at rest",
        ).toBeGreaterThanOrEqual(1);
        expect(
          resting.fullyVisibleRowHeights.every((height) => height >= 31),
          "visible person rows are whole rows, not clipped slivers",
        ).toBe(true);

        const wheelable = resting.listScrollHeight > resting.listClientHeight;
        if (wheelable) {
          const listBox = await page.locator(".sidebar-online__list").boundingBox();
          await page.mouse.move(listBox!.x + listBox!.width / 2, listBox!.y + listBox!.height / 2);
          await page.mouse.wheel(0, 240);
          await expect
            .poll(() => readLayout().then((layout) => layout.listScrollTop))
            .toBeGreaterThan(0);
          const wheeled = await readLayout();
          expect(wheeled.bodyScrollTop, "wheel input never scrolls the hidden body").toBe(0);
          expect(
            wheeled.fullyVisibleRowCount,
            "a full person row and its name stay visible after wheel input",
          ).toBeGreaterThanOrEqual(1);
        }

        // Keyboard focus must land on the roster's own scroller and keep a full
        // row readable; the hidden body and the fixed chrome stay put.
        await page.locator("[data-online-user-id]").last().focus();
        if (wheelable) {
          await expect
            .poll(() => readLayout().then((layout) => layout.listScrollTop))
            .toBeGreaterThan(0);
        }
        const focused = await readLayout();
        expect(focused.bodyScrollTop, "focus never scrolls the hidden body").toBe(0);
        expect(
          focused.fullyVisibleRowCount,
          "a full person row and its name stay visible after focus",
        ).toBeGreaterThanOrEqual(1);

        // The last person must be activatable where it stands: Playwright click
        // actionability proves the hit target is reachable, and Enter drives the
        // keyboard activation path without disturbing the fixed chrome.
        const urlBefore = page.url();
        await page.locator("[data-online-user-id]").last().click();
        expect(page.url(), "activating a person never navigates").toBe(urlBefore);
        await page.locator("[data-online-user-id]").last().focus();
        await page.keyboard.press("Enter");
        const activated = await readLayout();
        expect(activated.bodyScrollTop, "activation never scrolls the hidden body").toBe(0);
        expect(
          activated.fullyVisibleRowCount,
          "a full person row and its name stay visible after activation",
        ).toBeGreaterThanOrEqual(1);
        expect(activated.footerTop).toBeGreaterThanOrEqual(activated.wellBottom);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("opens every new-session plus as a native link without creating sessions", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const agentId = "research";
    const group = "Client & ops / α";
    const catalogId = "cli-tools";
    const basePath = "/operator";
    const scenario: ControlUiMockGatewayScenario = {
      basePath,
      defaultAgentId: agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionGroups: [group],
      sessions: [
        { key: `agent:${agentId}:main`, label: "Grouped conversation", category: group },
        { key: `agent:${agentId}:notes`, label: "Ungrouped notes" },
      ],
      featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: catalogId,
              label: "CLI tools",
              capabilities: {
                continueSession: true,
                archive: false,
                startTerminal: true,
              },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway Mac",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "cli-thread",
                      name: "CLI plan",
                      status: "stored",
                      archived: false,
                      canContinue: true,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    // The opener and real browser-created tabs must receive the same Gateway fixture.
    await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
      route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) }),
    );
    await context.addInitScript({ content: createControlUiMockGatewayInitScript(scenario) });
    const page = await context.newPage();
    const sessionCreates = (target: Page) =>
      target.evaluate(() => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              findRequests: (method: string) => MockGatewayRequest[];
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        return gateway.findRequests("sessions.create");
      });

    try {
      await page.goto(
        controlUiSessionUrl(`${suite.server.baseUrl}operator/`, `agent:${agentId}:main`),
      );
      await waitForControlUiRoute(page, { routeId: "chat" });
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      const draft = "Keep this unsent conversation draft";
      await composer.fill(draft);
      const originalUrl = page.url();
      await captureSidebarUiProof(suite, page, "new-session-links-source.png");

      const actions: Array<{ selector: string; section?: string; params: Record<string, string> }> =
        [
          { selector: ".sidebar-brand__new-thread", params: { agent: agentId } },
          {
            selector: ".sidebar-session-toolbar .sidebar-new-session",
            params: { agent: agentId },
          },
          {
            selector: `[data-session-section="category:${group}"] .sidebar-new-session`,
            section: `category:${group}`,
            params: { agent: agentId, group },
          },
          {
            selector: '[data-session-section="ungrouped"] .sidebar-new-session',
            section: "ungrouped",
            params: { agent: agentId },
          },
          {
            selector: `[data-session-section="catalog:${catalogId}"] .sidebar-session-catalog-new`,
            section: `catalog:${catalogId}`,
            params: { agent: agentId, catalog: catalogId },
          },
        ];
      for (const [index, action] of actions.entries()) {
        if (action.section) {
          await page
            .locator(`[data-session-section="${action.section}"] .sidebar-recent-sessions__head`)
            .hover();
        }
        const link = page.locator(action.selector);
        await link.hover();
        const expectedUrl = new URL(`${basePath}/new`, suite.server.baseUrl);
        expectedUrl.search = new URLSearchParams(action.params).toString();
        expect(await link.getAttribute("href")).toBe(
          `${expectedUrl.pathname}${expectedUrl.search}`,
        );
        expect(
          await link.evaluate((element) => {
            const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            (element.querySelector("svg") ?? element).dispatchEvent(event);
            return event.defaultPrevented;
          }),
        ).toBe(false);

        // Native tab gestures do not retain an opener, so observe the browser context.
        const [popup] = await Promise.all([
          context.waitForEvent("page"),
          index % 2 === 0
            ? link.click({ modifiers: ["ControlOrMeta"] })
            : link.click({ button: "middle" }),
        ]);
        try {
          await waitForControlUiRoute(popup, {
            routeId: "new-session",
            pathname: expectedUrl.pathname,
            search: expectedUrl.search,
          });
          await popup.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(popup.url()).toBe(expectedUrl.href);
          expect(await sessionCreates(popup)).toEqual([]);
          expect(page.url()).toBe(originalUrl);
          expect(await composer.inputValue()).toBe(draft);
          expect(await sessionCreates(page)).toEqual([]);
          if ("group" in action.params) {
            await captureSidebarUiProof(suite, popup, "new-session-links-group-tab.png");
          }
        } finally {
          await popup.close();
        }
      }

      // Collapsed navigation no longer offers a new-session shortcut; the
      // expanded primary action owns the same-tab flow.
      await page.locator(".sidebar-brand__new-thread").click();
      await waitForControlUiRoute(page, {
        routeId: "new-session",
        pathname: `${basePath}/new`,
        search: `?agent=${agentId}`,
      });
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(context.pages()).toHaveLength(1);
      expect(await sessionCreates(page)).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restores focus to the Pages edit button after closing the pin editor with Escape", async () => {
    const { context, page } = await openSidebarCustomizationPage(suite);

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      const moreButton = sidebar.locator(".sidebar-nav__head-action");
      const moreMenu = await openSidebarMoreMenu(page);
      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const pinItems = sidebar
        .locator("wa-dropdown.sidebar-pin-editor-menu")
        .locator('[role="menuitem"], [role="menuitemcheckbox"]');
      // The pin editor installs roving focus after the outgoing More menu yields.
      await expect
        .poll(() =>
          pinItems.evaluateAll((items) => items.filter((item) => item.tabIndex === 0).length),
        )
        .toBe(1);
      await expect
        .poll(() => pinItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("End");
      await expect
        .poll(() => pinItems.last().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Home");
      await expect
        .poll(() => pinItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Escape");

      await expect.poll(() => page.locator(".sidebar-customize-menu").count()).toBe(0);
      await expect
        .poll(() => moreButton.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("moves focus through the sidebar pin editor with menu keys", async () => {
    const { context, page } = await openSidebarCustomizationPage(suite);

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      const moreMenu = await openSidebarMoreMenu(page);
      await expect
        .poll(() =>
          moreMenu
            .locator('[role="menuitem"]')
            .first()
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const menu = sidebar.locator("wa-dropdown.sidebar-pin-editor-menu");
      const menuItems = menu.locator('[role="menuitem"], [role="menuitemcheckbox"]');
      await expect
        .poll(() =>
          menuItems.evaluateAll((items) => items.filter((item) => item.tabIndex === 0).length),
        )
        .toBe(1);
      await expect
        .poll(() => menuItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => menuItems.nth(1).evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("End");
      await expect
        .poll(() => menuItems.last().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => menuItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect.poll(() => menu.count()).toBe(0);
      const homeLink = sidebar.locator(".nav-item").first();
      await expect
        .poll(() => homeLink.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
