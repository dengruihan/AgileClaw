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
          // Production rail writes carry the drawn column. Sample every write
          // with the transition state at that instant so a stale intermediate
          // value can never pass as a settle.
          const railWrites: Array<{ animating: boolean; at: number; value: string }> = [];
          const setStyleProperty = thread.style.setProperty.bind(thread.style);
          thread.style.setProperty = (
            property: string,
            value: string | null,
            priority?: string,
          ) => {
            if (property === "--chat-transcript-column-width") {
              railWrites.push({
                animating: railAnimating(),
                at: Math.round(performance.now()),
                value: value ?? "",
              });
            }
            setStyleProperty(property, value, priority);
          };
          // The composer popover anchor owns this var on the composer box; each
          // maintenance update is one box read of that element.
          const anchorElement = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
            (element) =>
              element.style.getPropertyValue("--chat-composer-popover-max-height") !== "",
          );
          const anchorReads: Array<{ animating: boolean; at: number; frame: number }> = [];
          // Frame identity: a read in a rendering frame's rAF or RO phase shares
          // this count, so duplicate reads in one frame are visible.
          let frameCount = 0;
          let trackFrames = true;
          const countFrame = () => {
            if (!trackFrames) {
              return;
            }
            frameCount += 1;
            requestAnimationFrame(countFrame);
          };
          requestAnimationFrame(countFrame);
          const anchorRect = anchorElement?.getBoundingClientRect.bind(anchorElement);
          if (anchorElement && anchorRect) {
            anchorElement.getBoundingClientRect = () => {
              anchorReads.push({
                animating: railAnimating(),
                at: Math.round(performance.now()),
                frame: frameCount,
              });
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
          trackFrames = false;
          const finalRail = railWidth();
          const finalColumn = inner.clientWidth;
          const finalColumnRect = inner.getBoundingClientRect().width;
          thread.style.setProperty = setStyleProperty;
          return {
            anchorFound: Boolean(anchorElement),
            anchorReads,
            endWidth: nav.getBoundingClientRect().width,
            expandFound,
            finalColumn,
            finalColumnRect,
            finalRail,
            midWidth,
            railWrites,
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
        // The settle performs one maintenance measurement in its own frame; the
        // deferred rail write restyles the subtree in the next frame, and the
        // composer's real ResizeObserver answers that layout with one further
        // read in a newer frame. Never two reads in one frame.
        const settleReads = result.anchorReads.filter((read) => !read.animating);
        const settleFrames = settleReads.map((read) => read.frame);
        expect(settleReads.length, JSON.stringify(result.anchorReads)).toBeGreaterThanOrEqual(1);
        expect(settleReads.length, JSON.stringify(result.anchorReads)).toBeLessThanOrEqual(2);
        expect(new Set(settleFrames).size, JSON.stringify(result.anchorReads)).toBe(
          settleReads.length,
        );
        for (let index = 1; index < settleFrames.length; index += 1) {
          expect(settleFrames[index] - settleFrames[index - 1]).toBeGreaterThanOrEqual(1);
        }
        // Rail writes are the production evidence: the eased widths must never
        // publish, and the settle must land exactly on the drawn column.
        expect(result.railWrites.length).toBeGreaterThan(0);
        expect(
          result.railWrites.filter((write) => write.animating),
          JSON.stringify(result.railWrites),
        ).toEqual([]);
        expect(result.finalRail).toBe(`${result.finalColumn}px`);
        // The drawn column can be fractional; the published integer width must
        // still round to it.
        expect(Math.abs(Number.parseFloat(result.finalRail) - result.finalColumnRect)).toBeLessThan(
          1,
        );
      },
    );
  });
});
