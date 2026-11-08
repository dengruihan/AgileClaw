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
  name: "Dashboards skeuomorphic drawer mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

const DRAWER_WIDTH_PX = 440;
const VIEWPORT_WIDTH_PX = 1440;
const OPEN_DRAWER_X_PX = VIEWPORT_WIDTH_PX - DRAWER_WIDTH_PX;

const environments = {
  environments: [
    { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
    { id: "worker-one", type: "worker", label: "Cloud worker", status: "available" },
  ],
};

function installDrawerGateway(
  page: Page,
  sessions: ControlUiSessionFixture[] = [
    createControlUiSessionRow("agent:main:dashboard-proof", "Release health", 10),
    createControlUiSessionRow("agent:main:dashboard-second", "Cost monitor", 5),
  ],
) {
  return installMockGateway(page, {
    sessions,
    featureMethods: ["board.get", "environments.list", "node.list", "system.info"],
    methodResponses: {
      "board.get": { revision: 1, sessionKey: "agent:main:dashboard-proof", tabs: [], widgets: [] },
      "environments.list": environments,
      "node.list": { nodes: [] },
      "system.info": {
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
      },
    },
  });
}

async function openDashboards(page: Page) {
  await page.goto(`${suite.server.baseUrl}dashboards`);
  await page.locator(".dashboards-gallery [data-dashboard-session]").first().waitFor();
}

type TriggerDrag = { beforeTabX: number; x: number; y: number };

async function beginTriggerDrag(page: Page, rawPull: number, steps = 8): Promise<TriggerDrag> {
  const trigger = page.locator("[data-marketplace-trigger]");
  const box = (await trigger.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - rawPull, y, { steps });
  return { beforeTabX: box.x, x, y };
}

/**
 * A deliberate pull: CDP batches `steps` moves as fast as the page allows, so
 * paced moves are the only way to stay under the flick threshold everywhere.
 */
async function beginSlowTriggerPull(page: Page, rawPull: number, stepCount = 4) {
  const trigger = page.locator("[data-marketplace-trigger]");
  const box = (await trigger.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const stepPx = rawPull / stepCount;
  for (let step = 1; step <= stepCount; step += 1) {
    await page.mouse.move(x - stepPx * step, y);
    await page.waitForTimeout(40);
  }
  return { beforeTabX: box.x };
}

/** Drag-follow must never push the page past its viewport width. */
async function expectNoHorizontalOverflow(page: Page) {
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
}

const modalDrawer = (page: Page) => page.locator("openclaw-modal-dialog [data-marketplace]");
const previewDrawer = (page: Page) => page.locator("[data-marketplace-preview] [data-marketplace]");

/** Ordinary motion animates the modal landing; wait it out before geometry. */
async function waitForSettledOpen(page: Page) {
  await expect
    .poll(async () => (await modalDrawer(page).boundingBox())?.x ?? -1, { timeout: 3_000 })
    .toBeCloseTo(OPEN_DRAWER_X_PX, 0);
}

/**
 * The close verdict animates through the panel's real 240ms transition, and
 * that curve is too fast to race with CDP round trips. Freeze it at a fixed
 * mid-flight sample instead: the re-grab then lands on a deterministic
 * intermediate position with a stationary handle. Cancelling the frozen
 * animation afterwards hands the transform back to the drag's own paint (or,
 * after a rejection, to the real settle-back transition).
 */
async function freezeMidSettleClose(page: Page, sampleMs: number) {
  await page.evaluate((sample) => {
    const panel = document.querySelector("openclaw-modal-dialog [data-marketplace]");
    for (const animation of panel?.getAnimations() ?? []) {
      animation.pause();
      animation.currentTime = sample;
    }
  }, sampleMs);
}

async function unfreezePanelAnimations(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector("openclaw-modal-dialog [data-marketplace]");
    for (const animation of panel?.getAnimations() ?? []) {
      animation.cancel();
    }
  });
}

suite.define(() => {
  it("follows an opening drag with the drawer itself, then drags it shut to the right", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-skeuomorphic-open");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installDrawerGateway(page);
      await openDashboards(page);
      const trigger = page.locator("[data-marketplace-trigger]");

      // The tab is anchored to the viewport's right edge.
      const tabBox = await trigger.boundingBox();
      expect(tabBox!.x + tabBox!.width).toBeGreaterThanOrEqual(VIEWPORT_WIDTH_PX - 1);

      // The tower slice: pull 80px and the drawer itself is partially out with
      // displacement matching the gesture (catch, then 1:1).
      const { beforeTabX } = await beginTriggerDrag(page, 80, 10);
      const preview = previewDrawer(page);
      await preview.waitFor();
      const previewBox = await preview.boundingBox();
      expect(VIEWPORT_WIDTH_PX - previewBox!.x).toBeCloseTo(75, 1);
      // The tab's own travel is damped past its free travel: it moves less
      // than the pointer.
      const tabNow = await trigger.boundingBox();
      expect(beforeTabX - tabNow!.x).toBeGreaterThan(50);
      expect(beforeTabX - tabNow!.x).toBeLessThan(80);
      await expect.poll(() => trigger.getAttribute("data-armed")).not.toBeNull();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `${artifacts}/01-preview-partially-open.png` });

      // The transient preview is inert: every control inside it sits in an
      // inert subtree the keyboard can never reach.
      expect(
        await page.evaluate(() => {
          const preview = document.querySelector("[data-marketplace-preview]");
          return (
            preview?.hasAttribute("inert") === true &&
            Array.from(preview?.querySelectorAll("button") ?? []).every(
              (button) => button.closest("[inert]") !== null,
            )
          );
        }),
      ).toBe(true);
      // Pressing Tab mid-gesture moves focus off the capture target, which
      // safely resets the gesture; focus never enters the preview copy.
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.closest("[data-marketplace-preview]") === null,
          ),
        )
        .toBe(true);
      await expect.poll(() => previewDrawer(page).count()).toBe(0);
      await expect.poll(() => modalDrawer(page).count()).toBe(0);

      // Pull again to complete the slice: release snaps the drawer into the
      // modal owner's open state.
      await beginTriggerDrag(page, 80, 10);
      await page.mouse.up();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await expect.poll(() => previewDrawer(page).count()).toBe(0);
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(async () => (await drawer.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(OPEN_DRAWER_X_PX, 1);
      await page.screenshot({ path: `${artifacts}/02-open-desktop.png` });

      // The primary close control keeps its raised material at rest.
      const handle = page.locator("[data-marketplace-handle]");
      const restingShadow = await handle.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(restingShadow).not.toBe("none");
      expect(restingShadow).not.toContain("inset");
      const handleBox = (await handle.boundingBox())!;
      const y = handleBox.y + handleBox.height / 2;
      await page.mouse.move(handleBox.x + handleBox.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 160, y, { steps: 6 });
      const closing = await drawer.boundingBox();
      expect(closing!.x - OPEN_DRAWER_X_PX).toBeCloseTo(160, 1);
      // While held, the handle flips into the pressed (inset) surface.
      const draggingShadow = await handle.evaluate((el) => getComputedStyle(el).boxShadow);
      expect(draggingShadow).toContain("inset");
      await page.screenshot({ path: `${artifacts}/03-closing-mid-drag.png` });

      // Past half travel it snaps shut and unmounts.
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 300, y, { steps: 6 });
      await page.mouse.up();
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await expect
        .poll(() => page.locator("[data-marketplace-trigger]").getAttribute("aria-expanded"))
        .toBe("false");
      await expectNoHorizontalOverflow(page);

      // Pulling the drawer never reads machine inventory on its own.
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("springs a short pull shut without opening and opens on a fast flick", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-skeuomorphic-flick");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      const trigger = page.locator("[data-marketplace-trigger]");

      // Below the open threshold the drawer preview appears but springs fully
      // shut on release; the trailing click is not an activation.
      const { beforeTabX } = await beginSlowTriggerPull(page, 24);
      const preview = previewDrawer(page);
      await preview.waitFor();
      await page.mouse.up();
      await expect.poll(() => previewDrawer(page).count()).toBe(0);
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await expect
        .poll(async () => (await trigger.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(beforeTabX, 1);
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");

      // A fast leftward flick opens even though the pull stays under threshold:
      // one large move is dispatched in a single frame, well over flick speed.
      const box = (await trigger.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 30, y);
      await page.mouse.up();
      await modalDrawer(page).waitFor();
      await page.screenshot({ path: `${artifacts}/01-flick-opened.png` });
    } finally {
      await context.close();
    }
  });

  it("ignores a flick whose speed has aged out by a deliberate release", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      const trigger = page.locator("[data-marketplace-trigger]");

      // Open direction: one fast frame under the position latch, then a held
      // pause long enough to age the sample out, then release.
      const tabBox = await trigger.boundingBox();
      const x = tabBox!.x + tabBox!.width / 2;
      const y = tabBox!.y + tabBox!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 30, y);
      await page.waitForTimeout(320);
      await page.mouse.up();
      await expect.poll(() => previewDrawer(page).count()).toBe(0);
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");

      // Close direction: the same aged-out flick on the edge handle must not
      // close the open drawer.
      await trigger.click();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      const handle = page.locator("[data-marketplace-handle]");
      const handleBox = (await handle.boundingBox())!;
      const handleY = handleBox.y + handleBox.height / 2;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleY);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 30, handleY);
      await page.waitForTimeout(320);
      await page.mouse.up();
      await expect
        .poll(async () => (await drawer.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(OPEN_DRAWER_X_PX, 1);
      expect(await modalDrawer(page).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("re-grabs a mid-settle close from its live animated position without a jump", async () => {
    // Ordinary motion: the close settle really animates, so the re-grab has
    // to measure the panel's intermediate transition frame, not a settled one.
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      await page.locator("[data-marketplace-trigger]").click();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await waitForSettledOpen(page);
      const handle = page.locator("[data-marketplace-handle]");

      // Push past half travel and release: with motion enabled the close
      // verdict animates the remaining distance instead of landing at once.
      const handleBox = (await handle.boundingBox())!;
      const y = handleBox.y + handleBox.height / 2;
      await page.mouse.move(handleBox.x + handleBox.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 300, y, { steps: 10 });
      await page.mouse.up();

      // Re-grab mid-settle: freeze the real transition at a 30ms sample and
      // lock onto the stationary handle with a leftward move. Holding sets
      // data-dragging, whose zero-duration transition then owns the paint.
      await freezeMidSettleClose(page, 30);
      const liveHandle = (await handle.boundingBox())!;
      await page.mouse.move(liveHandle.x + liveHandle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(liveHandle.x + liveHandle.width / 2 - 40, y);
      const heldDuration = await drawer.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      );
      expect(heldDuration).toBe("0s");
      await unfreezePanelAnimations(page);
      const held = (await drawer.boundingBox())!.x;
      // The lock measured the frozen mid-transition shift and followed it:
      // the panel sits 40px left of that sampled frame — not restarted from
      // zero (which paints ~990) and not settled at the closed home.
      expect(held).toBeGreaterThan(OPEN_DRAWER_X_PX + 200);
      expect(held).toBeLessThan(VIEWPORT_WIDTH_PX - 40);
      // With the settle frozen, further deltas track exactly 1:1.
      await page.mouse.move(liveHandle.x + liveHandle.width / 2 - 70, y);
      expect((await drawer.boundingBox())!.x).toBeCloseTo(held - 30, 0);
      // The re-grab cancelled the pending close: the modal never unmounted.
      expect(await modalDrawer(page).count()).toBe(1);

      // The re-grabbed session still owns its verdict: past half, it closes.
      await page.mouse.move(liveHandle.x + liveHandle.width / 2 + 340, y, { steps: 8 });
      await page.mouse.up();
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("springs a vertically rejected close re-grab back open instead of stranding the modal", async () => {
    // Ordinary motion: the rejection lands while the close verdict is still
    // animating, which is the state whose cancelled settle used to strand the
    // open marketplace entirely off-screen.
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      await page.locator("[data-marketplace-trigger]").click();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await waitForSettledOpen(page);
      const handle = page.locator("[data-marketplace-handle]");

      // Start a close and release past half travel.
      const handleBox = (await handle.boundingBox())!;
      const y = handleBox.y + handleBox.height / 2;
      await page.mouse.move(handleBox.x + handleBox.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 350, y, { steps: 10 });
      await page.mouse.up();

      // Re-grab mid-settle and change direction to a mostly vertical move:
      // that is not a pull, so the drawer must spring back open with the
      // marketplace still mounted and expanded — never stranded off-screen
      // with its panel translated past the viewport edge. The freeze parks
      // the settle at a 30ms sample so the grab lands on the real handle.
      await freezeMidSettleClose(page, 30);
      const liveHandle = (await handle.boundingBox())!;
      const grabX = (await drawer.boundingBox())!.x;
      expect(grabX).toBeGreaterThan(OPEN_DRAWER_X_PX + 352);
      expect(grabX).toBeLessThan(VIEWPORT_WIDTH_PX - 2);
      await page.mouse.move(liveHandle.x + liveHandle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(liveHandle.x + liveHandle.width / 2, y + 30);
      // The rejection restored the open settle: let it run for real.
      await unfreezePanelAnimations(page);
      await page.mouse.up();

      await expect
        .poll(async () => (await drawer.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(OPEN_DRAWER_X_PX, 0);
      await expect.poll(() => modalDrawer(page).count()).toBe(1);
      await expect
        .poll(() => page.locator("[data-marketplace-trigger]").getAttribute("aria-expanded"))
        .toBe("true");
      await expectNoHorizontalOverflow(page);

      // Past the settle window the marketplace is still open and usable:
      // the drawer sits at its open home and Escape closes it through the
      // modal owner.
      await page.waitForTimeout(600);
      expect(await modalDrawer(page).count()).toBe(1);
      expect((await drawer.boundingBox())!.x).toBeCloseTo(OPEN_DRAWER_X_PX, 0);
      await page.keyboard.press("Escape");
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("resists a reverse drag on the open drawer and springs back open", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      await page.locator("[data-marketplace-trigger]").click();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      const handle = page.locator("[data-marketplace-handle]");

      // Dragging left (away from the drawer's right-edge home) only ratchets a
      // little; releasing springs the drawer back open.
      const handleBox = (await handle.boundingBox())!;
      const y = handleBox.y + handleBox.height / 2;
      await page.mouse.move(handleBox.x + handleBox.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, y, { steps: 6 });
      const reverse = await drawer.boundingBox();
      expect(OPEN_DRAWER_X_PX - reverse!.x).toBeGreaterThanOrEqual(8);
      expect(OPEN_DRAWER_X_PX - reverse!.x).toBeLessThanOrEqual(30);
      await page.mouse.up();
      await expect
        .poll(async () => (await drawer.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(OPEN_DRAWER_X_PX, 1);
      expect(await modalDrawer(page).count()).toBe(1);

      // A rightward flick on the handle closes it: one large move in a single
      // frame carries enough speed on its own.
      const handleAgain = (await handle.boundingBox())!;
      await page.mouse.move(handleAgain.x + handleAgain.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handleAgain.x + handleAgain.width / 2 + 30, y);
      await page.mouse.up();
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps keyboard activation, Escape focus return, and the handle's close action", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);
      const trigger = page.locator("[data-marketplace-trigger]");

      await trigger.focus();
      await page.keyboard.press("Enter");
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      // The modal's autofocus lands on the pull handle, the close affordance.
      const handle = page.locator("[data-marketplace-handle]");
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.hasAttribute("data-marketplace-handle") ?? false,
          ),
        )
        .toBe(true);

      // Escape closes through the modal owner and returns focus to the tab.
      await page.keyboard.press("Escape");
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.hasAttribute("data-marketplace-trigger") ?? false,
          ),
        )
        .toBe(true);

      // Space activates like Enter, and the handle closes on keyboard click.
      await trigger.focus();
      await page.keyboard.press("Space");
      await drawer.waitFor();
      await handle.focus();
      await handle.press("Enter");
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("preserves install, persistence, and zero-RPC semantics through the pull-tab drawer", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-skeuomorphic-install");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      const gateway = await installDrawerGateway(page);
      await openDashboards(page);

      // Drag open, install, then push the drawer shut with the handle.
      await beginTriggerDrag(page, 96);
      await page.mouse.up();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await drawer.locator("[data-marketplace-add]").click();
      const monitoring = page.locator("[data-monitoring]");
      await monitoring.getByText("Gateway machine", { exact: true }).waitFor();
      expect(await monitoring.locator("[data-monitoring-machine]").count()).toBe(2);
      const handle = page.locator("[data-marketplace-handle]");
      const handleBox = (await handle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 10);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 320, handleBox.y + 10, {
        steps: 10,
      });
      await page.mouse.up();
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await page.screenshot({ path: `${artifacts}/01-installed-after-handle-close.png` });

      // The install persists per Gateway origin and still uninstalls cleanly.
      await page.reload();
      await monitoring.getByText("Gateway machine", { exact: true }).waitFor();
      expect(
        await page.locator('[data-monitoring-machine="gateway"] openclaw-sparkline').count(),
      ).toBe(3);
      await page.screenshot({ path: `${artifacts}/02-installed-after-reload.png` });
      await page.locator("[data-marketplace-trigger]").click();
      await page.locator("[data-marketplace] [data-marketplace-remove]").click();
      await expect.poll(() => page.locator("[data-monitoring]").count()).toBe(0);
      expect(await gateway.getRequests("backup.status")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("keeps the pull tab usable at narrow widths with no horizontal overflow", async () => {
    const artifacts = createControlUiE2eArtifactDir("dashboards-skeuomorphic-narrow");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 800 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page, [createControlUiSessionRow("agent:main:one", "One", 3)]);
      await openDashboards(page);
      await expectNoHorizontalOverflow(page);

      await beginTriggerDrag(page, 96);
      await page.mouse.up();
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      const drawerBox = await drawer.boundingBox();
      expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
      expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(375);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `${artifacts}/01-narrow-drag-opened.png` });

      // The tucked-in handle still pushes the full-bleed drawer shut.
      const handle = page.locator("[data-marketplace-handle]");
      const handleBox = (await handle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 10);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + 340, handleBox.y + 10, {
        steps: 12,
      });
      await page.mouse.up();
      await expect.poll(() => modalDrawer(page).count()).toBe(0);
      await expectNoHorizontalOverflow(page);
    } finally {
      await context.close();
    }
  });

  it("runs the spring transitions when motion is allowed and keeps follow direct", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: VIEWPORT_WIDTH_PX, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installDrawerGateway(page);
      await openDashboards(page);

      // While held, the drawer follows directly: its transform transition is
      // suppressed so displacement is exactly the gesture's.
      await beginTriggerDrag(page, 96, 12);
      const preview = previewDrawer(page);
      await preview.waitFor();
      const draggingDuration = await preview.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      );
      expect(draggingDuration).toBe("0s");
      const previewBox = await preview.boundingBox();
      expect(VIEWPORT_WIDTH_PX - previewBox!.x).toBeCloseTo(91, 1);
      await page.mouse.up();

      // The settle hands off to the modal: the landing panel waits behind the
      // preview, then appears settled open with its spring transition armed.
      const drawer = modalDrawer(page);
      await drawer.waitFor();
      await expect.poll(() => previewDrawer(page).count()).toBe(0);
      const settleDuration = await drawer.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      );
      expect(settleDuration).toBe("0.24s");
      await expect
        .poll(async () => (await drawer.boundingBox())!.x, { timeout: 3_000 })
        .toBeCloseTo(OPEN_DRAWER_X_PX, 1);
    } finally {
      await context.close();
    }
  });
});
