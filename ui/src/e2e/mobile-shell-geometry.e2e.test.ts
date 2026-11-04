import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile shell geometry" });

async function activateStandaloneStyles(page: Page, largeUnitDifference = 0) {
  // Fault injection, not an iPhone measurement: CSS viewport units may exceed
  // the native-scale visible viewport even when layoutHeight == visualHeight.
  // The previous short-layout fixture assumed the extra lvh region was visible;
  // neither viewport API (nor a physical screen size) establishes that premise.
  await page.evaluate(async (difference) => {
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          rule.media.mediaText = rule.conditionText.replaceAll(
            "(display-mode: standalone)",
            "(min-width: 0px)",
          );
        }
        if (difference && rule instanceof CSSStyleRule) {
          const base = rule.style.getPropertyValue("--shell-viewport-base");
          if (base === "100lvh" || base === "100dvh") {
            rule.style.setProperty(
              "--shell-viewport-base",
              "calc(" + base + " + " + difference + "px)",
            );
          }
        }
        if (rule instanceof CSSGroupingRule) {
          visit(rule.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      visit(sheet.cssRules);
    }
    window.dispatchEvent(new Event("resize"));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, largeUnitDifference);
}

async function geometry(page: Page) {
  await waitForLayoutSettled(page, ".shell, .agent-chat__composer-shell");
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    return {
      shell: rect(".shell")!,
      body: rect("body")!,
      composer: rect(".agent-chat__composer-shell")!,
      thread: rect(".chat-thread-inner"),
      footer: rect(".chat-footer"),
      context: rect(".chat-footer__context"),
      progress: rect(".session-progress-card--composer"),
      header: rect(".chat-pane__header"),
      scrollWidth: document.documentElement.scrollWidth,
      layoutHeight: document.documentElement.clientHeight,
      visualHeight: window.visualViewport?.height,
      canvas: getComputedStyle(document.documentElement).getPropertyValue("--shell-canvas-height"),
    };
  });
}

suite.define(() => {
  it.each([false, true])(
    "keeps a shorter CSS canvas without promoting lvh (VisualViewport missing: %s)",
    async (missing) => {
      await suite.withPage(
        { viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true },
        async ({ page }) => {
          if (missing) {
            await page.addInitScript(() =>
              Object.defineProperty(window, "visualViewport", {
                value: undefined,
                configurable: true,
              }),
            );
          }
          await installMockGateway(page);
          await page.goto(suite.server.baseUrl + "new");
          await expect(page.locator(".new-session-page__message")).toBeVisible();
          await activateStandaloneStyles(page);
          await page.evaluate(() => {
            const visit = (rules: CSSRuleList) => {
              for (const rule of rules) {
                if (rule instanceof CSSStyleRule) {
                  const base = rule.style.getPropertyValue("--shell-viewport-base");
                  if (base === "100dvh") {
                    rule.style.setProperty("--shell-viewport-base", "calc(100dvh - 62px)");
                  }
                  if (base === "100lvh") {
                    rule.style.setProperty("--shell-viewport-base", "calc(100lvh + 62px)");
                  }
                }
                if (rule instanceof CSSGroupingRule) {
                  visit(rule.cssRules);
                }
              }
            };
            for (const sheet of document.styleSheets) {
              visit(sheet.cssRules);
            }
            window.dispatchEvent(new Event("resize"));
          });
          const frame = await geometry(page);
          expect(frame.shell.bottom).toBe(812);
          expect(frame.composer.bottom).toBeLessThanOrEqual(812);
        },
      );
    },
  );
});
