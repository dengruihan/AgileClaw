import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  type ControlUiMockGatewayScenario,
  type MockGatewayRequest,
  controlUiBundledSettingsStorageKey,
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
      presenceUsers: [
        { self: true, id: "fixed-sidebar-user", name: "Riley" },
        // A second identity keeps the Online section mounted: solo presence
        // intentionally renders no section, and this test owns the well
        // geometry around a live roster.
        { self: false, id: "fixed-sidebar-teammate", name: "Sage" },
      ],
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

  // Joint allocation matrix for the sidebar column. Above 500px viewport
  // height the expanded Online roster interacts fully beside the session
  // well; at or below 500px the whole Online section (header and toggle
  // included) yields its space to the session well in both the default and
  // the agent-roster mode, leaving no expanded control behind, while the
  // nav rail may shrink into a bounded scrollable strip. The hidden body
  // never scrolls and no row is ever clipped to a sliver.
  const sidebarHeightMatrix = [
    { height: 800, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 500, mode: "sessions", touch: false, users: 1, width: 1280 },
    { height: 500, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 400, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 360, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 320, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 300, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 280, mode: "sessions", touch: false, users: 8, width: 1280 },
    { height: 500, mode: "sessions", touch: true, users: 8, width: 932 },
    { height: 800, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 500, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 400, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 360, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 320, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 300, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 280, mode: "roster", touch: false, users: 8, width: 1280 },
    { height: 400, mode: "roster", touch: true, users: 8, width: 932 },
  ] as const;

  it.each(sidebarHeightMatrix)(
    "allocates whole Online and session rows at $width x $height ($mode mode, $users users)",
    async ({ height, mode, touch, users, width }) => {
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const rows = Array.from({ length: 20 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
      );
      const context = await suite.newBrowserContext({
        hasTouch: touch,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height, width },
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
      });
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows),
          // Roster mode joins agent cards with the session sections.
          ...(mode === "roster"
            ? {
                "agents.list": {
                  defaultId: "main",
                  mainKey: "main",
                  scope: "per-sender",
                  agents: [
                    { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
                    { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
                  ],
                },
                "agent.identity.get": {
                  cases: [
                    { id: "main", name: "Harbor" },
                    { id: "forge", name: "Forge" },
                  ].map((agent) => ({
                    match: { agentId: agent.id },
                    response: { agentId: agent.id, name: agent.name, emoji: "⚓", avatar: "" },
                  })),
                },
                "chat.startup": {
                  agentsList: {
                    defaultId: "main",
                    mainKey: "main",
                    scope: "per-sender",
                    agents: [
                      { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
                      { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
                    ],
                  },
                  messages: [],
                  metadata: { models: [] },
                  sessionId: "session:agent:main:main",
                  thinkingLevel: null,
                },
                "cron.list": {
                  jobs: [],
                  snapshotRevision: "roster-matrix",
                  total: 0,
                  offset: 0,
                  limit: 50,
                  hasMore: false,
                  nextOffset: null,
                },
              }
            : {}),
        },
        sessionKey: "agent:main:main",
        presenceUsers: [
          { self: true, id: "online-self", name: "Riley" },
          ...Array.from({ length: users - 1 }, (_, index) => ({
            self: false,
            id: `online-user-${index}`,
            name: `Teammate ${index}`,
          })),
        ],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        // Roster mode is a persisted UI setting: apply it after first load and
        // reload so the app boots with it (boot-time settings sync can clobber
        // a pre-load write).
        if (mode === "roster") {
          // The storage key derives from an imported helper; pass its value as
          // an argument so the serialized callback carries no import reference.
          const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
          await page.evaluate(
            ({ key }) => {
              localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" }));
            },
            { key: settingsKey },
          );
          await page.reload();
        }
        // The short-window band hides the whole Online section (attached, not
        // visible), and solo presence — the users: 1 case — renders no section
        // at any height, so only wait for the roster when one can exist.
        if (users > 1) {
          await page.locator(".sidebar-online").waitFor({ state: "attached" });
        }
        // Coarse pointers run the drawer layout: open it so the sidebar column
        // is on-screen before measuring or interacting.
        if (touch) {
          const drawerToggle = page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first();
          await drawerToggle.waitFor({ state: "visible", timeout: 30_000 });
          await drawerToggle.click();
          const drawer = page.locator(".shell--mobile-nav.shell--nav-drawer-open > .shell-nav");
          await drawer.waitFor({ state: "visible", timeout: 30_000 });
          // The slide transition shifts measured bounds; synchronize on the
          // final drawer position from the owning CSS
          // (.shell--mobile-nav.shell--nav-drawer-open .shell-nav settles at
          // translateX(0)) before any input is dispatched.
          await drawer.evaluate(
            "(element) => Promise.all(element.getAnimations().map((a) => a.finished))",
          );
          await expect
            .poll(() => drawer.evaluate((el) => getComputedStyle(el).transform))
            .toBe("matrix(1, 0, 0, 1, 0, 0)");
          // Explicit settled-state assertion: the drawer's session content is
          // measurable (test/AGENTS.md: synchronize on the produced state).
          await expect
            .poll(
              () =>
                page
                  .locator(".sidebar-sessions__scroll")
                  .first()
                  .evaluate((el) => el.clientHeight),
              { timeout: 15_000 },
            )
            .toBeGreaterThan(0);
        }
        if (mode === "roster") {
          // Prove the agent-roster host actually mounted, so the roster-mode
          // allocation assertions exercise the roster owner.
          await expect
            .poll(() => page.locator("openclaw-sidebar-agent-roster").count(), { timeout: 15_000 })
            .toBeGreaterThanOrEqual(1);
        }
        // At or below 500px the whole Online section is hidden; above it the
        // expanded roster stays.
        const shortWindow = height <= 500;
        // A row counts as visible only when the row and its label sit entirely
        // inside their scroller's clip box and the viewport; overflow
        // declarations and scrollTop deltas say nothing about what a user can
        // actually read.
        const readLayout = () =>
          page.evaluate(() => {
            const insideClip = (rect: DOMRect, clip: DOMRect) =>
              rect.top >= clip.top - 0.5 &&
              rect.bottom <= clip.bottom + 0.5 &&
              rect.top >= -0.5 &&
              rect.bottom <= window.innerHeight + 0.5;
            const visibleRows = (
              rootSelector: string,
              rowSelector: string,
              nameSelector: string,
            ) => {
              const root = document.querySelector<HTMLElement>(rootSelector);
              if (!root) {
                return [];
              }
              const rootRect = root.getBoundingClientRect();
              return [...root.querySelectorAll<HTMLElement>(rowSelector)]
                .filter((row) => {
                  const rowRect = row.getBoundingClientRect();
                  const labelRect = row
                    .querySelector<HTMLElement>(nameSelector)
                    ?.getBoundingClientRect();
                  return labelRect
                    ? insideClip(rowRect, rootRect) && insideClip(labelRect, rootRect)
                    : false;
                })
                .map((row) => row.getBoundingClientRect().height);
            };
            const body = document.querySelector<HTMLElement>(".sidebar-shell__body");
            const nav = document.querySelector<HTMLElement>(".sidebar-nav");
            const onlineSection = document.querySelector<HTMLElement>(".sidebar-online");
            const onlineList = document.querySelector<HTMLElement>(".sidebar-online__list");
            const well = document.querySelector<HTMLElement>(".sidebar-sessions");
            // The roster host mounts before its session content renders; the
            // settle poll treats a missing scroller as "unsettled".
            const scroller = document.querySelector<HTMLElement>(".sidebar-sessions__scroll");
            const bounds = (element: HTMLElement | null) => {
              if (!element) {
                return { top: -1, bottom: -1, height: 0 };
              }
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, height: rect.height };
            };
            if (!body || !scroller) {
              return {
                bodyScrollTop: 0,
                bodyOverflow: 0,
                nav: bounds(nav),
                online: bounds(onlineSection),
                onlineSectionHidden:
                  onlineSection === null || getComputedStyle(onlineSection).display === "none",
                onlineToggleVisible: false,
                onlineListScrollTop: null,
                onlineListClientHeight: null,
                onlineListScrollHeight: null,
                well: bounds(well),
                wellClientHeight: well?.clientHeight ?? 0,
                footer: bounds(document.querySelector<HTMLElement>(".sidebar-shell__footer")),
                scrollerScrollTop: 0,
                scrollerClientHeight: 0,
                scrollerScrollHeight: 0,
                scrollerMissing: true,
                visiblePersonRowCount: 0,
                visiblePersonRowHeights: [] as number[],
                visibleSessionRowCount: 0,
                visibleSessionRowHeights: [] as number[],
              };
            }
            return {
              bodyScrollTop: body.scrollTop,
              bodyOverflow: body.scrollHeight - body.clientHeight,
              nav: bounds(nav),
              online: bounds(onlineSection),
              onlineSectionHidden:
                onlineSection === null || getComputedStyle(onlineSection).display === "none",
              onlineToggleVisible: (() => {
                const toggle = document.querySelector(
                  ".sidebar-online .sidebar-session-group-toggle",
                );
                if (!toggle) {
                  return false;
                }
                const rect = toggle.getBoundingClientRect();
                return rect.height > 0 && rect.width > 0;
              })(),
              onlineListScrollTop: onlineList?.scrollTop ?? null,
              onlineListClientHeight: onlineList?.clientHeight ?? null,
              onlineListScrollHeight: onlineList?.scrollHeight ?? null,
              toolbarDisplay: (() => {
                const toolbar = document.querySelector(
                  ".sidebar-sessions .sidebar-session-toolbar",
                );
                return toolbar ? getComputedStyle(toolbar).display : "absent";
              })(),
              rosterHeaderDisplay: (() => {
                const header = document.querySelector(".sidebar-agent-roster__header");
                return header ? getComputedStyle(header).display : "absent";
              })(),
              scrollerMaskImage: getComputedStyle(scroller).maskImage,
              well: bounds(well),
              wellClientHeight: well?.clientHeight ?? 0,
              footer: bounds(document.querySelector<HTMLElement>(".sidebar-shell__footer")!),
              scrollerScrollTop: scroller.scrollTop,
              scrollerClientHeight: scroller.clientHeight,
              scrollerScrollHeight: scroller.scrollHeight,
              scrollerMissing: false,
              visiblePersonRowCount: visibleRows(
                ".sidebar-online__list",
                "[data-online-user-id]",
                ".sidebar-online__person-name",
              ).length,
              visiblePersonRowHeights: visibleRows(
                ".sidebar-online__list",
                "[data-online-user-id]",
                ".sidebar-online__person-name",
              ),
              visibleSessionRowCount: visibleRows(
                ".sidebar-sessions__scroll",
                ".sidebar-sessions .sidebar-recent-session",
                ".sidebar-recent-session__name",
              ).length,
              visibleSessionRowHeights: visibleRows(
                ".sidebar-sessions__scroll",
                ".sidebar-sessions .sidebar-recent-session",
                ".sidebar-recent-session__name",
              ),
            };
          });
        const expectWholeRows = (layout: Awaited<ReturnType<typeof readLayout>>, phase: string) => {
          /* Roster mode keeps Online collapsed behind its facepile header
             by design; its session rows are asserted whole-and-readable at
             rest exactly like every other mode. */
          const personFloor = layout.onlineSectionHidden || mode === "roster" ? 0 : 1;
          expect(
            layout.visiblePersonRowCount,
            `${phase}: a whole Online person row and its name are visible`,
          ).toBeGreaterThanOrEqual(personFloor);
          expect(
            layout.visibleSessionRowCount,
            `${phase}: a whole session row and its name are visible`,
          ).toBeGreaterThanOrEqual(1);
          if (!layout.onlineSectionHidden) {
            expect(
              layout.visiblePersonRowHeights.every((rowHeight) => rowHeight >= 31),
              "visible Online rows are whole rows, not clipped slivers",
            ).toBe(true);
          }
          expect(
            layout.visibleSessionRowHeights.every((rowHeight) => rowHeight >= 29),
            "visible session rows are whole rows, not clipped slivers",
          ).toBe(true);
          if (layout.onlineSectionHidden) {
            expect(
              layout.onlineToggleVisible,
              "no misleading Online expanded control remains when the roster is hidden",
            ).toBe(false);
          }
        };
        // The roster host and its session content mount asynchronously; poll
        // to a stable allocation instead of sleeping: either the bounded
        // roster shows whole rows, or the short-window band settled the
        // Online section into its hidden state.
        await expect
          .poll(
            async () => {
              const layout = await readLayout();
              if (layout.scrollerMissing) {
                return "unsettled";
              }
              if (layout.onlineSectionHidden) {
                return "section-hidden";
              }
              // Roster mode keeps Online collapsed behind its facepile header
              // by design; only session rows gate the settled state there.
              const personOk = mode === "sessions" ? layout.visiblePersonRowCount >= 1 : true;
              return personOk && layout.visibleSessionRowCount >= 1 ? "whole-rows" : "unsettled";
            },
            { timeout: 30_000 },
          )
          .not.toBe("unsettled");
        const resting = await readLayout();
        expect(
          resting.onlineSectionHidden,
          users === 1
            ? "solo presence renders no Online section at any height"
            : shortWindow
              ? "the short-window band hides the whole Online section"
              : "ordinary heights keep the expanded Online section",
        ).toBe(shortWindow || users === 1);
        expect(resting.onlineToggleVisible).toBe(!shortWindow && users > 1);
        // The compact roster group header is deliberately removed with the
        // band so agent session rows start at the top of the well; agent
        // association stays on the grouped rows (data-agent-group) and
        // new-session stays in the brand.
        if (shortWindow && mode === "roster") {
          // The compact roster group header is removed with the band so the
          // agent session rows start at the top of the well; association
          // stays on the grouped rows (data-agent-group) and new-session
          // stays in the brand.
          expect(
            resting.rosterHeaderDisplay,
            "the short-window band removes the compact roster group header",
          ).toBe("none");
        }
        expect(
          resting.bodyOverflow,
          "the hidden sidebar body keeps no unreachable overflow",
        ).toBeLessThanOrEqual(1);
        expect(resting.online.bottom).toBeLessThanOrEqual(resting.well.top);
        expect(resting.well.bottom).toBeLessThanOrEqual(resting.footer.top);
        expect(
          resting.wellClientHeight,
          "the session well keeps its bounded floor",
        ).toBeGreaterThanOrEqual(38);
        // One whole readable session row is required at rest at every
        // supported height, in both modes.
        expectWholeRows(resting, "resting");
        // In the short-window band the session toolbar is deliberately
        // removed as a whole (no zero-height clipped controls) and the edge
        // fade is the compact 12px variant, so it cannot cover a whole row.
        if (shortWindow) {
          // Sessions mode removes the toolbar element; roster mode never
          // renders one — neither state leaves a clipped control behind.
          expect(
            resting.toolbarDisplay,
            "the short-window band leaves no rendered session toolbar",
          ).not.toBe("flex");
          expect(
            resting.scrollerMaskImage,
            "the short-window band uses the compact 12px edge fade",
          ).toContain("12px");
          expect(
            resting.scrollerMaskImage,
            "the short-window fade does not use the 32px stops",
          ).not.toContain("32px");
        } else {
          expect(resting.toolbarDisplay, "ordinary heights keep the session toolbar").not.toBe(
            "none",
          );
        }

        // Wheel input over the roster scrolls Online itself when its roster
        // overflows; over the session list scrolls the well's nested
        // scroller; neither moves the body.
        const onlineScrollable =
          resting.onlineListScrollHeight !== null &&
          resting.onlineListClientHeight !== null &&
          resting.onlineListScrollHeight > resting.onlineListClientHeight;
        if (!shortWindow && onlineScrollable) {
          const onlineListBox = await page.locator(".sidebar-online__list").boundingBox();
          await page.mouse.move(
            onlineListBox!.x + onlineListBox!.width / 2,
            onlineListBox!.y + onlineListBox!.height / 2,
          );
          await page.mouse.wheel(0, 240);
          await expect
            .poll(() => readLayout().then((layout) => layout.onlineListScrollTop))
            .toBeGreaterThan(0);
          const wheeledOnline = await readLayout();
          expect(wheeledOnline.bodyScrollTop, "wheel input never scrolls the hidden body").toBe(0);
          expect(wheeledOnline.nav).toEqual(resting.nav);
          expect(wheeledOnline.well).toEqual(resting.well);
          expect(wheeledOnline.footer).toEqual(resting.footer);
          // A mid-row wheel offset may slice rows transiently like any list;
          // whole-row readability is asserted at the reachable bottom-aligned
          // offset, which wheel input demonstrably produced.
          await page.evaluate(`(() => {
            const list = document.querySelector(".sidebar-online__list");
            list.scrollTop = list.scrollHeight;
          })()`);
          const alignedOnline = await readLayout();
          expect(alignedOnline.bodyScrollTop, "alignment never scrolls the hidden body").toBe(0);
          expectWholeRows(alignedOnline, "alignedOnline");
        }

        // Keyboard focus must land in its own bounded scroller and keep a
        // whole row readable; the hidden body never moves. In the short
        // window the Online section is hidden entirely, so there is no
        // roster row to focus and no expanded control left behind.
        if (shortWindow) {
          expect(
            resting.onlineToggleVisible,
            "the short-window band leaves no Online expanded control to focus",
          ).toBe(false);
        } else if (mode === "sessions") {
          await page.locator("[data-online-user-id]").last().focus();
        }
        const focusedOnline = await readLayout();
        expect(focusedOnline.bodyScrollTop, "focus never scrolls the hidden body").toBe(0);
        if (mode === "sessions" && !shortWindow) {
          const onlineListMetrics = focusedOnline.onlineListClientHeight;
          if (
            onlineListMetrics !== null &&
            focusedOnline.onlineListScrollHeight !== null &&
            focusedOnline.onlineListScrollHeight > onlineListMetrics
          ) {
            expect(
              focusedOnline.onlineListScrollTop,
              "focusing the last roster row scrolls it into view",
            ).toBeGreaterThan(0);
          }
          // Real activation of the last person: click hit-target proof plus
          // the keyboard activation path, neither moving the hidden body.
          const urlBeforeOnline = page.url();
          await page.locator("[data-online-user-id]").last().click();
          expect(page.url(), "activating a person never navigates").toBe(urlBeforeOnline);
          await page.locator("[data-online-user-id]").last().focus();
          await page.keyboard.press("Enter");
          const activatedOnline = await readLayout();
          expect(activatedOnline.bodyScrollTop).toBe(0);
          expectWholeRows(activatedOnline, "activatedOnline");
        }

        // Session reachability: wheel, focus, and real activation of another
        // session (navigation), with the fixed chrome staying put throughout.
        const sessionListBox = await page.locator(".sidebar-sessions__scroll").boundingBox();
        await page.mouse.move(
          sessionListBox!.x + sessionListBox!.width / 2,
          sessionListBox!.y + sessionListBox!.height / 2,
        );
        // The drawer position is settled above; a single wheel dispatch now
        // reaches the session scroller.
        await page.mouse.wheel(0, 240);
        await expect
          .poll(() => readLayout().then((layout) => layout.scrollerScrollTop))
          .toBeGreaterThan(0);
        const wheeledSessions = await readLayout();
        expect(wheeledSessions.bodyScrollTop, "session wheel never scrolls the body").toBe(0);
        expect(wheeledSessions.nav).toEqual(resting.nav);
        expect(wheeledSessions.online).toEqual(resting.online);
        expect(wheeledSessions.footer).toEqual(resting.footer);
        await page.evaluate(`(() => {
          const scroller = document.querySelector(".sidebar-sessions__scroll");
          const sessionRows = scroller.querySelectorAll(".sidebar-recent-session");
          const last = sessionRows[sessionRows.length - 1];
          if (!last) {
            return;
          }
          // Align the last row's bottom with the scroller bottom: whole-row
          // readability at a reachable offset, independent of any trailing
          // list spacing.
          const rowBottom = last.getBoundingClientRect().bottom;
          const scrollerBottom = scroller.getBoundingClientRect().bottom;
          scroller.scrollTop += rowBottom - scrollerBottom;
        })()`);
        const alignedSessions = await readLayout();
        expect(alignedSessions.bodyScrollTop, "alignment never scrolls the hidden body").toBe(0);
        expectWholeRows(alignedSessions, "alignedSessions");

        await page.locator(".sidebar-recent-session__link").last().focus();
        const focusedSession = await readLayout();
        expect(focusedSession.bodyScrollTop, "session focus never scrolls the body").toBe(0);
        expectWholeRows(focusedSession, "focusedSession");

        const urlBefore = page.url();
        if (mode === "roster") {
          // Roster rows carry overlay action chrome on focus; keyboard
          // activation is the deterministic reachability proof there.
          await page.locator(".sidebar-recent-session__link").last().focus();
          await page.keyboard.press("Enter");
        } else {
          await page.locator(".sidebar-recent-session__link").last().click();
        }
        expect(page.url(), "activating a session navigates").not.toBe(urlBefore);
        const activated = await readLayout();
        expect(activated.bodyOverflow).toBeLessThanOrEqual(1);
        expect(activated.bodyScrollTop).toBe(0);
        expect(activated.footer.top).toBeGreaterThanOrEqual(activated.well.bottom);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("dismisses the Online filter popover when the second identity leaves", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const owner = {
          self: true,
          id: "gateway-owner",
          identity: { type: "profile" as const, id: "gateway-owner" },
          name: "Shared owner",
        };
        const ada = {
          id: "ada",
          identity: { type: "profile" as const, id: "ada" },
          name: "Ada",
        };
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          presenceUsers: [owner, ada],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const section = page.locator(".sidebar-online");
        const filterToggle = page.locator(".sidebar-online__filter-toggle");
        const popover = page.locator(".sidebar-people-filter-menu");
        await section.waitFor();
        await filterToggle.focus();
        await filterToggle.press("Enter");
        await popover.waitFor();
        // Removing Ada removes the whole section; the popover anchored to its
        // toggle must be dismissed by the owning lifecycle instead of
        // rendering orphaned, and keyboard focus stranded by the removal
        // re-anchors on the brand's persistent new-session control.
        await gateway.emitGatewayEvent("presence", {
          presence: [{ user: { id: owner.id, identity: owner.identity, name: owner.name } }],
        });
        await expect.poll(() => section.count()).toBe(0);
        await expect.poll(() => popover.count()).toBe(0);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (document.activeElement as HTMLElement | null)?.classList.contains(
                  "sidebar-brand__new-thread",
                ) ?? false,
            ),
          )
          .toBe(true);
        // A returning second identity restores the ordinary filter flow.
        await gateway.emitGatewayEvent("presence", {
          presence: [
            { user: { id: owner.id, identity: owner.identity, name: owner.name } },
            { user: { id: ada.id, identity: ada.identity, name: ada.name } },
          ],
        });
        await section.waitFor();
        await filterToggle.focus();
        await filterToggle.press("Enter");
        await popover.waitFor();
        await page.keyboard.press("Escape");
        await expect.poll(() => popover.count()).toBe(0);
      },
    );
  });

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
