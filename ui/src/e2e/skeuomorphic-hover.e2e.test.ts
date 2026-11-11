// Raised-key hover contract: the new-session key is the reference. Hover
// retints the contour and face and leaves the resting rim, contact, and layout
// box alone; only :active extrudes into the press shadow and travels
// --press-shift. A hover that grows the rim or contact is what made every key
// read as inflating, so that is the regression this suite owns.
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  fixtureDocument,
  readKeyPhysics,
  settleFrames,
  transformY,
} from "./skeuomorphic-controls.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI raised-key hover",
  startServerBeforeBrowser: true,
});

type HoverCase = {
  selector: string;
  label: string;
  /** Reveal a hover-only key by hovering its row first. */
  reveal?: string;
  /** A latched key keeps its seated accent tint under the pointer. */
  latchedTint?: boolean;
  /** Latched keys stay in the pressed seat while hovered. */
  seated?: boolean;
  presses?: boolean;
};

// Every raised family the shared material covers, held to the reference's
// contract.
const cases: HoverCase[] = [
  { selector: "#reference-new-session", label: "new-session reference", presses: true },
  { selector: "#key-neutral", label: "plain button", presses: true },
  { selector: "#key-primary", label: "primary button", presses: true },
  { selector: "#key-icon", label: "icon button", presses: true },
  { selector: "#key-icon-latched", label: "latched icon button", seated: true },
  { selector: "#rail-nav", label: "rail nav key", presses: true },
  { selector: "#rail-collapse", label: "rail icon key", presses: true },
  { selector: "#rail-inbox", label: "inbox key", presses: true },
  { selector: "#rail-identity", label: "identity key", presses: true },
  {
    selector: "#rail-session-action",
    label: "session action key",
    reveal: "#rail-session",
    presses: true,
  },
  { selector: "#choice-plain", label: "option-card choice", presses: true },
  {
    selector: "#choice-selected",
    label: "latched option-card choice",
    latchedTint: true,
    seated: true,
  },
];

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "hover retints raised keys without extruding them in %s mode",
    { timeout: 90_000 },
    async (theme) => {
      await suite.withPage(
        // Tall viewport: the fixture loads the real base.css, whose html/body
        // clip forbids document scrolling, so every fixture row must fit the
        // first paint.
        { colorScheme: theme, locale: "en-US", viewport: { height: 2200, width: 640 } },
        async ({ page }) => {
          await page.setContent(fixtureDocument(theme));

          const readSurface = (selector: string) =>
            page.locator(selector).evaluate((element) => {
              const box = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                height: box.height,
                width: box.width,
                x: box.x,
                y: box.y,
                face: style.backgroundColor,
              };
            });
          const place = ({ width, height, x, y }: { [key: string]: number }) => [
            width,
            height,
            x,
            y,
          ];

          // Keyboard focus owns the ring and never restyles the material. It
          // runs before any pointer interaction: Tab continues from the
          // browser's last interaction point, so a fresh page is the only state
          // where the first stop is the fixture's first key.
          await page.keyboard.press("Tab");
          const focusState = await page.evaluate(() => {
            const active = document.activeElement;
            if (!(active instanceof Element)) {
              throw new Error("no element holds keyboard focus");
            }
            const style = getComputedStyle(active);
            return {
              focusedId: active.id,
              focusVisible: active.matches(":focus-visible"),
              outline: `${style.outlineStyle} ${style.outlineWidth}`,
              transform: style.transform,
            };
          });
          expect(focusState.focusedId).toBe("key-neutral");
          expect(focusState.focusVisible).toBe(true);
          expect(focusState.outline).toBe("solid 2px");
          expect(focusState.transform).toBe("none");
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
          });

          for (const hoverCase of cases) {
            const key = page.locator(hoverCase.selector);
            if (hoverCase.reveal) {
              // The key lives inside the row it belongs to, so hovering the
              // row reveals it and the key stays hoverable on the way in.
              await page.locator(hoverCase.reveal).hover();
            } else {
              await page.mouse.move(0, 0);
            }
            await settleFrames(page);
            const rest = await readKeyPhysics(key);
            const restBox = await readSurface(hoverCase.selector);

            await key.hover();
            await settleFrames(page);
            const hovered = await readKeyPhysics(key);
            const hoveredBox = await readSurface(hoverCase.selector);
            expect(hovered.shadow, `${hoverCase.label} keeps its resting material on hover`).toBe(
              rest.shadow,
            );
            expect(hovered.transform, `${hoverCase.label} does not travel on hover`).toBe("none");
            expect(place(hoveredBox), `${hoverCase.label} keeps its layout box on hover`).toEqual(
              place(restBox),
            );
            if (hoverCase.seated) {
              expect(hovered.shadow, `${hoverCase.label} stays seated`).toContain("inset");
            }
            if (hoverCase.latchedTint) {
              expect(hoveredBox.face, `${hoverCase.label} keeps its seated tint`).toBe(
                restBox.face,
              );
            } else {
              expect(hoveredBox.face, `${hoverCase.label} still retints`).not.toBe(restBox.face);
            }

            if (!hoverCase.presses) {
              continue;
            }
            await page.mouse.down();
            // The press lands in the fast frame and stays down while held.
            await expect
              .poll(async () => transformY((await readKeyPhysics(key)).transform), {
                timeout: 3_000,
              })
              .toBeGreaterThanOrEqual(0.9);
            const pressed = await readKeyPhysics(key);
            expect(pressed.shadow, `${hoverCase.label} presses in`).toContain("inset");
            expect(pressed.shadow).not.toBe(rest.shadow);
            expect(pressed.transformDuration).toBe("0.04s");
            await page.mouse.up();
            await page.mouse.move(0, 0);
            // Releasing springs back to the resting material, untransformed.
            await expect
              .poll(
                async () => {
                  const released = await readKeyPhysics(key);
                  return `${released.transform}|${released.shadow}`;
                },
                { timeout: 3_000 },
              )
              .toBe(`none|${rest.shadow}`);
          }
        },
      );
    },
  );

  it.each(["dark", "light"] as const)(
    "reduced motion keeps the hover retint off the material in %s mode",
    { timeout: 60_000 },
    async (theme) => {
      await suite.withPage(
        { colorScheme: theme, locale: "en-US", viewport: { height: 2200, width: 640 } },
        async ({ page }) => {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.setContent(fixtureDocument(theme));
          // The retint still lands instantly with every transition dropped, and
          // it still may not touch the material.
          for (const selector of ["#reference-new-session", "#key-neutral", "#key-primary"]) {
            const key = page.locator(selector);
            const resting = await readKeyPhysics(key);
            await key.hover();
            expect((await readKeyPhysics(key)).shadow, selector).toBe(resting.shadow);
            await page.mouse.move(0, 0);
          }
        },
      );
    },
  );

  it("touch taps leave no hover material or travel behind", { timeout: 60_000 }, async () => {
    const touch = {
      colorScheme: "dark",
      hasTouch: true,
      viewport: { height: 1600, width: 640 },
    } as const;
    await suite.withPage(touch, async ({ page }) => {
      await page.setContent(fixtureDocument("dark"));
      // The served build media-wraps every :hover rule behind (hover: hover), so
      // touch never reaches them. This fixture keeps the raw cascade on purpose:
      // a tap that leaves a sticky :hover behind must still find no material
      // change or travel to latch.
      for (const selector of ["#key-neutral", "#key-primary", "#rail-nav"]) {
        const key = page.locator(selector);
        const resting = await readKeyPhysics(key);
        await key.tap();
        const settled = () => readKeyPhysics(key).then((s) => `${s.transform}|${s.shadow}`);
        await expect.poll(settled, { timeout: 3_000 }).toBe(`none|${resting.shadow}`);
      }
    });
  });
});
