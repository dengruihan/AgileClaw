import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Dashboards machine monitoring mocked Gateway E2E",
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

function installMonitoringGateway(page: Page, extra: { deferred?: boolean } = {}) {
  return installMockGateway(page, {
    sessions: [
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

suite.define(() => {
  it("shows machine monitoring above the dashboard gallery from one inventory owner", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-monitoring");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      const monitoring = page.locator("[data-monitoring]");
      await monitoring.getByText("Gateway machine", { exact: true }).waitFor();
      await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();

      expect(await monitoring.locator("[data-monitoring-machine]").count()).toBe(3);
      expect(await monitoring.getByText("Cloud worker", { exact: true }).count()).toBe(1);
      expect(await monitoring.getByText("Paired workstation", { exact: true }).count()).toBe(1);
      // The Gateway reports every measurement; only its own card renders three graphs.
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

      const geometry = await Promise.all([
        monitoring.boundingBox(),
        page.locator(".dashboards-gallery").boundingBox(),
      ]);
      expect(geometry[0]!.y).toBeLessThan(geometry[1]!.y);

      // One owner for the whole page: a sidebar re-render must not start another
      // inventory reader, and the removed Systems page never polled backups here.
      const before = (await gateway.getRequests("environments.list")).length;
      await page.locator('.sidebar-nav a[href$="/dashboards"]').click();
      await page.locator(".dashboards-toolbar input[type=search]").fill("release");
      await page.locator(".dashboards-toolbar input[type=search]").fill("");
      expect((await gateway.getRequests("environments.list")).length).toBe(before);
      expect(await gateway.getRequests("backup.status")).toHaveLength(0);

      await page.screenshot({ path: `${artifacts}/01-dashboards-monitoring-desktop.png` });
      await page.setViewportSize({ width: 560, height: 900 });
      await expect
        .poll(() => monitoring.getByText("Gateway machine", { exact: true }).isVisible())
        .toBe(true);
      await page.screenshot({ path: `${artifacts}/02-dashboards-monitoring-narrow.png` });
    } finally {
      await context.close();
    }
  });

  it("renders loading and error states for the inventory reads", async () => {
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

  it("lets users choose machine panels and keeps the choice after a reload", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-panel-library");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const gatewayMachine = page.locator('[data-monitoring-machine="gateway"]');
    try {
      await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      const monitoring = page.locator("[data-monitoring]");
      await monitoring.getByText("Gateway machine", { exact: true }).waitFor();
      expect(await gatewayMachine.locator("openclaw-sparkline").count()).toBe(3);
      await page.screenshot({ path: `${artifacts}/01-default-desktop.png` });

      await page.locator(".dashboards-monitoring__panels").click();
      const library = page.locator("[data-panel-library]");
      await library.waitFor();
      await expect.poll(() => library.locator("[data-panel-option]").count()).toBe(3);
      // The drawer sits inside the viewport and leaves its close control reachable.
      const drawer = await library.boundingBox();
      expect(drawer!.x).toBeGreaterThan(0);
      expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(1440);
      await page.screenshot({ path: `${artifacts}/02-panel-library-desktop.png` });

      // Removing the CPU panel keeps memory and disk visible.
      await library.locator('[data-panel-option="load"] input').uncheck();
      await expect
        .poll(() => gatewayMachine.locator(".dashboards-monitoring__vital--load").count())
        .toBe(0);
      expect(await gatewayMachine.locator("openclaw-sparkline").count()).toBe(2);
      await page.screenshot({ path: `${artifacts}/03-customized-desktop.png` });
      await library.getByRole("button", { name: "Done" }).click();
      await expect.poll(() => page.locator("[data-panel-library]").count()).toBe(0);

      // A reload keeps this browser's selection; the Gateway is never asked to store it.
      await page.reload();
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();
      await expect
        .poll(() =>
          page
            .locator('[data-monitoring-machine="gateway"] .dashboards-monitoring__vital--load')
            .count(),
        )
        .toBe(0);
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(2);
      await page.screenshot({ path: `${artifacts}/04-after-reload-desktop.png` });

      // Adding it back restores the third panel.
      await page.locator(".dashboards-monitoring__panels").click();
      await page.locator('[data-panel-option="load"] input').check();
      await page.locator("[data-panel-library]").getByRole("button", { name: "Done" }).click();
      await expect
        .poll(() =>
          page
            .locator('[data-monitoring-machine="gateway"] .dashboards-monitoring__vital--load')
            .count(),
        )
        .toBe(1);
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(3);
    } finally {
      await context.close();
    }
  });

  it("keeps the panel library usable and dismissible on a narrow screen", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-panel-library-narrow");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 560, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installMonitoringGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();
      await page.screenshot({ path: `${artifacts}/01-default-narrow.png` });

      await page.locator(".dashboards-monitoring__panels").click();
      const library = page.locator("[data-panel-library]");
      await library.waitFor();
      const drawer = await library.boundingBox();
      expect(drawer!.x).toBeGreaterThanOrEqual(0);
      expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(560);
      await page.screenshot({ path: `${artifacts}/02-panel-library-narrow.png` });

      await library.locator('[data-panel-option="load"] input').uncheck();
      await library.getByRole("button", { name: "Close panel library" }).click();
      await expect.poll(() => page.locator("[data-panel-library]").count()).toBe(0);
      await expect
        .poll(() =>
          page
            .locator('[data-monitoring-machine="gateway"] .dashboards-monitoring__vital--load')
            .count(),
        )
        .toBe(0);
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(2);
      await page.screenshot({ path: `${artifacts}/03-customized-narrow.png` });
    } finally {
      await context.close();
    }
  });

  it("explains an empty panel choice and reopens the library from it", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-panel-library-empty");
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
      await page
        .locator("[data-monitoring]")
        .getByText("Gateway machine", { exact: true })
        .waitFor();

      await page.locator(".dashboards-monitoring__panels").click();
      const library = page.locator("[data-panel-library]");
      await library.waitFor();
      for (const id of ["load", "memory", "disk"]) {
        await library.locator(`[data-panel-option="${id}"] input`).uncheck();
      }
      await library.getByRole("button", { name: "Done" }).click();

      const empty = page.locator("[data-monitoring-no-panels]");
      await empty.waitFor();
      await expect.poll(() => empty.getByText("No machine panels selected").count()).toBe(1);
      expect(await page.locator("[data-monitoring-machine]").count()).toBe(0);
      // Machine availability stays honest while panels are hidden.
      expect(await page.locator("[data-monitoring]").textContent()).toContain("3 Online");
      await page.screenshot({ path: `${artifacts}/01-empty-desktop.png` });

      await empty.getByRole("button", { name: "Open panel library" }).click();
      await library.waitFor();
      await page.screenshot({ path: `${artifacts}/02-empty-library-desktop.png` });
      await library.getByRole("button", { name: "Show all panels" }).click();
      await library.getByRole("button", { name: "Done" }).click();

      await expect.poll(() => page.locator("[data-monitoring-machine]").count()).toBe(3);
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(3);
      await page.screenshot({ path: `${artifacts}/03-restored-desktop.png` });
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
