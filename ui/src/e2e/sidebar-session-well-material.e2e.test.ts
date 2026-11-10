import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  sessionsListResponse,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar session-well material",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  // The session well is a recess pressed into the sidebar: a soft inner shade
  // on the top and left, and a crisp catch-light lip seated on the inner
  // right and bottom edges. The lip must carry zero blur — a blurred band
  // floats the brightest light inside the floor, feathers the recess border
  // it is supposed to line, and reads as a washed edge (the canonical
  // --well-shadow groove model keeps the lip at 0 blur for the same reason).
  const materialCases = [
    {
      label: "ordinary dark",
      colorScheme: "dark",
      drawer: false,
      roster: false,
      short: false,
      users: 8,
    },
    {
      label: "ordinary light",
      colorScheme: "light",
      drawer: false,
      roster: false,
      short: false,
      users: 8,
    },
    {
      label: "solo short dark",
      colorScheme: "dark",
      drawer: false,
      roster: false,
      short: true,
      users: 1,
    },
    {
      label: "compact drawer dark",
      colorScheme: "dark",
      drawer: true,
      roster: false,
      short: false,
      users: 8,
    },
    {
      label: "roster dark",
      colorScheme: "dark",
      drawer: false,
      roster: true,
      short: false,
      users: 8,
    },
  ] as const;

  /** Per-channel luminance of one device pixel in a decoded RGBA screenshot. */
  function luminance(pixels: Uint8Array, width: number, x: number, y: number): number {
    const offset = (y * width + x) * 4;
    return 0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!;
  }

  /**
   * The rendered lip contract on one well edge at deviceScaleFactor 3.
   * Sampling walks inward from the edge on a content-free line: the row-free
   * padding band between the well edge and its nested rows (right edge at
   * mid-height, bottom edge over the empty floor below a deliberately short
   * roster). The whole band below the lip must stay flat, and the innermost
   * CSS px must carry a bright lip seated on the edge instead of a blurred
   * band: the pre-fix 2px-blur highlight brightened the floor 2-3px inside
   * the edge and left the boundary itself undefined.
   */
  function expectWellEdgeLip(
    pixels: Uint8Array,
    width: number,
    height: number,
    edge: "right" | "bottom",
    insidePaddingDevicePx: number,
  ): void {
    const at = (insideDevicePx: number, alongDevicePx: number): number =>
      edge === "right"
        ? luminance(pixels, width, width - 1 - insideDevicePx, alongDevicePx)
        : luminance(pixels, width, alongDevicePx, height - 1 - insideDevicePx);
    const along = Math.floor((edge === "right" ? height : width) / 2);
    const sample = (insideDevicePx: number) => at(insideDevicePx, along);
    // The readable band is the well's own padding: content-free at rest and
    // wide enough for a floor reference below the 1px lip (3 device px).
    const band = Math.max(8, Math.round(insidePaddingDevicePx));
    const bandSamples = Array.from({ length: band - 3 }, (_, index) => sample(index + 4));
    const floor = bandSamples.toSorted((a, b) => a - b)[Math.floor(bandSamples.length / 2)]!;
    for (const [index, value] of bandSamples.entries()) {
      expect(
        Math.abs(value - floor),
        `${edge} edge floor brightens ${index + 4} device px inside the well edge`,
      ).toBeLessThanOrEqual(1);
    }
    // The innermost CSS px (3 device px) carries the catch-light lip.
    const lip = Math.max(sample(1), sample(2), sample(3));
    expect(lip, `${edge} edge lip contrast against the well floor`).toBeGreaterThanOrEqual(
      floor + 4.5,
    );
    // The lip seats on the boundary: the edge pixel itself must not dip
    // darker than both surfaces (no dark seam between lip and sidebar).
    expect(sample(0), `${edge} edge boundary seam`).toBeGreaterThanOrEqual(
      Math.min(floor, lip) - 1,
    );
  }

  it.each(materialCases)(
    "keeps the session-well recess lip seated on the right and bottom edges ($label)",
    async ({ label, colorScheme, drawer, roster, short, users }) => {
      const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
      const sessionKey = "agent:main:dashboard:active-session";
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      // Two sessions keep the well floor below the last row empty at every
      // supported height, so the bottom-edge sample line stays content-free.
      const rows = Array.from({ length: 2 }, (_, index) =>
        index === 0
          ? sessionRow(sessionKey, "Plan the next interface update", baseTime)
          : sessionRow(
              `agent:main:dashboard:session-${index}`,
              `Review session ${index}`,
              baseTime,
            ),
      );
      const compact = drawer;
      // The short case exercises the ≤500px band where the Online section
      // yields its space to the well; its in-well session toolbar is removed
      // at that height, keeping the floor below the two rows empty for the
      // bottom-edge sample line.
      const context = await suite.newBrowserContext({
        colorScheme,
        deviceScaleFactor: 3,
        locale: "en-US",
        viewport: compact
          ? { height: 844, width: 390 }
          : short
            ? { height: 500, width: 1280 }
            : { height: 800, width: 1280 },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse(rows),
          ...(roster
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
                  cases: ["main", "forge"].map((agentId) => ({
                    match: { agentId },
                    response: { agentId, name: "Harbor", emoji: "⚓", avatar: "" },
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
                  snapshotRevision: "well-material-roster",
                  total: 0,
                  offset: 0,
                  limit: 50,
                  hasMore: false,
                  nextOffset: null,
                },
              }
            : {}),
        },
        sessionKey,
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
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        if (roster) {
          // Roster mode is a persisted UI setting: apply it after first load
          // and reload so the app boots with it (boot-time settings sync can
          // clobber a pre-load write), mirroring the sidebar allocation lane.
          const settingsKey = await page.evaluate(() => {
            return Object.keys(localStorage).find((key) => key.includes("settings")) ?? "";
          });
          expect(settingsKey, "bundled settings storage key").not.toBe("");
          await page.evaluate(
            ({ key }) => {
              localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" }));
            },
            { key: settingsKey },
          );
          await page.reload();
        }
        if (compact) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
        }
        await waitForSessionRosterHydration(page);
        if (roster) {
          // The persisted roster mode must actually mount the grouped roster
          // presentation (agent groups beside the shared well) — a green case
          // name alone does not prove the roster setup was exercised.
          await page
            .locator(".sidebar-agent-roster [data-agent-group]")
            .first()
            .waitFor({ state: "visible", timeout: 20_000 });
        }
        if (users === 1) {
          // Solo presence renders no Online section at any height; the well is
          // the only well-sized surface left between the nav and the footer.
          const online = page.locator(".sidebar-online");
          expect(
            (await online.count()) === 0 || !(await online.first().isVisible()),
            "solo presence renders no visible Online section",
          ).toBe(true);
        }
        const well = page.locator(".sidebar-sessions").first();
        await well.waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready);
        // The bottom-edge sample line crosses the floor below the last row,
        // so that zone must stay content-free: the two-row roster (plus the
        // ≤500px band removing the in-well toolbar in the short case) keeps
        // it face-only at every case height.
        const floorGap = await well.evaluate((element) => {
          const wellRect = element.getBoundingClientRect();
          const wellRows = element.querySelectorAll(".sidebar-recent-session");
          const lastRow = wellRows[wellRows.length - 1]?.getBoundingClientRect();
          return wellRect.bottom - (lastRow?.bottom ?? wellRect.top);
        });
        expect(
          floorGap,
          "empty floor below the last row keeps the bottom sample line content-free",
        ).toBeGreaterThanOrEqual(24);

        // Geometry: exactly the shade layer plus the zero-blur lip layer.
        const { shadows, padding } = await well.evaluate((element) => {
          const style = getComputedStyle(element);
          const parsed = style.boxShadow
            .split(/,(?![^(]*\))/)
            .map((layer) =>
              layer.trim().match(/^(.*) (-?[\d.]+)px (-?[\d.]+)px ([\d.]+)px ([\d.]+)px (inset)$/),
            );
          if (parsed.some((layer) => layer === null)) {
            throw new Error(`unparsable inset box-shadow layers: ${style.boxShadow}`);
          }
          return {
            shadows: parsed.map((layer) => layer!.slice(2, 6).map(Number)),
            padding: {
              right: Number.parseFloat(style.paddingRight),
              bottom: Number.parseFloat(style.paddingBottom),
            },
          };
        });
        expect(shadows, "the well paints the shade and lip inset layers").toEqual([
          [1, 1, 2, 0],
          [-1, -1, 0, 0],
        ]);

        const image = photon.PhotonImage.new_from_byteslice(await well.screenshot());
        expectWellEdgeLip(
          image.get_raw_pixels(),
          image.get_width(),
          image.get_height(),
          "right",
          padding.right * 3,
        );
        expectWellEdgeLip(
          image.get_raw_pixels(),
          image.get_width(),
          image.get_height(),
          "bottom",
          padding.bottom * 3,
        );

        if (captureProof) {
          await well.screenshot({
            path: `${suite.artifactDir}/session-well-${label.replaceAll(" ", "-")}.png`,
            animations: "disabled",
          });
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
