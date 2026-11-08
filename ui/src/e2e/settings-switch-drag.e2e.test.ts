import type { Locator } from "playwright";
// Control UI dragged-switch proof through the mocked Gateway: a real mouse
// must move the lever thumb while held, snap to the dragged pole exactly once,
// keep click parity, and never leak the release click into the row's toggle
// handler. Screenshots land in the task-owned e2e artifact directory.
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings switch drag mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

type ThumbGeometry = {
  thumbCenterX: number;
  trackCenterX: number;
  travelHalf: number;
};

async function thumbGeometry(switchElement: Locator): Promise<ThumbGeometry> {
  return switchElement.evaluate((element) => {
    const read = (part: string) => {
      const node = (element as HTMLElement).shadowRoot?.querySelector<HTMLElement>(
        `[part~="${part}"]`,
      );
      if (!node) {
        throw new Error(`wa-switch is missing its ${part} part`);
      }
      return node.getBoundingClientRect();
    };
    const thumb = read("thumb");
    const control = read("control");
    const thumbCenterX = thumb.left + thumb.width / 2;
    const trackCenterX = control.left + control.width / 2;
    return { thumbCenterX, trackCenterX, travelHalf: Math.abs(thumbCenterX - trackCenterX) };
  });
}

async function rowBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) {
    throw new Error("settings toggle row is not visible");
  }
  return box;
}

suite.define(() => {
  it("drags the settings switch between poles without double commits", async () => {
    const artifactDir = createControlUiE2eArtifactDir("settings-switch-drag");
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const config = { browser: { enabled: true } };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "hash-1",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(
        new URL("settings/security", suite.server.baseUrl).toString(),
      );
      expect(response?.status()).toBe(200);
      const row = page.locator(".settings-row--toggle", { hasText: "Browser enabled" }).first();
      const switchElement = row.locator("wa-switch");
      const switchRole = switchElement.getByRole("switch");
      await switchRole.waitFor();
      expect(await switchRole.getAttribute("aria-checked")).toBe("true");

      // Count change events reaching the document so a double toggle or a
      // suppressed-click leak cannot hide behind the optimistic UI.
      const changes = async () =>
        page.evaluate(() => {
          const recorded = (window as unknown as { switchDragChanges?: boolean[] })
            .switchDragChanges;
          return recorded ? [...recorded] : [];
        });
      await page.evaluate(() => {
        (window as unknown as { switchDragChanges: boolean[] }).switchDragChanges = [];
        document.addEventListener(
          "change",
          (event) => {
            const target = event.target as Element | null;
            if (target?.localName === "wa-switch") {
              (window as unknown as { switchDragChanges: boolean[] }).switchDragChanges.push(
                (target as HTMLElement & { checked: boolean }).checked,
              );
            }
          },
          true,
        );
      });

      const start = await thumbGeometry(switchElement);
      expect(start.thumbCenterX).toBeGreaterThan(start.trackCenterX);
      await row.screenshot({ animations: "disabled", path: `${artifactDir}/01-rest-on.png` });

      // Drag the lever left across its full travel: the thumb must follow the
      // pointer while held, then snap onto the off pole with one change.
      const rowGeometry = await rowBox(row);
      const centerY = rowGeometry.y + rowGeometry.height / 2;
      await page.mouse.move(start.thumbCenterX, centerY);
      await page.mouse.down();
      const halfwayX = start.trackCenterX - start.travelHalf * 0.5;
      await page.mouse.move(halfwayX, centerY, { steps: 4 });
      const tracking = await thumbGeometry(switchElement);
      expect(tracking.thumbCenterX).toBeLessThan(start.thumbCenterX - 2);
      expect(Math.abs(tracking.thumbCenterX - halfwayX)).toBeLessThan(start.travelHalf);
      await row.screenshot({ path: `${artifactDir}/02-mid-drag-following.png` });
      await page.mouse.move(start.trackCenterX - start.travelHalf * 1.5, centerY, { steps: 2 });
      await page.mouse.up();
      expect(await switchRole.getAttribute("aria-checked")).toBe("false");
      expect(await changes()).toEqual([false]);
      await expect
        .poll(async () => (await thumbGeometry(switchElement)).thumbCenterX)
        .toBeLessThan(start.trackCenterX - start.travelHalf + 1);
      await row.screenshot({ animations: "disabled", path: `${artifactDir}/03-snap-off.png` });

      // Releasing over the row text (outside the switch) must not turn the
      // pointerup into a second row toggle: capture retargets the click to the
      // switch, where the drag adapter absorbs it, and the gesture itself
      // commits nothing because the lever is already at the dragged pole.
      const off = await thumbGeometry(switchElement);
      await page.mouse.move(off.thumbCenterX, centerY);
      await page.mouse.down();
      await page.mouse.move(rowGeometry.x + 40, centerY, { steps: 4 });
      await page.mouse.up();
      expect(await switchRole.getAttribute("aria-checked")).toBe("false");
      expect(await changes()).toEqual([false]);
      // The row handler's patch would flip the optimistic value within a tick;
      // give it that window before trusting the absence.
      await page.waitForTimeout(300);
      expect(await switchRole.getAttribute("aria-checked")).toBe("false");
      expect(await changes()).toEqual([false]);

      // A real tap (press and release without travel) still toggles once.
      const on = await thumbGeometry(switchElement);
      await page.mouse.move(on.thumbCenterX, centerY);
      await page.mouse.down();
      await page.mouse.up();
      expect(await switchRole.getAttribute("aria-checked")).toBe("true");
      expect(await changes()).toEqual([false, true]);

      // Keyboard stays native: arrows move the committed pole, one change each.
      await switchElement.evaluate((element) => (element as HTMLElement).focus());
      await page.keyboard.press("ArrowLeft");
      expect(await switchRole.getAttribute("aria-checked")).toBe("false");
      expect(await changes()).toEqual([false, true, false]);
      await page.keyboard.press("ArrowRight");
      expect(await switchRole.getAttribute("aria-checked")).toBe("true");
      expect(await changes()).toEqual([false, true, false, true]);
    } finally {
      await context.close();
    }
  });

  it("snaps instantly with restored inline styles under reduced motion", async () => {
    const artifactDir = createControlUiE2eArtifactDir("settings-switch-drag");
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const config = { browser: { enabled: true } };
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config,
          hash: "hash-1",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
      },
    });

    try {
      const response = await page.goto(
        new URL("settings/security", suite.server.baseUrl).toString(),
      );
      expect(response?.status()).toBe(200);
      const row = page.locator(".settings-row--toggle", { hasText: "Browser enabled" }).first();
      const switchElement = row.locator("wa-switch");
      const switchRole = switchElement.getByRole("switch");
      await switchRole.waitFor();

      const start = await thumbGeometry(switchElement);
      const rowGeometry = await rowBox(row);
      const centerY = rowGeometry.y + rowGeometry.height / 2;
      await page.mouse.move(start.thumbCenterX, centerY);
      await page.mouse.down();
      await page.mouse.move(start.trackCenterX - start.travelHalf * 1.5, centerY, { steps: 3 });
      await page.mouse.up();
      expect(await switchRole.getAttribute("aria-checked")).toBe("false");
      await expect
        .poll(async () => (await thumbGeometry(switchElement)).thumbCenterX)
        .toBeLessThan(start.trackCenterX);
      // The adapter drops its parked inline override on the next animation
      // frame; poll instead of racing that frame.
      const readThumbStyles = () =>
        switchElement.evaluate((element) => {
          const thumb = (element as HTMLElement).shadowRoot!.querySelector<HTMLElement>(
            '[part~="thumb"]',
          )!;
          return { translate: thumb.style.translate, transition: thumb.style.transition };
        });
      await expect.poll(readThumbStyles).toEqual({ translate: "", transition: "" });
      await row.screenshot({ path: `${artifactDir}/04-reduced-motion-snap-off.png` });
    } finally {
      await context.close();
    }
  });
});
