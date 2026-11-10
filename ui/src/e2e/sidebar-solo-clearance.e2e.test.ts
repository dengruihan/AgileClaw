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

// The solo-presence clearance suite: with renderAppSidebarOnline rendering no
// section, the column's joint allocation (Pages rail vs session well vs
// footer) is exercised at every affected height — the released floor must
// keep the whole Automations entry clear of the well in sessions and roster
// modes, the compact band must keep its narrower floors, and the compact
// roster group header must yield exactly when the well scroller cannot
// afford it plus one whole session row (the layout.css concession).
const suite = createSidebarCustomizationSuite(
  "Control UI sidebar solo clearance mocked Gateway E2E",
);

suite.define(() => {
  // Solo presence must release the Online share of the joint allocation
  // floor: while renderAppSidebarOnline returns nothing, reserving
  // --sidebar-online-floor anyway squeezed the nav rail until its lowest row
  // clipped against the session well's top edge. The seeded synced pins put
  // Automations last — the user-reordered nav where the wasted floor bites —
  // and a 520px viewport sits inside the affected band: the nav needs more
  // than the honest well-only floor but less than well + Online floors.
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
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      };
      const nav = document.querySelector<HTMLElement>(".sidebar-nav");
      return {
        nav: box(".sidebar-nav"),
        navScrollable: nav ? nav.scrollHeight - nav.clientHeight > 1 : null,
        automations: box('.sidebar-nav [data-sidebar-entry="route:cron"]'),
        automationsLabel: box('.sidebar-nav [data-sidebar-entry="route:cron"] .nav-item__text'),
        rosterHeaderDisplay: (() => {
          const header = document.querySelector(".sidebar-agent-roster__header");
          return header ? getComputedStyle(header).display : "absent";
        })(),
        well: box(".sidebar-sessions"),
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
      // Multi-user baseline: the mounted Online roster owns its floor share
      // and the Online roster never overlaps the well. (The duo body keeps a
      // pre-existing ~10px overflow at this height with a six-row nav — a
      // duo-mode condition outside this fix.)
      expect(duo.onlineMounted).toBe(true);
      expect(duo.online!.bottom).toBeLessThanOrEqual(duo.well!.top);

      // The second identity leaves: the section unmounts and its floor share
      // must be released, so the nav rail keeps the whole Automations entry
      // clear of the rising well instead of being squeezed under it.
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
      ).toBeLessThanOrEqual(solo.nav!.bottom + 0.5);
      expect(
        solo.automationsLabel!.bottom,
        "the Automations label is not clipped by the nav rail",
      ).toBeLessThanOrEqual(solo.nav!.bottom + 0.5);
      expect(
        solo.well!.top,
        "the session well clears the whole Automations entry",
      ).toBeGreaterThanOrEqual(solo.automations!.bottom - 0.5);
      expect(
        solo.well!.bottom,
        "the released solo floor keeps the whole well above the footer divider",
      ).toBeLessThanOrEqual(solo.footer!.top + 0.5);
      expect(
        solo.nav!.height,
        "solo presence restores the nav height the Online floor reserved",
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
      await captureSidebarUiProof(suite, page, "solo-clearance-second-identity-returned.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the Automations entry clear of the well in roster mode under solo presence", async () => {
    const height = 520;
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
      ).toBeLessThanOrEqual(layout.nav!.bottom + 0.5);
      expect(
        layout.well!.top,
        "the session well clears the whole Automations entry",
      ).toBeGreaterThanOrEqual(layout.automations!.bottom - 0.5);
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
