import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Navigation rail reversal contract: a cancel followed by the replacement run is
// ONE bounded motion window. Maintenance measurement (composer popover anchor,
// transcript rail vars) must not read the eased intermediate geometry, and the
// final settle reconciles exactly once.
const suite = createControlUiE2eSuite({
  name: "Control UI shell motion navigation reversal",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const SESSION_KEY = "agent:main:main";

async function openMockedChat(page: Page): Promise<void> {
  await installMockGateway(page, {
    historyMessages: Array.from({ length: 10 }, (_value, index) => ({
      content: [
        {
          type: "text",
          text: `Turn ${index}: review transcript text designed to wrap when the navigation changes.`,
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: Date.now() - (10 - index) * 60_000,
    })),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
  await waitForControlUiGatewayReady(page);
  await page.locator(".chat-thread").waitFor();
  await page.locator(".shell").evaluate(async (shell) => {
    const animations = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

suite.define(() => {
  it("keeps one motion window across a keyboard nav reversal", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1000 } },
      async ({ page }) => {
        await openMockedChat(page);
        const result = await page.evaluate(async () => {
          const nav = document.querySelector<HTMLElement>(".shell-nav")!;
          const thread = document.querySelector<HTMLElement>(".chat-thread")!;
          const inner = thread.querySelector<HTMLElement>(".chat-thread-inner")!;
          const railAnimating = () =>
            nav
              .getAnimations()
              .some(
                (animation) =>
                  animation instanceof CSSTransition &&
                  animation.transitionProperty === "width" &&
                  animation.playState === "running",
              );
          const railWidth = () => thread.style.getPropertyValue("--chat-transcript-column-width");
          // The composer popover anchor owns this var on the composer box; its
          // maintenance update is one box read of that element.
          const anchorElement = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
            (element) =>
              element.style.getPropertyValue("--chat-composer-popover-max-height") !== "",
          );
          const anchorReads: Array<{ animating: boolean }> = [];
          const anchorRect = anchorElement?.getBoundingClientRect.bind(anchorElement);
          if (anchorElement && anchorRect) {
            anchorElement.getBoundingClientRect = () => {
              anchorReads.push({ animating: railAnimating() });
              return anchorRect();
            };
          }
          const anchorHeight = () =>
            anchorElement?.style.getPropertyValue("--chat-composer-popover-max-height") ?? "";
          // The same controls the reader (or Mod+B) drives; a direct click keeps
          // the reversal inside the 200ms transition instead of waiting for
          // Playwright actionability.
          const collapseControl = () =>
            document.querySelector<HTMLElement>(".sidebar-brand__collapse");
          const expandControl = () =>
            document.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle");
          const nextFrame = () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });

          const startWidth = nav.getBoundingClientRect().width;
          const startAnchor = anchorHeight();
          const startRail = railWidth();
          const samples: Array<{
            anchor: string;
            animating: boolean;
            rail: string;
            width: number;
          }> = [];
          const sample = () =>
            samples.push({
              anchor: anchorHeight(),
              animating: railAnimating(),
              rail: railWidth(),
              width: Math.round(nav.getBoundingClientRect().width),
            });
          sample();
          collapseControl()!.click();
          let midWidth = startWidth;
          for (let frame = 0; frame < 8; frame += 1) {
            await nextFrame();
            sample();
            midWidth = Math.min(midWidth, nav.getBoundingClientRect().width);
            // Reverse once the rail is visibly mid-collapse, the RO has delivered
            // the intermediate geometry, and the expand control exists.
            if (
              midWidth < startWidth - 1 &&
              expandControl() &&
              samples.some((entry) => entry.animating && entry.rail !== startRail)
            ) {
              break;
            }
            if (midWidth < startWidth - 1 && expandControl() && frame >= 3) {
              break;
            }
          }
          const expandFound = Boolean(expandControl());
          expandControl()?.click();
          for (let pass = 0; pass < 12 && railAnimating(); pass += 1) {
            await nextFrame();
            sample();
          }
          await nextFrame();
          sample();
          await nextFrame();
          sample();
          if (anchorElement && anchorRect) {
            anchorElement.getBoundingClientRect = anchorRect;
          }
          return {
            anchorFound: Boolean(anchorElement),
            anchorReads,
            endWidth: nav.getBoundingClientRect().width,
            expandFound,
            innerWidth: inner.clientWidth,
            midWidth,
            samples,
            startAnchor,
            startRail,
            startWidth,
          };
        });
        // The gesture really reversed mid-flight and returned to its start.
        expect(result.expandFound).toBe(true);
        expect(result.midWidth).toBeLessThan(result.startWidth - 1);
        expect(result.endWidth).toBeCloseTo(result.startWidth, 0);
        // No maintenance read of the composer anchor landed while the rail was
        // animating: the old cancel published a false settle between cancel and
        // its replacement, which flushed the owed anchor measurement mid-gesture.
        expect(result.anchorFound).toBe(true);
        expect(
          result.anchorReads.filter((read) => read.animating),
          JSON.stringify(result.anchorReads),
        ).toEqual([]);
        // The single settle reconciled afterwards and left the rail on drawn geometry.
        expect(result.anchorReads.length).toBeGreaterThan(0);
        expect(
          Math.abs(Number.parseFloat(result.samples.at(-1)?.rail ?? "") - result.innerWidth),
        ).toBeLessThanOrEqual(1);
      },
    );
  });
});
