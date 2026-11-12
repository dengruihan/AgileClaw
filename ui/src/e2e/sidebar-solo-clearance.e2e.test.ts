import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

// The solo-presence clearance suite: the Body's two regions — the Pages rail
// and the session column — are exercised at every affected height. The rail
// must keep its last key whole and clickable above the session well in
// sessions and roster modes and at tight and ordinary desktop heights, the
// compact band must keep its narrower floors, and the compact roster group
// header must yield exactly when the well scroller cannot afford it plus one
// whole session row (the layout.css concession).
const suite = createSidebarCustomizationSuite(
  "Control UI sidebar solo clearance mocked Gateway E2E",
);

suite.define(() => {
  // Solo presence drops the session region's floor to the well and its own
  // clearances: while renderAppSidebarOnline returns nothing, folding
  // --sidebar-online-floor into the region's floor squeezed the rail until its
  // lowest row clipped against the session well's top edge. The seeded synced
  // pins put Automations last — the user-reordered nav where the wasted floor
  // bites — and a 520px viewport sits inside the affected band: the rail needs
  // more than the honest well-only region floor but less than well + Online.
  //
  // The frame must also keep a visible shelf below the last key's seated
  // contact shadow, not merely sit below its border box. The original suite
  // only compared DOM boxes (well.top >= link.bottom), which the old 6px rail
  // gap satisfied even though that gap exactly equals the resting --key-shadow
  // downward reach — so the frame crowded the key's lower edge with no visible
  // separation. This is the visible clearance required beyond the shadow extent.
  const minVisibleRailClearance = 6;
  const clearancePinnedRoutes = [
    "route:dashboards",
    "route:sessions",
    "route:usage",
    "route:activity",
    "route:meetings",
    "route:worktrees",
    "route:approvals",
    "route:skills",
    "route:cron",
  ];
  const clearanceServerConfig = () => {
    const config = { ui: { prefs: { sidebarEntries: clearancePinnedRoutes } } };
    return {
      config,
      sourceConfig: config,
      hash: "sidebar-clearance-config",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    };
  };
  const clearanceRosterResponses = () => ({
    // Roster mode joins agent cards with the session sections.
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
      snapshotRevision: "sidebar-clearance-roster",
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
  });
  const readSidebarClearance = (page: Page) =>
    page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const nav = document.querySelector<HTMLElement>(".sidebar-nav");
      // The key face is the anchor the pointer actually hits, so clearance and
      // pointer proof read the link, not its padded wrapper.
      const automationsLink = document.querySelector<HTMLElement>(
        '.sidebar-nav [data-sidebar-entry="route:cron"] a',
      );
      const automationsLinkRect = automationsLink?.getBoundingClientRect() ?? null;
      const automationsLinkHit = (() => {
        if (!automationsLinkRect) {
          return null;
        }
        const hit = document.elementFromPoint(
          automationsLinkRect.left + automationsLinkRect.width / 2,
          automationsLinkRect.bottom - 2,
        );
        return hit !== null && (hit === automationsLink || automationsLink!.contains(hit));
      })();
      // The seated key's contact shadow reaches below its border box, so the
      // visual clearance the session frame must keep is measured against that
      // extent, not the DOM box alone. Computed length order per layer is
      // offsetX offsetY blur spread; inset layers paint inside the key and add
      // no downward reach.
      const automationsLinkShadowOverhang = (() => {
        if (!automationsLink) {
          return null;
        }
        const shadow = getComputedStyle(automationsLink).boxShadow;
        let overhang = 0;
        for (const layer of shadow.split(/,(?![^(]*\))/)) {
          if (layer.includes("inset")) {
            continue;
          }
          const lengths = layer.match(/-?\d+(?:\.\d+)?px/g)?.map(parseFloat) ?? [];
          if (lengths.length >= 3) {
            overhang = Math.max(overhang, lengths[1] + lengths[2] + (lengths[3] ?? 0));
          }
        }
        return overhang;
      })();
      return {
        nav: box(".sidebar-nav"),
        navScrollable: nav ? nav.scrollHeight - nav.clientHeight > 1 : null,
        automations: box('.sidebar-nav [data-sidebar-entry="route:cron"]'),
        automationsLink: box('.sidebar-nav [data-sidebar-entry="route:cron"] a'),
        automationsLinkHit,
        automationsLinkShadowOverhang,
        automationsLabel: box('.sidebar-nav [data-sidebar-entry="route:cron"] .nav-item__text'),
        sessionToolbarDisplay: (() => {
          const toolbar = document.querySelector(".sidebar-sessions .sidebar-session-toolbar");
          return toolbar ? getComputedStyle(toolbar).display : "absent";
        })(),
        rosterHeaderDisplay: (() => {
          const header = document.querySelector(".sidebar-agent-roster__header");
          return header ? getComputedStyle(header).display : "absent";
        })(),
        well: box(".sidebar-sessions"),
        sessionScroller: box(".sidebar-sessions__scroll"),
        firstSessionRow: box(".sidebar-sessions__scroll .sidebar-recent-session"),
        online: box(".sidebar-online"),
        footer: box(".sidebar-shell__footer"),
        onlineMounted: Boolean(document.querySelector(".sidebar-online")),
        bodyOverflow: (() => {
          const body = document.querySelector<HTMLElement>(".sidebar-shell__body");
          return body ? body.scrollHeight - body.clientHeight : null;
        })(),
        wholeSessionRowCount: (() => {
          const scroller = document.querySelector<HTMLElement>(".sidebar-sessions__scroll");
          if (!scroller) {
            return 0;
          }
          const scrollerRect = scroller.getBoundingClientRect();
          return [...scroller.querySelectorAll<HTMLElement>(".sidebar-recent-session")].filter(
            (row) => {
              const rowRect = row.getBoundingClientRect();
              const labelRect = row
                .querySelector<HTMLElement>(".sidebar-recent-session__name")
                ?.getBoundingClientRect();
              const inside = (inner: DOMRect) =>
                inner.top >= scrollerRect.top - 0.5 && inner.bottom <= scrollerRect.bottom + 0.5;
              return labelRect ? inside(rowRect) && inside(labelRect) : false;
            },
          ).length;
        })(),
      };
    });
  // Sidebar presence flips and the allocation floor both land asynchronously;
  // settle on two identical consecutive reads with the expected section state
  // instead of asserting a half-applied layout.
  const settleSidebarClearance = async (page: Page, expectOnline: boolean) => {
    let previous = "";
    await expect
      .poll(
        async () => {
          const next = await readSidebarClearance(page);
          const key = JSON.stringify([next.nav, next.well, next.bodyOverflow, next.onlineMounted]);
          const settled = key === previous && next.onlineMounted === expectOnline;
          previous = key;
          return settled;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return readSidebarClearance(page);
  };
  // Roster mode is a persisted UI setting: merge it into the bundled settings
  // after first load and reload so the app boots with it — a whole-blob write
  // would drop the synced sidebarEntries pins, and boot-time settings sync can
  // clobber a pre-load write entirely.
  const bootRosterMode = async (page: Page, baseUrl: string) => {
    const settingsKey = controlUiBundledSettingsStorageKey(baseUrl);
    await page.evaluate((key) => {
      const previous = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...previous, sidebarAgentsMode: "roster" }));
    }, settingsKey);
    await page.reload();
    await expect
      .poll(() => page.locator("openclaw-sidebar-agent-roster").count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
  };
  // Text scale is a persisted browser preference (TEXT_SCALE_STOPS); boot it the
  // same way so the app's own theme owner writes --control-ui-text-scale.
  const bootTextScale = async (page: Page, baseUrl: string, textScale: number) => {
    const settingsKey = controlUiBundledSettingsStorageKey(baseUrl);
    await page.evaluate(
      ({ key, value }) => {
        const previous = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
        localStorage.setItem(key, JSON.stringify({ ...previous, textScale: value }));
      },
      { key: settingsKey, value: textScale },
    );
    await page.reload();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue("--control-ui-text-scale"),
          ),
        { timeout: 15_000 },
      )
      .toBe(String(textScale / 100));
  };

  it("keeps the whole Automations entry clear of the well when solo presence hides Online", async () => {
    const height = 520;
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = Array.from({ length: 6 }, (_, index) =>
      sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
    );
    const owner = {
      self: true,
      id: "clearance-owner",
      identity: { type: "profile" as const, id: "clearance-owner" },
      name: "Riley",
    };
    const teammate = {
      id: "clearance-teammate",
      identity: { type: "profile" as const, id: "clearance-teammate" },
      name: "Sage",
    };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
        "config.get": clearanceServerConfig(),
      },
      sessionKey: "agent:main:main",
      presenceUsers: [owner, teammate],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const section = page.locator(".sidebar-online");
      await section.waitFor();
      const duo = await settleSidebarClearance(page, true);
      // Multi-user baseline: the mounted Online roster shares the session
      // region with the well and never overlaps it. The region's floor covers
      // Online's own vertical margins as well as its box, so the well keeps a
      // whole row above the footer divider and the Body does not overflow.
      expect(duo.onlineMounted).toBe(true);
      expect(duo.online!.bottom).toBeLessThanOrEqual(duo.well!.top);
      expect(
        duo.bodyOverflow,
        "the duo region floor covers Online's share without body overflow",
      ).toBeLessThanOrEqual(0);
      expect(duo.well!.bottom, "the duo well stays above the footer divider").toBeLessThanOrEqual(
        duo.footer!.top,
      );
      expect(
        duo.wholeSessionRowCount,
        "one whole session row stays readable beside Online",
      ).toBeGreaterThanOrEqual(1);

      // The second identity leaves: the section unmounts and the session
      // region's floor drops to the well, so the rail keeps every key it
      // renders instead of yielding height to an absent section's share.
      await gateway.emitGatewayEvent("presence", {
        presence: [{ user: { id: owner.id, identity: owner.identity, name: owner.name } }],
      });
      await expect.poll(() => section.count()).toBe(0);
      const solo = await settleSidebarClearance(page, false);
      expect(solo.onlineMounted).toBe(false);
      expect(solo.bodyOverflow, "solo sidebar body keeps no overflow").toBeLessThanOrEqual(1);
      expect(solo.automations, "the Automations entry still renders").not.toBeNull();
      expect(
        solo.navScrollable,
        "solo presence keeps the nav rail unscrollable at the affected height",
      ).toBe(false);
      expect(
        solo.automations!.bottom,
        "the whole Automations entry sits inside the nav viewport",
      ).toBeLessThanOrEqual(solo.nav!.bottom);
      expect(
        solo.automationsLabel!.bottom,
        "the Automations label is not clipped by the nav rail",
      ).toBeLessThanOrEqual(solo.nav!.bottom);
      expect(
        solo.well!.top,
        "the session well clears the whole Automations entry",
      ).toBeGreaterThanOrEqual(solo.automations!.bottom);
      expect(
        solo.well!.top - solo.automationsLink!.bottom,
        "the solo session well keeps a visible shelf below the Automations key's contact shadow",
      ).toBeGreaterThanOrEqual(solo.automationsLinkShadowOverhang! + minVisibleRailClearance - 0.5);
      expect(
        solo.well!.bottom,
        "the session region keeps the whole well above the footer divider",
      ).toBeLessThanOrEqual(solo.footer!.top + 0.5);
      expect(
        solo.nav!.height,
        "solo presence gives the rail back the Online share of the session region's floor",
      ).toBeGreaterThan(duo.nav!.height);
      await captureSidebarUiProof(suite, page, "solo-clearance-second-identity-left.png");

      // The control stays reachable through its real activation path.
      const urlBefore = page.url();
      await page.locator('.sidebar-nav [data-sidebar-entry="route:cron"] a').first().click();
      await waitForControlUiRoute(page, { routeId: "cron" });
      expect(page.url()).not.toBe(urlBefore);

      // A returning second identity remounts Online with its floor share;
      // the column still never overlaps.
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { user: { id: owner.id, identity: owner.identity, name: owner.name } },
          { user: { id: teammate.id, identity: teammate.identity, name: teammate.name } },
        ],
      });
      await section.waitFor();
      const duoAgain = await settleSidebarClearance(page, true);
      expect(duoAgain.onlineMounted).toBe(true);
      expect(duoAgain.online!.bottom).toBeLessThanOrEqual(duoAgain.well!.top);
      expect(
        duoAgain.bodyOverflow,
        "the returning duo column keeps no body overflow",
      ).toBeLessThanOrEqual(0);
      expect(duoAgain.well!.bottom).toBeLessThanOrEqual(duoAgain.footer!.top);
      await captureSidebarUiProof(suite, page, "solo-clearance-second-identity-returned.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  // The Body's two regions are independent: the Pages rail takes the height its
  // keys need and scrolls only if the Body itself cannot afford that, while the
  // session region takes the remainder and owns its own floor. The old joint
  // cap derived the rail's height from a session reservation, so a full route
  // rail was clipped and its last key's lower half fell over the session frame —
  // the user's reordered Automations control. Every route in the persisted zone
  // (Automations last in the reordered set) must keep its whole face, its real
  // hit target at the lower edge, and its navigation. 540/560 prove the tight
  // end (the session region keeps one row and yields its toolbar), 580 proves a
  // column that still affords the toolbar, and the ordinary desktop columns pin
  // the static clearance of the session frame's rail gap.
  const allSidebarRoutes = [
    "route:dashboards",
    "route:usage",
    "route:sessions",
    "route:activity",
    "route:meetings",
    "route:apps",
    "route:portals",
    "route:cron",
  ];
  const ordinaryClearanceCases = [
    // Tight columns: the session region keeps one whole row and the toolbar
    // yields. 564/568/571 straddle the toolbar crossover — the well content
    // there is 54/58/61px, just under the 62px the toolbar, its flex gap and a
    // row need — so they are the exact band where the old 53.5px threshold
    // restored a toolbar that clipped the row by 8/4/1px.
    { height: 540, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "none" },
    { height: 560, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "none" },
    { height: 564, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "none" },
    { height: 568, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "none" },
    { height: 571, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "none" },
    // 572 is the first column whose well content reaches 62px: the toolbar
    // returns with the row still whole.
    { height: 572, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "flex" },
    { height: 580, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "flex" },
    // A coarse pointer raises the row floor to 44px, so the same 580px column
    // no longer affords toolbar + gap + row and must keep the row instead; 610
    // affords it again and stays on the ordinary fade.
    { height: 580, order: "reordered", pointer: "touch", textScale: 100, toolbar: "none" },
    { height: 610, order: "reordered", pointer: "touch", textScale: 100, toolbar: "flex" },
    // The row token is max(30px, 18px * text scale + 8px) at the supported
    // 90/100/110/125/140% stops, so the crossover moves with the stop: 90 and
    // 110% keep the 30px row and the 62px need, 125% needs 62.5px (hidden at the
    // 62px 572px column), 140% needs 65.2px (hidden through the 65px column at
    // 575px and back at 66px/576px).
    { height: 572, order: "reordered", pointer: "mouse", textScale: 90, toolbar: "flex" },
    { height: 572, order: "reordered", pointer: "mouse", textScale: 110, toolbar: "flex" },
    { height: 572, order: "reordered", pointer: "mouse", textScale: 125, toolbar: "none" },
    { height: 573, order: "reordered", pointer: "mouse", textScale: 125, toolbar: "flex" },
    { height: 572, order: "reordered", pointer: "mouse", textScale: 140, toolbar: "none" },
    { height: 574, order: "reordered", pointer: "mouse", textScale: 140, toolbar: "none" },
    { height: 575, order: "reordered", pointer: "mouse", textScale: 140, toolbar: "none" },
    { height: 576, order: "reordered", pointer: "mouse", textScale: 140, toolbar: "flex" },
    // Ordinary desktop columns pin the static clearance of the rail gap.
    { height: 720, order: "default", pointer: "mouse", textScale: 100, toolbar: "flex" },
    { height: 720, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "flex" },
    { height: 800, order: "default", pointer: "mouse", textScale: 100, toolbar: "flex" },
    { height: 800, order: "reordered", pointer: "mouse", textScale: 100, toolbar: "flex" },
    { height: 900, order: "default", pointer: "mouse", textScale: 100, toolbar: "flex" },
  ];

  it.each(ordinaryClearanceCases)(
    "keeps the last nav key whole and clickable above the well at $height ($order order, $pointer, $textScale%)",
    async ({ height, order, pointer, textScale, toolbar }) => {
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const rows = Array.from({ length: 6 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
      );
      const config =
        order === "reordered" ? { ui: { prefs: { sidebarEntries: allSidebarRoutes } } } : {};
      const context = await suite.newBrowserContext({
        hasTouch: pointer === "touch",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height, width: 1280 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows),
          "config.get": {
            config,
            sourceConfig: config,
            hash: `sidebar-clearance-${order}`,
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
        },
        sessionKey: "agent:main:main",
        presenceUsers: [{ self: true, id: `clearance-ordinary-${order}`, name: "Riley" }],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        if (textScale !== 100) {
          await bootTextScale(page, suite.server.baseUrl, textScale);
        }
        const layout = await settleSidebarClearance(page, false);
        // Captured before the assertions so a regressed run retains the exact
        // column it failed on.
        await captureSidebarUiProof(suite, page, `solo-clearance-ordinary-${order}-${height}.png`);
        expect(layout.onlineMounted, "solo presence renders no Online section").toBe(false);
        expect(layout.bodyOverflow, "the solo column keeps zero body overflow").toBeLessThanOrEqual(
          1,
        );
        expect(layout.automationsLink, "the Automations key face still renders").not.toBeNull();
        expect(
          layout.wholeSessionRowCount,
          "one whole session row stays readable",
        ).toBeGreaterThanOrEqual(1);
        expect(
          layout.firstSessionRow!.bottom,
          "the first session row is not clipped by its scroller",
        ).toBeLessThanOrEqual(layout.sessionScroller!.bottom);
        // No tolerance: the rail viewport ends at the key's own lower edge, and
        // the Session frame starts below it, so nothing paints over the key.
        expect(
          layout.automationsLink!.bottom,
          "the whole Automations key sits inside the rail viewport",
        ).toBeLessThanOrEqual(layout.nav!.bottom);
        expect(
          layout.well!.top,
          "the Session frame starts below the whole Automations key",
        ).toBeGreaterThanOrEqual(layout.automationsLink!.bottom);
        // The DOM-box check above passed even when the rail gap only matched the
        // key's border box: the seated contact shadow reaches below that box, so
        // a gap equal to the shadow's reach left the frame crowding the key's
        // lower edge with no visible shelf. Bound the visual clearance against
        // the key's actual shadow extent plus a visible shelf (0.5px sub-pixel
        // tolerance). The old 6px gap fails this; the restored 12px gap passes.
        expect(
          layout.well!.top - layout.automationsLink!.bottom,
          "the Session frame keeps a visible shelf below the Automations key's contact shadow",
        ).toBeGreaterThanOrEqual(
          layout.automationsLinkShadowOverhang! + minVisibleRailClearance - 0.5,
        );
        expect(
          layout.automationsLinkHit,
          "the key's lower edge receives the pointer instead of the Session frame",
        ).toBe(true);
        expect(
          layout.sessionToolbarDisplay,
          toolbar === "none"
            ? "a column that cannot afford the toolbar yields it instead of a key or a row"
            : "an ordinary column keeps the session toolbar",
        ).toBe(toolbar);

        // The lower edge activates the route through its real hit target.
        const urlBefore = page.url();
        await page.mouse.click(
          layout.automationsLink!.left + layout.automationsLink!.width / 2,
          layout.automationsLink!.bottom - 2,
        );
        await waitForControlUiRoute(page, { routeId: "cron" });
        expect(page.url()).not.toBe(urlBefore);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the Automations entry clear of the well in roster mode under solo presence", async () => {
    // Just above the compact band, where the independent regions leave the
    // roster well tight enough that the scroller cannot afford the compact
    // group header plus one whole row.
    const height = 505;
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = Array.from({ length: 6 }, (_, index) =>
      sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
    );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
        "config.get": clearanceServerConfig(),
        ...clearanceRosterResponses(),
      },
      sessionKey: "agent:main:main",
      // Solo presence: the roster renders no Online section at any height.
      presenceUsers: [{ self: true, id: "clearance-roster-self", name: "Riley" }],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await bootRosterMode(page, suite.server.baseUrl);
      const layout = await settleSidebarClearance(page, false);
      expect(layout.onlineMounted, "solo presence renders no Online section in roster mode").toBe(
        false,
      );
      expect(layout.bodyOverflow, "roster sidebar body keeps no overflow").toBeLessThanOrEqual(1);
      expect(
        layout.navScrollable,
        "solo roster keeps the nav rail unscrollable at the affected height",
      ).toBe(false);
      expect(layout.automations, "the Automations entry still renders").not.toBeNull();
      expect(
        layout.automations!.bottom,
        "the whole Automations entry sits inside the nav viewport",
      ).toBeLessThanOrEqual(layout.nav!.bottom);
      expect(
        layout.well!.top,
        "the session well clears the whole Automations entry",
      ).toBeGreaterThanOrEqual(layout.automations!.bottom);
      expect(
        layout.wholeSessionRowCount,
        "a whole session row and its name stay visible in the roster well",
      ).toBeGreaterThanOrEqual(1);
      expect(
        layout.rosterHeaderDisplay,
        "the tight solo column yields the compact roster group header — the scroller cannot afford the header plus one whole row — so the row stays readable without scrolling the nav rail",
      ).toBe("none");
      await captureSidebarUiProof(suite, page, "solo-clearance-roster-mode.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  // The header-yield concession is exact per column, not a height band: just
  // above the tight solo slice the well scroller affords the compact group
  // header plus one whole session row, so the header must stay mounted beside
  // the readable row. The 520 case above pins the yielding side; this pins
  // the roomy side of the 80px scroller threshold.
  it("keeps the roster group header mounted beside a whole row above the tight solo slice", async () => {
    const height = 560;
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const rows = Array.from({ length: 6 }, (_, index) =>
      sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
    );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(rows),
        "config.get": clearanceServerConfig(),
        ...clearanceRosterResponses(),
      },
      sessionKey: "agent:main:main",
      // Solo presence: the roster renders no Online section at any height.
      presenceUsers: [{ self: true, id: "clearance-roster-roomy-self", name: "Riley" }],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await bootRosterMode(page, suite.server.baseUrl);
      const layout = await settleSidebarClearance(page, false);
      await captureSidebarUiProof(suite, page, "solo-clearance-roster-roomy-header.png");
      expect(
        layout.rosterHeaderDisplay,
        "the scroller affords the header plus one whole row, so the compact group header stays mounted",
      ).toBe("grid");
      expect(
        layout.wholeSessionRowCount,
        "a whole session row and its name stay visible in the roster well",
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  // Solo presence must keep the compact-height band's narrower floors: the
  // class-scoped release out-specificities the band's plain selectors below
  // 500px, so the band restates the solo selectors — and without that, the
  // ordinary 98px allocation over-reserved compact solo columns until the
  // well overlapped the footer while duo kept the compressed 58px floor.
  const soloCompactHeights = [500, 400, 300, 280] as const;

  it.each(
    soloCompactHeights.flatMap((height) => [
      { height, mode: "sessions" as const },
      { height, mode: "roster" as const },
    ]),
  )(
    "keeps compact solo columns free of overflow at $height ($mode mode)",
    async ({ height, mode }) => {
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const rows = Array.from({ length: 6 }, (_, index) =>
        sessionRow(`agent:main:chat-${index}`, `Chat ${index}`, baseTime - index * 60_000),
      );
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height, width: 1280 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows),
          "config.get": clearanceServerConfig(),
          ...(mode === "roster" ? clearanceRosterResponses() : {}),
        },
        sessionKey: "agent:main:main",
        // Solo presence: no Online section at any height.
        presenceUsers: [{ self: true, id: `clearance-compact-self-${mode}`, name: "Riley" }],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        if (mode === "roster") {
          await bootRosterMode(page, suite.server.baseUrl);
        }
        const layout = await settleSidebarClearance(page, false);
        // Captured before the assertions so a regressed run retains the exact
        // compact state it failed on.
        await captureSidebarUiProof(suite, page, `solo-compact-${mode}-${height}.png`);
        expect(layout.onlineMounted, "solo presence renders no Online section").toBe(false);
        expect(
          layout.bodyOverflow,
          "the compact solo column keeps zero body overflow",
        ).toBeLessThanOrEqual(1);
        expect(
          layout.well!.bottom,
          "the compact solo well stays above the footer divider",
        ).toBeLessThanOrEqual(layout.footer!.top + 0.5);
        expect(
          layout.wholeSessionRowCount,
          "a whole session row and its name stay visible",
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
