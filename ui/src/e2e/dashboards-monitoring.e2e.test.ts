import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiSessionRow,
  type ControlUiSessionFixture,
} from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Dashboards marketplace monitoring mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const systemInfo = {
  machineName: "Gateway machine",
  hostname: "gateway-host",
  platform: "linux",
  release: "test",
  arch: "x64",
  osLabel: "Linux",
  nodeVersion: "v26",
  pid: 1,
  uptimeMs: 1_000,
  cpuCount: 4,
  memoryTotalBytes: 8_192,
  memoryFreeBytes: 4_096,
  loadAverage: [0.5, 0.4, 0.3],
  diskTotalBytes: 16_384,
  diskAvailableBytes: 8_192,
};

const environments = {
  environments: [
    { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
    { id: "worker-one", type: "worker", label: "Cloud worker", status: "available" },
    { id: "node:off", type: "node", label: "Paired workstation", status: "available" },
  ],
};

function installMonitoringGateway(
  page: Page,
  extra: {
    awaitInitialRoster?: boolean;
    deferred?: boolean;
    sessions?: ControlUiSessionFixture[];
  } = {},
) {
  return installMockGateway(page, {
    ...(extra.awaitInitialRoster === false ? { awaitInitialRoster: false } : {}),
    sessions: extra.sessions ?? [
      createControlUiSessionRow("agent:main:dashboard-proof", "Release health", 10),
      createControlUiSessionRow("agent:main:dashboard-second", "Cost monitor", 5),
    ],
    featureMethods: ["board.get", "environments.list", "node.list", "system.info"],
    ...(extra.deferred ? { deferredMethods: ["environments.list"] } : {}),
    methodResponses: {
      "board.get": { revision: 1, sessionKey: "agent:main:dashboard-proof", tabs: [], widgets: [] },
      "environments.list": environments,
      "node.list": {
        nodes: [
          {
            nodeId: "off",
            connected: true,
            hostStats: {
              cpuCount: 2,
              memoryTotalBytes: 4_096,
              memoryFreeBytes: 1_024,
              updatedAtMs: Date.now() - 600_000,
            },
          },
        ],
      },
      "system.info": systemInfo,
    },
  });
}

async function openMarket(page: Page) {
  await page.locator("[data-marketplace-trigger]").click();
  const drawer = page.locator("[data-marketplace]");
  await drawer.waitFor();
  return drawer;
}

suite.define(() => {
  it("installs no monitoring preset by default and never reads machine inventory", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-marketplace-default");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();

      // A fresh page ships no monitoring region and issues no inventory reads.
      expect(await page.locator("[data-monitoring]").count()).toBe(0);
      expect(await page.locator(".dashboards-monitoring__machine").count()).toBe(0);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      expect(await gateway.getRequests("system.info")).toHaveLength(0);
      await page.screenshot({ path: `${artifacts}/01-default-desktop.png` });

      await page.setViewportSize({ width: 560, height: 900 });
      await expect.poll(() => page.locator("[data-marketplace-trigger]").isVisible()).toBe(true);
      // Owned geometry wait: the resized layout must settle before capturing.
      await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
      await page.screenshot({ path: `${artifacts}/02-default-narrow.png` });
    } finally {
      await context.close();
    }
  });

  it("adds all three measurements from the market, persists across reload, and removes", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-marketplace-install");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();

      // The preset card presents CPU load, memory used, and disk available.
      await page.locator("[data-marketplace-trigger]").click();
      const drawer = page.locator("[data-marketplace]");
      await drawer.waitFor();
      const preset = drawer.locator('[data-marketplace-preset="system-monitoring"]');
      await expect.poll(() => preset.getAttribute("data-installed")).toBe("false");
      expect(await preset.locator("[data-marketplace-measurement]").count()).toBe(3);
      expect(await preset.textContent()).toContain("CPU load");
      expect(await preset.textContent()).toContain("Memory used");
      expect(await preset.textContent()).toContain("Disk available");
      await page.screenshot({ path: `${artifacts}/01-market-desktop.png` });

      // Adding installs all three measurements for every reported machine.
      await preset.locator("[data-marketplace-add]").click();
      const monitoring = page.locator("[data-monitoring]");
      await monitoring.getByText("Gateway machine", { exact: true }).waitFor();
      expect(await monitoring.locator("[data-monitoring-machine]").count()).toBe(3);
      expect(
        await monitoring.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(3);
      // A stale node keeps its last reading labelled instead of showing zeros.
      expect(
        await monitoring
          .locator('[data-monitoring-machine="node:off"] .dashboards-monitoring__vitals')
          .getAttribute("data-stale"),
      ).toBe("true");
      expect(await monitoring.textContent()).toContain("Last reported");
      expect(await monitoring.textContent()).toContain("This machine has not reported");
      // The card now exposes installed state with a Remove action.
      await expect.poll(() => preset.getAttribute("data-installed")).toBe("true");
      const badge = preset.locator(".dashboards-marketplace__installed");
      expect(await badge.count()).toBe(1);
      expect(await badge.textContent()).toContain("Installed");
      expect(await preset.locator("[data-marketplace-remove]").count()).toBe(1);
      await page.screenshot({ path: `${artifacts}/02-market-installed-desktop.png` });

      // The install persists per Gateway origin in this browser, never in the Gateway.
      await drawer.locator("[data-marketplace-handle]").click();
      await expect.poll(() => page.locator("[data-marketplace]").count()).toBe(0);

      // One owner per page: a sidebar re-render never starts another inventory reader.
      const before = (await gateway.getRequests("environments.list")).length;
      await page.locator('.sidebar-nav a[href$="/dashboards"]').click();
      await page.locator(".dashboards-toolbar input[type=search]").fill("release");
      await page.locator(".dashboards-toolbar input[type=search]").fill("");
      expect((await gateway.getRequests("environments.list")).length).toBe(before);
      expect(await gateway.getRequests("backup.status")).toHaveLength(0);

      await page.reload();
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(3);
      await page.screenshot({ path: `${artifacts}/03-after-reload-desktop.png` });

      // Removing deletes the monitoring region.
      await page.locator("[data-marketplace-trigger]").click();
      await page.locator("[data-marketplace] [data-marketplace-remove]").click();
      await expect.poll(() => page.locator("[data-monitoring]").count()).toBe(0);
      await expect
        .poll(() =>
          page
            .locator('[data-marketplace-preset="system-monitoring"]')
            .getAttribute("data-installed"),
        )
        .toBe("false");
      await page.screenshot({ path: `${artifacts}/04-after-remove-desktop.png` });
    } finally {
      await context.close();
    }
  });

  it("keeps the marketplace reachable while the gallery is empty or fails", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-marketplace-reachable");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMonitoringGateway(page, {
        sessions: [],
        awaitInitialRoster: false,
      });
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator("[data-dashboards-empty]").waitFor();

      // The page-level action survives an empty gallery and installs the preset.
      await page.locator("[data-marketplace-trigger]").click();
      const drawer = page.locator("[data-marketplace]");
      await drawer.waitFor();
      await drawer.locator("[data-marketplace-add]").click();
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();
      await page.screenshot({ path: `${artifacts}/01-empty-gallery-installed.png` });

      // A failed gallery load keeps the marketplace usable too.
      await page.reload();
      await page.locator("[data-dashboards-empty]").waitFor();
      await gateway.setMethodResponse("sessions.list", {
        __mockError: { code: "UNAVAILABLE", message: "Dashboard listing unavailable" },
      });
      await page.reload();
      await page
        .locator('[role="alert"]')
        .filter({ hasText: "Dashboard listing unavailable" })
        .waitFor();
      const failedDrawer = await openMarket(page);
      expect(await page.locator("[data-marketplace-preset]").count()).toBe(1);
      // The settled drawer must sit fully inside the viewport, not mid-entrance.
      const failedDrawerBox = await failedDrawer.boundingBox();
      expect(failedDrawerBox!.x).toBeGreaterThan(0);
      expect(failedDrawerBox!.x + failedDrawerBox!.width).toBeLessThanOrEqual(1440);
      await page.screenshot({ path: `${artifacts}/02-failed-gallery-market.png` });
    } finally {
      await context.close();
    }
  });

  it("dismisses the marketplace drawer with the keyboard and restores focus", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-marketplace-keyboard");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();

      const trigger = page.locator("[data-marketplace-trigger]");
      await trigger.focus();
      await trigger.click();
      const drawer = page.locator("[data-marketplace]");
      await drawer.waitFor();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      // The drawer sits inside the viewport with its close control reachable.
      const box = await drawer.boundingBox();
      expect(box!.x).toBeGreaterThan(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
      await page.screenshot({ path: `${artifacts}/01-open-desktop.png` });

      // Escape closes the dialog and returns focus to the persistent trigger.
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator("[data-marketplace]").count()).toBe(0);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.hasAttribute("data-marketplace-trigger") ?? false,
          ),
        )
        .toBe(true);
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");

      // Narrow widths keep the drawer inside the viewport and its actions usable.
      await page.setViewportSize({ width: 560, height: 900 });
      await trigger.click();
      await drawer.waitFor();
      const narrow = await drawer.boundingBox();
      expect(narrow!.x).toBeGreaterThanOrEqual(0);
      expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(560);
      await drawer.locator("[data-marketplace-add]").click();
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();
      await page.screenshot({ path: `${artifacts}/02-installed-narrow.png` });
      await drawer.locator("[data-marketplace-handle]").click();
      await expect.poll(() => page.locator("[data-marketplace]").count()).toBe(0);
      await page.screenshot({ path: `${artifacts}/03-region-narrow.png` });
    } finally {
      await context.close();
    }
  });

  it("retains the monitoring loading, error, and empty states while installed", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-monitoring-states");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMonitoringGateway(page, { deferred: true });
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();
      await page.locator("[data-marketplace-trigger]").click();
      await page.locator("[data-marketplace] [data-marketplace-add]").click();
      await page.locator("[data-marketplace]").locator("[data-marketplace-handle]").click();
      await expect.poll(() => page.locator("[data-marketplace]").count()).toBe(0);
      const monitoring = page.locator("[data-monitoring]");
      await expect.poll(() => monitoring.getByText("Loading machines").count()).toBe(1);
      expect(await monitoring.locator('[aria-busy="true"]').count()).toBe(1);
      await page.screenshot({ path: `${artifacts}/01-loading.png` });

      await gateway.rejectDeferred("environments.list", {
        code: "UNAVAILABLE",
        message: "Machine inventory unavailable",
        retryable: true,
      });
      await expect
        .poll(() => monitoring.locator('[role="alert"]').textContent())
        .toContain("Machine inventory unavailable");
      await page.screenshot({ path: `${artifacts}/02-error.png` });

      await gateway.setMethodResponse("environments.list", { environments: [] });
      await monitoring.getByRole("button", { name: "Refresh machines" }).click();
      await expect
        .poll(() => monitoring.getByText("No machines are available to this account.").count())
        .toBe(1);
      await page.screenshot({ path: `${artifacts}/03-empty.png` });
    } finally {
      await context.close();
    }
  });

  it("keeps the retired Systems route and sidebar entry gone", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}systems`);
      await page.locator("openclaw-app-sidebar").waitFor();
      expect(await page.locator("openclaw-systems-page").count()).toBe(0);
      expect(await page.locator("[data-monitoring]").count()).toBe(0);
      expect(await page.locator('.sidebar-nav a[href$="/systems"]').count()).toBe(0);

      const more = page.locator("openclaw-app-sidebar").getByRole("button", { name: "Show more" });
      if ((await more.count()) > 0) {
        await more.click();
        expect(await page.getByRole("menuitem", { name: "Systems", exact: true }).count()).toBe(0);
        await page.keyboard.press("Escape");
      }
    } finally {
      await context.close();
    }
  });
});
