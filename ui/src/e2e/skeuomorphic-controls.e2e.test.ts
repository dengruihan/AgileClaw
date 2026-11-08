// Skeuomorphic shared controls: physical press, spring release, recessed
// fields, mechanical latches, and the draggable range fader — proven at the
// stylesheet boundary with the real CSS and on the running Appearance page.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI skeuomorphic shared controls",
  startServerBeforeBrowser: true,
});

function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/components.css",
    "ui/src/styles/settings-controls.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

const SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

type KeyPhysics = {
  transform: string;
  shadow: string;
  glossPosition: string;
  backgroundImage: string;
  transformDuration: string;
  transformTiming: string;
};

function readKeyPhysics(locator: Locator): Promise<KeyPhysics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(",").map((value) => value.trim());
    // A single computed duration/timing repeats across every property.
    const durations = style.transitionDuration.split(",").map((value) => value.trim());
    const timings = style.transitionTimingFunction.match(/cubic-bezier\([^)]+\)|[a-z-]+/gu) ?? [];
    const transformIndex = properties.indexOf("transform");
    const duration = durations.length === 1 ? durations[0] : durations[transformIndex];
    const timing = timings.length === 1 ? timings[0] : timings[transformIndex];
    return {
      transform: style.transform,
      shadow: style.boxShadow,
      glossPosition: style.backgroundPosition,
      backgroundImage: style.backgroundImage,
      transformDuration: duration ?? "none",
      transformTiming: timing ?? "none",
    } satisfies KeyPhysics;
  });
}

function transformY(transform: string): number {
  const match = /matrix\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([^)]+)\)/u.exec(transform);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

function fixtureDocument(theme: "dark" | "light"): string {
  return `<!doctype html><html data-theme="${theme === "light" ? "phosphor-light" : "phosphor"}" data-theme-mode="${theme}"><head><style>${readUiCss()}</style></head>
  <body><main style="padding: 24px; display: grid; gap: 20px; width: 420px">
    <button class="btn" type="button" id="key-neutral">Deploy agent</button>
    <button class="btn" type="button" id="key-disabled" disabled>Unavailable</button>
    <button class="btn btn--icon" type="button" id="key-icon" aria-label="Refresh"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg></button>
    <button class="btn btn--icon active" type="button" id="key-icon-latched" aria-label="Pinned"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/></svg></button>
    <button class="btn btn--icon" type="button" id="key-icon-disabled" disabled aria-label="Locked"><svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></button>
    <button class="btn btn--icon btn--ghost" type="button" id="key-icon-ghost" aria-label="More"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
    <label class="field"><span>Name</span><input type="text" id="well-input" value="phosphor" /></label>
    <label class="field checkbox"><input type="checkbox" id="latch" /><span>Auto-update</span></label>
    <label class="field checkbox"><input type="checkbox" id="latch-set" checked /><span>Telemetry</span></label>
    <label class="field checkbox"><input type="radio" id="dial" name="dial" checked /><span>Dark artwork</span></label>
    <label class="field"><span>Effort</span><input type="range" id="fader" min="0" max="100" value="45" /></label>
  </main></body></html>`;
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "shared keys travel, invert their shadow, and spring back in %s mode",
    { timeout: 60_000 },
    async (theme) => {
      await suite.withPage(
        { colorScheme: theme, locale: "en-US", viewport: { height: 800, width: 640 } },
        async ({ page }) => {
          await page.setContent(fixtureDocument(theme));
          const key = page.locator("#key-neutral");
          const resting = await readKeyPhysics(key);
          expect(resting.transform).toBe("none");
          // Resting keys extrude: a solid rim layer under the face plus the
          // inset bevel pair; the face itself is a gradient, never a flat fill.
          expect(resting.shadow).toContain("inset");
          expect(resting.shadow).toContain("0px 2px 0px 0px");
          expect(resting.backgroundImage).toContain("linear-gradient");
          expect(resting.glossPosition).toBe("0px 0px, 0px 0px");
          // Release settles on the shared spring, not a linear snap.
          expect(resting.transformTiming).toBe(SPRING);
          expect(resting.transformDuration).toBe("0.26s");

          await key.hover();
          await page.mouse.down();
          await settleFrames(page);
          const pressed = await readKeyPhysics(key);
          // The key physically travels down and the rim inverts into an inset
          // press shadow; the gloss leaves the top of the face.
          expect(transformY(pressed.transform)).toBeGreaterThanOrEqual(0.9);
          expect(pressed.shadow).toContain("inset");
          expect(pressed.shadow).not.toContain("0px 2px 0px 0px");
          expect(pressed.glossPosition).not.toBe(resting.glossPosition);
          // The press lands with the finger, not on the release curve.
          expect(pressed.transformDuration).toBe("0.04s");

          await page.mouse.up();
          await page.mouse.move(0, 0);
          await page.waitForTimeout(320);
          const released = await readKeyPhysics(key);
          expect(released.transform).toBe("none");
          expect(released.shadow).toContain("0px 2px 0px 0px");
          expect(released.glossPosition).toBe(resting.glossPosition);
        },
      );
    },
  );

  it(
    "reduced motion removes the spring without losing press states",
    { timeout: 60_000 },
    async () => {
      await suite.withPage(
        { colorScheme: "dark", locale: "en-US", viewport: { height: 800, width: 640 } },
        async ({ page }) => {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.setContent(fixtureDocument("dark"));
          const key = page.locator("#key-neutral");
          const resting = await readKeyPhysics(key);
          expect(resting.transformDuration).toBe("0s");

          await key.hover();
          await page.mouse.down();
          await settleFrames(page);
          const pressed = await readKeyPhysics(key);
          expect(transformY(pressed.transform)).toBeGreaterThanOrEqual(0.9);
          expect(pressed.shadow).toContain("inset");
          expect(pressed.shadow).not.toContain("0px 2px 0px 0px");
          await page.mouse.up();
          await settleFrames(page);
          expect((await readKeyPhysics(key)).transform).toBe("none");
        },
      );
    },
  );

  it("disabled keys stay settled under hover and press", { timeout: 60_000 }, async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { height: 800, width: 640 } },
      async ({ page }) => {
        await page.setContent(fixtureDocument("dark"));
        const key = page.locator("#key-disabled");
        const resting = await readKeyPhysics(key);
        expect(resting.shadow).toBe("none");
        await key.hover();
        await page.mouse.down();
        await settleFrames(page);
        expect(await readKeyPhysics(key)).toEqual(resting);
        await page.mouse.up();
      },
    );
  });

  it.each(["dark", "light"] as const)(
    "field inputs carve grooves and latched checks draw real check geometry in %s mode",
    {
      timeout: 60_000,
    },
    async (theme) => {
      await suite.withPage(
        {
          colorScheme: theme,
          deviceScaleFactor: 4,
          locale: "en-US",
          viewport: { height: 800, width: 640 },
        },
        async ({ page }) => {
          await page.setContent(fixtureDocument(theme));
          if (theme === "dark") {
            const well = page.locator("#well-input");
            const wellStyle = await well.evaluate((element) => {
              const style = getComputedStyle(element);
              return { shadow: style.boxShadow, image: style.backgroundImage };
            });
            expect(wellStyle.shadow).toContain("inset");
            expect(wellStyle.image).toContain("linear-gradient");

            const latch = page.locator("#latch");
            const latchRest = await readKeyPhysics(latch);
            expect(latchRest.transform).toBe("none");
            expect(latchRest.shadow).toContain("0px 2px 0px 0px");
            expect(await latch.evaluate((element) => getComputedStyle(element).appearance)).toBe(
              "none",
            );

            await latch.hover();
            await page.mouse.down();
            await settleFrames(page);
            const latchHeld = await readKeyPhysics(latch);
            expect(transformY(latchHeld.transform)).toBeGreaterThanOrEqual(0.9);
            expect(latchHeld.shadow).not.toContain("0px 2px 0px 0px");
            await page.mouse.up();
            await page.waitForTimeout(320);
          }

          const set = page.locator("#latch-set");
          const latched = await readKeyPhysics(set);
          // Latched-in keys sit in an accent-filled seat; in light mode the
          // field-wide neutral reset must not repaint the seat.
          expect(await set.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
            theme === "dark" ? "rgb(74, 222, 128)" : "rgb(16, 105, 58)",
          );
          expect(latched.shadow).toContain("inset");
          // The check is geometry, not a crossed X: two stroke tiles sized to
          // their own arms and meeting at the bottom-left vertex region.
          const checkGeometry = await set.evaluate((element) => {
            const style = getComputedStyle(element);
            return { sizes: style.backgroundSize, positions: style.backgroundPosition };
          });
          expect(checkGeometry.sizes).toContain("6px 6px");
          expect(checkGeometry.sizes).toContain("9px 9px");
          expect(checkGeometry.positions).toContain("1px 6px");
          expect(checkGeometry.positions).toContain("6px 3px");
          // Enlarged inspected render for visual review.
          await set.screenshot({
            path: `${suite.artifactDir}/latch-checked-enlarged-${theme}.png`,
          });

          const dial = page.locator("#dial");
          const dialImage = await dial.evaluate(
            (element) => getComputedStyle(element).backgroundImage,
          );
          // The accent dot paints above the opaque well floor: it must be the
          // first (topmost) background layer.
          expect(dialImage.indexOf("radial-gradient")).toBeLessThan(
            dialImage.indexOf("linear-gradient"),
          );
          await dial.screenshot({
            path: `${suite.artifactDir}/dial-checked-enlarged-${theme}.png`,
          });
        },
      );
    },
  );

  it(
    "keyboard focus keeps a visible ring on drawn latches and the fader",
    {
      timeout: 60_000,
    },
    async () => {
      await suite.withPage(
        { colorScheme: "dark", locale: "en-US", viewport: { height: 800, width: 640 } },
        async ({ page }) => {
          await page.setContent(fixtureDocument("dark"));
          // Mouse-focus the field, then walk forward by keyboard so the next
          // control earns :focus-visible.
          await page.locator("#well-input").click();
          for (const selector of ["#latch", "#latch-set", "#dial", "#fader"]) {
            await page.keyboard.press("Tab");
            const focus = await page.locator(selector).evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                focused: element.matches(":focus-visible"),
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
              };
            });
            expect(focus.focused, selector).toBe(true);
            expect(focus.outlineStyle, selector).toBe("solid");
            expect(focus.outlineWidth, selector).toBe("2px");
          }
          // The fader's focus location is the outline; the groove shading
          // stays without the text-field focus ring stacking on top.
          const faderFocusShadow = await page
            .locator("#fader")
            .evaluate((element) => getComputedStyle(element).boxShadow);
          expect(faderFocusShadow).toContain("inset");
          expect(faderFocusShadow).not.toContain("0px 0px 0px");
        },
      );
    },
  );

  it(
    "forced colors restore native latches with a visible focus outline",
    {
      timeout: 60_000,
    },
    async () => {
      await suite.withPage(
        {
          colorScheme: "dark",
          forcedColors: "active",
          locale: "en-US",
          viewport: { height: 800, width: 640 },
        },
        async ({ page }) => {
          await page.setContent(fixtureDocument("dark"));
          for (const selector of ["#latch", "#latch-set", "#dial"]) {
            const native = await page
              .locator(selector)
              .evaluate((element) => getComputedStyle(element).appearance);
            expect(native, selector).toBe("auto");
          }
          await page.locator("#well-input").click();
          await page.keyboard.press("Tab");
          const focus = await page.locator("#latch").evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              focused: element.matches(":focus-visible"),
              outlineStyle: style.outlineStyle,
              outlineWidth: style.outlineWidth,
            };
          });
          expect(focus.focused).toBe(true);
          expect(focus.outlineStyle).toBe("solid");
          expect(focus.outlineWidth).toBe("2px");
        },
      );
    },
  );

  it.each(["dark", "light"] as const)(
    "icon keys keep their press, latch, settle, and ghost states in %s mode",
    {
      timeout: 60_000,
    },
    async (theme) => {
      await suite.withPage(
        { colorScheme: theme, locale: "en-US", viewport: { height: 800, width: 640 } },
        async ({ page }) => {
          await page.setContent(fixtureDocument(theme));
          const icon = page.locator("#key-icon");
          const resting = await readKeyPhysics(icon);
          expect(resting.shadow).toContain("0px 2px 0px 0px");

          await icon.hover();
          await page.mouse.down();
          await settleFrames(page);
          const pressed = await readKeyPhysics(icon);
          expect(transformY(pressed.transform)).toBeGreaterThanOrEqual(0.9);
          expect(pressed.shadow).toContain("inset");
          expect(pressed.shadow).not.toContain("0px 2px 0px 0px");
          await page.mouse.up();
          await page.mouse.move(0, 0);
          await page.waitForTimeout(320);

          const latched = await readKeyPhysics(page.locator("#key-icon-latched"));
          expect(latched.shadow).toContain("inset");
          expect(latched.shadow).not.toContain("0px 2px 0px 0px");

          expect(
            await page
              .locator("#key-icon-disabled")
              .evaluate((element) => getComputedStyle(element).boxShadow),
          ).toBe("none");

          // The ghost icon keeps its whisper edge instead of the full icon
          // border: the two computed borders must differ.
          const borders = await page.evaluate(() => {
            const read = (selector: string) =>
              getComputedStyle(document.querySelector(selector)!).borderColor;
            return { ghost: read("#key-icon-ghost"), icon: read("#key-icon") };
          });
          expect(borders.ghost).not.toBe(borders.icon);
        },
      );
    },
  );

  it(
    "the shared range fader drags under the pointer, grabs, and answers keys",
    {
      timeout: 60_000,
    },
    async () => {
      await suite.withPage(
        { colorScheme: "dark", locale: "en-US", viewport: { height: 800, width: 640 } },
        async ({ page }) => {
          await page.setContent(fixtureDocument("dark"));
          const fader = page.locator("#fader");
          const box = await fader.boundingBox();
          expect(box).not.toBeNull();

          await page.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height / 2);
          await page.mouse.down();
          await settleFrames(page);
          const grabbedThumb = await fader.evaluate(
            (element) => getComputedStyle(element, "::-webkit-slider-thumb").boxShadow,
          );
          expect(grabbedThumb).toContain("inset");
          await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height / 2, { steps: 8 });
          await page.mouse.up();
          const dragged = Number(await fader.inputValue());
          expect(dragged).toBeGreaterThanOrEqual(75);

          await fader.focus();
          await page.keyboard.press("ArrowRight");
          expect(Number(await fader.inputValue())).toBe(dragged + 1);
          await page.keyboard.press("ArrowLeft");
          await page.keyboard.press("ArrowLeft");
          expect(Number(await fader.inputValue())).toBe(dragged - 1);
        },
      );
    },
  );

  it(
    "the appearance page ships physical shared keys and a mechanical switch",
    {
      timeout: 90_000,
    },
    async () => {
      await suite.withPage(
        { colorScheme: "dark", locale: "en-US", viewport: { height: 900, width: 1440 } },
        async ({ page }) => {
          const config = { ui: { prefs: { themeMode: "dark" } } };
          await installMockGateway(page, {
            methodResponses: {
              "config.get": {
                appliedConfigHash: "skeuomorphic-controls",
                config,
                configRevisionHash: "skeuomorphic-controls",
                hash: "skeuomorphic-controls",
                issues: [],
                raw: JSON.stringify(config),
                valid: true,
              },
            },
          });
          await page.goto(
            `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
          );
          await waitForControlUiSettingsTakeover(page);

          const managePlugins = page.locator(".btn", { hasText: "Manage plugins" }).first();
          await managePlugins.waitFor();
          const resting = await readKeyPhysics(managePlugins);
          expect(resting.shadow).toContain("0px 2px 0px 0px");
          expect(resting.transformTiming).toBe(SPRING);

          const collapseRow = page
            .locator(".settings-row")
            .filter({ hasText: "Collapse task progress by default" })
            .first();
          await collapseRow.waitFor();
          const switchEl = collapseRow.locator("wa-switch").first();
          await switchEl.waitFor();
          const lever = await switchEl.evaluate((element) => {
            const host = element as HTMLElement & { checked: boolean };
            const control = host.shadowRoot?.querySelector<HTMLElement>('[part="control"]');
            const thumb = host.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
            if (!control || !thumb) {
              throw new Error("Missing wa-switch lever parts");
            }
            const controlStyle = getComputedStyle(control);
            const thumbStyle = getComputedStyle(thumb);
            return {
              channelShadow: controlStyle.boxShadow,
              channelImage: controlStyle.backgroundImage,
              thumbShadow: thumbStyle.boxShadow,
              thumbTiming: thumbStyle.transitionTimingFunction,
            };
          });
          // The track reads as a machined channel and the cap rides proud of it.
          expect(lever.channelShadow).toContain("inset");
          expect(lever.channelImage).toContain("linear-gradient");
          expect(lever.thumbShadow).toContain("0px 2px 0px 0px");
          // The throw snaps on the shared spring.
          expect(lever.thumbTiming).toContain(SPRING);

          // Holding the lever dimples the cap into its channel: the resting rim
          // collapses into the shared pressed shadow while the host is :active.
          // The settings takeover auto-scrolls to the anchored section, so the
          // row is scrolled into view and given a beat to settle before the
          // coordinate press measures its box.
          await collapseRow.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          const switchBox = await switchEl.boundingBox();
          expect(switchBox).not.toBeNull();
          await page.mouse.move(
            switchBox!.x + switchBox!.width / 2,
            switchBox!.y + switchBox!.height / 2,
          );
          await page.mouse.down();
          await settleFrames(page);
          const heldCap = await switchEl.evaluate((element) => {
            const host = element as HTMLElement;
            const thumb = host.shadowRoot?.querySelector<HTMLElement>('[part="thumb"]');
            if (!thumb) {
              throw new Error("Missing wa-switch lever cap");
            }
            return {
              active: host.matches(":active"),
              shadow: getComputedStyle(thumb).boxShadow,
            };
          });
          expect(heldCap.active).toBe(true);
          expect(heldCap.shadow).toContain("inset");
          expect(heldCap.shadow).not.toContain("0px 2px 0px 0px");
          await page.mouse.up();
          await page.mouse.move(0, 0);

          const beforeThrow = await switchEl.evaluate(
            (element) => (element as HTMLElement & { checked: boolean }).checked,
          );
          await switchEl.click();
          await expect
            .poll(() =>
              switchEl.evaluate(
                (element) => (element as HTMLElement & { checked: boolean }).checked,
              ),
            )
            .toBe(!beforeThrow);
        },
      );
    },
  );
});
