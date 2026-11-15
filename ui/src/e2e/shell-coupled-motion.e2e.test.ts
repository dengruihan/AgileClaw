import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI shell coupled motion",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const SESSION_KEY = "agent:main:main";
const COLLAPSE_BUTTON = ".sidebar-brand__collapse";
const EXPAND_BUTTON = ".shell-chrome-controls__nav-toggle";

const TRANSCRIPT_TEXT = "review transcript text designed to wrap when the navigation changes";

function history() {
  return Array.from({ length: 10 }, (_value, index) => ({
    content: [
      {
        type: "text",
        text: `Turn ${index}: ${TRANSCRIPT_TEXT} the available content width.`,
      },
    ],
    role: index % 2 === 0 ? "user" : "assistant",
    timestamp: Date.now() - (10 - index) * 60_000,
  }));
}

async function openMockedChat(
  page: Page,
  terminalDock: "bottom" | "right" = "bottom",
): Promise<void> {
  await page.addInitScript((dock) => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock, height: 240, width: 600 }),
    );
  }, terminalDock);
  await installMockGateway(page, {
    featureMethods: ["terminal.open"],
    historyMessages: history(),
    methodResponses: {
      "terminal.list": { sessions: [] },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/workspace/openclaw",
        sessionId: "coupled-motion",
        shell: "/bin/bash",
      },
    },
    terminalEnabled: true,
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
  await waitForControlUiGatewayReady(page);
  await page.locator(".chat-thread").waitFor();
  await waitForShellLayout(page);
}

// Boot and dock changes reshape the plate over their own short ease; settle
// that before recording the geometry baseline the motion must return to.
async function waitForShellLayout(page: Page): Promise<void> {
  await page.locator(".shell").evaluate(async (shell) => {
    const finite = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finite.map((animation) => animation.finished));
  });
}

async function openTerminalPanel(page: Page, dock: "bottom" | "right"): Promise<void> {
  await waitForControlUiTerminalReady(page);
  await page
    .locator(`openclaw-terminal-panel .tp--${dock}`)
    .waitFor({ state: "visible", timeout: 15_000 });
  await waitForShellLayout(page);
}

type SurfaceRect = { left: number; top: number; width: number; height: number };

type ShellMotionSample = {
  collapsed: boolean;
  gridFirstTrack: string;
  navVisibility: string;
  navInlineStyle: string;
  navTranslateX: number;
  contentOpacity: number;
  contentTranslateX: number;
  contentRect: SurfaceRect;
  composer: SurfaceRect | null;
  thread: SurfaceRect | null;
  terminal: {
    className: string;
    opacity: number;
    translateX: number;
    rect: SurfaceRect;
    animations: string[];
  } | null;
  animations: string[];
};

async function readShellMotion(page: Page): Promise<ShellMotionSample> {
  return page.evaluate(() => {
    const rect = (element: Element | null | undefined): SurfaceRect | null => {
      const box = element?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
    };
    const shell = document.querySelector<HTMLElement>(".shell");
    const nav = document.querySelector<HTMLElement>(".shell-nav");
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    if (!shell || !nav || !content) {
      throw new Error("Missing shell motion surface");
    }
    const translateX = (element: HTMLElement) => {
      const transform = getComputedStyle(element).transform;
      return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
    };
    const motionAnimations = (element: HTMLElement) =>
      element
        .getAnimations()
        .map((animation) => animation.id)
        .filter((id) => id.startsWith("shell-nav-"));
    const terminal = content.ownerDocument
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const terminalStyle = terminal ? getComputedStyle(terminal) : null;
    return {
      collapsed: shell.classList.contains("shell--nav-collapsed"),
      gridFirstTrack: getComputedStyle(shell).gridTemplateColumns.split(" ")[0] ?? "",
      navVisibility: getComputedStyle(nav).visibility,
      navInlineStyle: nav.getAttribute("style") ?? "",
      navTranslateX: translateX(nav),
      contentOpacity: Number.parseFloat(getComputedStyle(content).opacity),
      contentTranslateX: translateX(content),
      contentRect: rect(content)!,
      composer: rect(document.querySelector(".agent-chat__input")),
      thread: rect(document.querySelector(".chat-thread")),
      terminal:
        terminal && terminalStyle
          ? {
              className: terminal.className,
              opacity: Number.parseFloat(terminalStyle.opacity),
              translateX: translateX(terminal),
              rect: rect(terminal)!,
              animations: motionAnimations(terminal),
            }
          : null,
      animations: motionAnimations(nav).concat(motionAnimations(content)),
    };
  });
}

/**
 * Deterministic motion probe: pause every live-DOM motion effect on the rail,
 * the content column and the moving dock, then seek all of them to the same
 * fraction of their own clock and read the painted frame.
 */
async function holdShellMotion(page: Page, id: string, fraction: number): Promise<number> {
  return page.evaluate(
    ({ id: motionId, fraction: seekAt }) => {
      const content = document.querySelector<HTMLElement>("#control-ui-main");
      const nav = document.querySelector<HTMLElement>(".shell-nav");
      const terminal = document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp");
      const elements = [content, nav, terminal].filter(
        (element): element is HTMLElement => element !== null && element !== undefined,
      );
      const animations = elements
        .flatMap((element) => element.getAnimations())
        .filter((animation) => animation.id === motionId || animation.id === "shell-nav-slide");
      for (const animation of animations) {
        const endTime = animation.effect?.getComputedTiming().endTime ?? 0;
        animation.pause();
        animation.currentTime = endTime * seekAt;
      }
      return animations.length;
    },
    { fraction, id },
  );
}

async function finishMotionEffect(page: Page, id: string): Promise<number> {
  return page.evaluate((motionId) => {
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    const terminal = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const animations = [content, terminal]
      .filter((element): element is HTMLElement => element !== null && element !== undefined)
      .flatMap((element) => element.getAnimations())
      .filter((animation) => animation.id === motionId);
    for (const animation of animations) {
      animation.finish();
    }
    return animations.length;
  }, id);
}

async function resumeShellMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    const nav = document.querySelector<HTMLElement>(".shell-nav");
    const terminal = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    for (const element of [content, nav, terminal]) {
      for (const animation of element?.getAnimations() ?? []) {
        if (animation.id.startsWith("shell-nav-") && animation.playState === "paused") {
          animation.play();
        }
      }
    }
  });
}

async function waitForMotionEffect(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((motionId) => {
        const content = document.querySelector<HTMLElement>("#control-ui-main");
        return content?.getAnimations().some((animation) => animation.id === motionId) ?? false;
      }, id),
    )
    .toBe(true);
}

async function waitForMotionSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>(".shell-nav");
        if (!nav) {
          return false;
        }
        const running = document
          .getAnimations()
          .some((animation) => animation.id.startsWith("shell-nav-"));
        return !running && !nav.getAttribute("style");
      }),
    )
    .toBe(true);
}

async function expandNav(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+b");
}

type ContentPaint = {
  opacity: number;
  translateX: number;
  animations: string[];
  navInlineStyle: string;
  collapsed: boolean;
  pathname: string;
};

async function readContentPaint(page: Page): Promise<ContentPaint> {
  return page.evaluate(() => {
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    const nav = document.querySelector<HTMLElement>(".shell-nav");
    if (!content || !nav) {
      throw new Error("Missing shell motion surface");
    }
    const transform = getComputedStyle(content).transform;
    return {
      opacity: Number.parseFloat(getComputedStyle(content).opacity),
      translateX: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41,
      animations: [...document.getAnimations()]
        .map((animation) => animation.id)
        .filter((id) => id.startsWith("shell-nav-")),
      navInlineStyle: nav.getAttribute("style") ?? "",
      collapsed:
        document.querySelector(".shell")?.classList.contains("shell--nav-collapsed") ?? false,
      pathname: location.pathname,
    };
  });
}

/** Holds the column fade while leaving the rail at its resting position. */
async function holdColumnFade(page: Page, id: string, fraction: number): Promise<void> {
  await page.evaluate(
    ({ id: motionId, fraction: seekAt }) => {
      const content = document.querySelector<HTMLElement>("#control-ui-main");
      const terminal = document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp");
      for (const element of [content, terminal]) {
        for (const animation of element?.getAnimations() ?? []) {
          if (animation.id !== motionId) {
            continue;
          }
          const endTime = animation.effect?.getComputedTiming().endTime ?? 0;
          animation.pause();
          animation.currentTime = endTime * seekAt;
        }
      }
      for (const animation of document.querySelector(".shell-nav")?.getAnimations() ?? []) {
        if (animation.id === "shell-nav-slide") {
          animation.pause();
          animation.currentTime = 0;
        }
      }
    },
    { fraction, id },
  );
}

async function navigateNative(page: Page, target: string): Promise<void> {
  await page.evaluate((path) => {
    window.dispatchEvent(new CustomEvent("openclaw:native-navigate", { detail: { path } }));
  }, target);
}

type MotionSubscriptionCounts = { created: number; removed: number; active: number };

/** Counts real router subscriptions created and released by the motion owner. */
async function instrumentMotionSubscriptions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector("openclaw-app-shell") as
      | (HTMLElement & {
          runtime?: {
            router?: { subscribeSelector: (...args: never[]) => () => boolean };
          };
        })
      | null;
    const router = shell?.runtime?.router;
    if (!router) {
      throw new Error("App router unavailable");
    }
    const original = router.subscribeSelector.bind(router);
    const counts = { created: 0, removed: 0, active: 0 };
    Reflect.set(window, "motionSubscriptionsProbe", () => ({ ...counts }));
    router.subscribeSelector = (...args: never[]) => {
      counts.created += 1;
      counts.active += 1;
      const unsubscribe = original(...args);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          counts.removed += 1;
          counts.active -= 1;
        }
        return unsubscribe();
      };
    };
  });
}

async function readMotionSubscriptions(page: Page): Promise<MotionSubscriptionCounts> {
  return page.evaluate(() =>
    (
      window as unknown as { motionSubscriptionsProbe: () => MotionSubscriptionCounts }
    ).motionSubscriptionsProbe(),
  );
}

async function dragSelectTranscript(page: Page): Promise<string> {
  const target = page.locator(".chat-group").last();
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const y = box.y + Math.min(24, box.height / 2);
  await page.mouse.move(box.x + 6, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 6, 220), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

suite.define(() => {
  it("fades the chat column and the moving dock through one nav relayout in both directions", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await openTerminalPanel(page, "bottom");
        const expanded = await readShellMotion(page);
        expect(expanded.collapsed).toBe(false);
        expect(expanded.contentOpacity).toBe(1);
        expect(expanded.contentTranslateX).toBe(0);
        expect(expanded.terminal?.className).toContain("tp--bottom");
        const expandedTrack = expanded.gridFirstTrack;

        // Collapse, phase A: the outgoing column fades and travels in its old
        // layout while the rail slides; the navigation state has not applied.
        await page.locator(COLLAPSE_BUTTON).click();
        expect(await holdShellMotion(page, "shell-nav-out", 0.5)).toBeGreaterThanOrEqual(5);
        const midOut = await readShellMotion(page);
        expect(midOut.collapsed).toBe(false);
        expect(midOut.gridFirstTrack).toBe(expandedTrack);
        expect(midOut.contentOpacity).toBeGreaterThan(0);
        expect(midOut.contentOpacity).toBeLessThan(1);
        expect(midOut.contentTranslateX).toBeLessThan(-20);
        expect(midOut.navTranslateX).toBeLessThan(-20);
        expect(midOut.navVisibility).toBe("visible");
        expect(
          Math.abs(midOut.composer!.left - expanded.composer!.left - midOut.contentTranslateX),
        ).toBeLessThan(1);
        expect(midOut.terminal!.opacity).toBeLessThan(1);
        expect(midOut.terminal!.translateX).toBeLessThan(-20);
        // Only compositor properties ride the per-frame path; a layout property
        // here would relayout the populated shell every frame.
        const animatedProperties = await page.evaluate(() =>
          [
            ...new Set(
              [...document.getAnimations()]
                .filter((animation) => animation.id.startsWith("shell-nav-"))
                .flatMap((animation) => animation.effect?.getKeyframes() ?? [])
                .flatMap((keyframe) => Object.keys(keyframe))
                .filter(
                  (property) =>
                    !["offset", "computedOffset", "easing", "composite"].includes(property),
                ),
            ),
          ].toSorted(),
        );
        expect(animatedProperties).toEqual(["opacity", "transform"]);

        // Phase B: the relayout has applied and the new column fades back in
        // while it finishes the translation.
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        expect(await holdShellMotion(page, "shell-nav-in", 0.5)).toBeGreaterThanOrEqual(5);
        const midIn = await readShellMotion(page);
        expect(midIn.collapsed).toBe(true);
        expect(midIn.gridFirstTrack).toBe("0px");
        expect(midIn.contentOpacity).toBeGreaterThan(0);
        expect(midIn.contentOpacity).toBeLessThan(1);
        expect(midIn.contentTranslateX).toBeGreaterThan(0);
        expect(midIn.terminal!.opacity).toBeLessThan(1);
        expect(midIn.terminal!.translateX).toBeGreaterThan(0);

        // Natural finish leaves no held animation, no inline navigation style,
        // and the settled collapsed geometry main produces.
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        const collapsed = await readShellMotion(page);
        expect(collapsed.collapsed).toBe(true);
        expect(collapsed.contentOpacity).toBe(1);
        expect(collapsed.contentTranslateX).toBe(0);
        expect(collapsed.terminal!.opacity).toBe(1);
        expect(collapsed.terminal!.translateX).toBe(0);
        expect(collapsed.navVisibility).toBe("hidden");
        expect(collapsed.navInlineStyle).toBe("");
        expect(collapsed.gridFirstTrack).toBe("0px");
        expect(collapsed.terminal!.rect.left).toBe(0);
        expect(collapsed.terminal!.rect.width).toBe(1440);
        expect(collapsed.contentRect.width).toBeGreaterThan(expanded.contentRect.width);

        // Expand mirrors the same contract.
        await page.locator(EXPAND_BUTTON).click();
        expect(await holdShellMotion(page, "shell-nav-out", 0.5)).toBeGreaterThanOrEqual(5);
        const expandOut = await readShellMotion(page);
        expect(expandOut.collapsed).toBe(true);
        expect(expandOut.gridFirstTrack).toBe("0px");
        expect(expandOut.contentOpacity).toBeLessThan(1);
        expect(expandOut.contentTranslateX).toBeGreaterThan(20);
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await holdShellMotion(page, "shell-nav-in", 0.5);
        const expandIn = await readShellMotion(page);
        expect(expandIn.collapsed).toBe(false);
        expect(expandIn.gridFirstTrack).toBe(expandedTrack);
        expect(expandIn.contentTranslateX).toBeLessThan(0);
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        const reexpanded = await readShellMotion(page);
        expect(reexpanded.collapsed).toBe(false);
        expect(reexpanded.contentOpacity).toBe(1);
        expect(reexpanded.contentTranslateX).toBe(0);
        expect(reexpanded.navVisibility).toBe("visible");
        expect(reexpanded.navInlineStyle).toBe("");
        expect(reexpanded.contentRect).toEqual(expanded.contentRect);
        expect(reexpanded.terminal!.rect).toEqual(expanded.terminal!.rect);
      },
    );
  });

  it("retargets a rapid reversal from the current motion before and after the relayout", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        const expanded = await readShellMotion(page);

        // Before the relayout the layout still matches the original state, so a
        // reversal only has to return the visuals: no second state change.
        await page.locator(COLLAPSE_BUTTON).click();
        await holdShellMotion(page, "shell-nav-out", 0.4);
        await expandNav(page);
        await waitForMotionEffect(page, "shell-nav-return");
        await resumeShellMotion(page);
        await waitForMotionSettled(page);
        const returned = await readShellMotion(page);
        expect(returned.collapsed).toBe(false);
        expect(returned.contentOpacity).toBe(1);
        expect(returned.contentTranslateX).toBe(0);
        expect(returned.navVisibility).toBe("visible");

        // After the relayout the reversal fades the current surface out from
        // where it is, restores the other layout while it is invisible, then
        // fades back in from the same screen position.
        await page.locator(COLLAPSE_BUTTON).click();
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await holdShellMotion(page, "shell-nav-in", 0.5);
        const reversedFrom = await readShellMotion(page);
        expect(reversedFrom.collapsed).toBe(true);
        await expandNav(page);
        await waitForMotionEffect(page, "shell-nav-out");
        await holdShellMotion(page, "shell-nav-out", 0.5);
        const reversing = await readShellMotion(page);
        expect(reversing.collapsed).toBe(true);
        expect(reversing.contentOpacity).toBeLessThan(reversedFrom.contentOpacity);
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        expect((await readShellMotion(page)).collapsed).toBe(false);
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        const restored = await readShellMotion(page);
        expect(restored.collapsed).toBe(false);
        expect(restored.contentOpacity).toBe(1);
        expect(restored.contentTranslateX).toBe(0);
        expect(restored.navInlineStyle).toBe("");
        expect(restored.contentRect).toEqual(expanded.contentRect);
      },
    );
  });

  it("keeps native typing, selection, and wheel scrolling live during the fade", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await page.locator(COLLAPSE_BUTTON).click();
        await holdShellMotion(page, "shell-nav-out", 0.5);

        const thread = page.locator(".chat-thread");
        const scrollBefore = await thread.evaluate((element) => {
          element.scrollTop = 0;
          return element.scrollTop;
        });
        const threadBox = (await thread.boundingBox())!;
        await page.mouse.move(
          threadBox.x + threadBox.width / 2,
          threadBox.y + threadBox.height / 2,
        );
        await page.mouse.wheel(0, 400);
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(scrollBefore);

        const composer = page.locator(".agent-chat__input textarea");
        const composerBox = (await composer.boundingBox())!;
        await page.mouse.click(composerBox.x + 40, composerBox.y + composerBox.height / 2);
        await page.keyboard.type("typed during the fade");
        await expect.poll(() => composer.inputValue()).toBe("typed during the fade");
        expect(await page.evaluate(() => document.activeElement?.tagName ?? "")).toBe("TEXTAREA");

        const selection = await dragSelectTranscript(page);
        expect(selection.length).toBeGreaterThan(0);

        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        const settled = await readShellMotion(page);
        expect(settled.collapsed).toBe(true);
        expect(await composer.inputValue()).toBe("typed during the fade");
        expect(await thread.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        // The settling focus rescue must not pull focus out of the page a user
        // interacted with during the fade.
        expect(
          await page.evaluate(
            () =>
              document.activeElement?.classList.contains("shell-chrome-controls__nav-toggle") ??
              false,
          ),
        ).toBe(false);
      },
    );
  });

  it("drops a held fade-out before an in-app SPA navigation paints the new route", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await page.locator(COLLAPSE_BUTTON).click();
        // Hold the outgoing column at 50% while the rail stays home, so the
        // sidebar link is a real click target at its resting position.
        await holdColumnFade(page, "shell-nav-out", 0.5);
        expect((await readContentPaint(page)).opacity).toBeLessThan(1);

        await page.locator('openclaw-app-sidebar a[href*="dashboards"]').first().click();
        await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/dashboards");
        const paint = await readContentPaint(page);
        // The routed surface swapped while the fade was held: the pending
        // navigation state settles and the new route paints at rest.
        expect(paint.animations).toEqual([]);
        expect(paint.opacity).toBe(1);
        expect(paint.translateX).toBe(0);
        expect(paint.navInlineStyle).toBe("");
        expect(paint.collapsed).toBe(true);
        expect(
          await page.evaluate(
            () => (document.querySelector("#control-ui-main")?.textContent ?? "").trim().length > 0,
          ),
        ).toBe(true);
      },
    );
  });

  it("drops a held reveal before a native SPA navigation paints the new route", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await page.locator(COLLAPSE_BUTTON).click();
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await holdColumnFade(page, "shell-nav-in", 0.5);
        expect((await readContentPaint(page)).opacity).toBeLessThan(1);

        await navigateNative(page, "/activity");
        await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/activity");
        const paint = await readContentPaint(page);
        expect(paint.animations).toEqual([]);
        expect(paint.opacity).toBe(1);
        expect(paint.translateX).toBe(0);
        expect(paint.navInlineStyle).toBe("");
        expect(paint.collapsed).toBe(true);
        expect(
          await page.evaluate(
            () => (document.querySelector("#control-ui-main")?.textContent ?? "").trim().length > 0,
          ),
        ).toBe(true);
      },
    );
  });

  it("releases every route subscription after reversals, finishes, navigation and disconnect", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await instrumentMotionSubscriptions(page);
        expect(await readMotionSubscriptions(page)).toEqual({ created: 0, removed: 0, active: 0 });

        // Natural finish in both directions.
        await page.locator(COLLAPSE_BUTTON).click();
        expect((await readMotionSubscriptions(page)).active).toBe(1);
        await waitForMotionSettled(page);
        expect((await readMotionSubscriptions(page)).active).toBe(0);
        await page.locator(EXPAND_BUTTON).click();
        await waitForMotionSettled(page);
        expect((await readMotionSubscriptions(page)).active).toBe(0);

        // Phase-A reversal: the superseded motion must not keep its listener.
        await page.locator(COLLAPSE_BUTTON).click();
        await holdColumnFade(page, "shell-nav-out", 0.4);
        await page.keyboard.press("ControlOrMeta+b");
        await waitForMotionSettled(page);
        expect((await readMotionSubscriptions(page)).active).toBe(0);

        // Phase-B reversal supersedes the running reveal.
        await page.locator(COLLAPSE_BUTTON).click();
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await holdColumnFade(page, "shell-nav-in", 0.5);
        await page.keyboard.press("ControlOrMeta+b");
        await waitForMotionEffect(page, "shell-nav-out");
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        expect((await readMotionSubscriptions(page)).active).toBe(0);

        // Route settlement releases the subscription before the next paint.
        await page.locator(COLLAPSE_BUTTON).click();
        await holdColumnFade(page, "shell-nav-out", 0.5);
        await navigateNative(page, "/activity");
        await expect.poll(() => page.evaluate(() => location.pathname)).toBe("/activity");
        expect((await readMotionSubscriptions(page)).active).toBe(0);

        // Shell disconnect cancels an in-flight motion and its subscription.
        await page.locator(EXPAND_BUTTON).click();
        expect((await readMotionSubscriptions(page)).active).toBe(1);
        await page.evaluate(() => document.querySelector("openclaw-app-shell")?.remove());
        await expect.poll(() => readMotionSubscriptions(page)).toMatchObject({ active: 0 });
        const final = await readMotionSubscriptions(page);
        expect(final.created).toBe(final.removed);
        expect(final.created).toBeGreaterThan(4);
      },
    );
  });

  it("snaps without motion under reduced motion and honors a custom rail width", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedChat(page);
        await page.locator(COLLAPSE_BUTTON).click();
        await page.locator(".shell--nav-collapsed").waitFor();
        // The instant path restores focus only after the collapsed chrome has
        // rendered; it must land on the expand button, not the content fallback.
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.classList.contains("shell-chrome-controls__nav-toggle") ??
                false,
            ),
          )
          .toBe(true);
        const collapsed = await readShellMotion(page);
        expect(collapsed.animations).toEqual([]);
        expect(collapsed.contentOpacity).toBe(1);
        expect(collapsed.contentTranslateX).toBe(0);
        expect(collapsed.gridFirstTrack).toBe("0px");
        await page.locator(EXPAND_BUTTON).click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(0);
        expect((await readShellMotion(page)).contentTranslateX).toBe(0);
      },
    );

    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openMockedChat(page);
        await page.evaluate(
          ({ key }) => localStorage.setItem(key, JSON.stringify({ navWidth: 320 })),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        await page.reload();
        await page.locator(".chat-thread").waitFor();
        const expanded = await readShellMotion(page);
        expect(expanded.gridFirstTrack).toBe("320px");
        await page.locator(COLLAPSE_BUTTON).click();
        await holdShellMotion(page, "shell-nav-out", 0.5);
        const midOut = await readShellMotion(page);
        expect(midOut.contentTranslateX).toBeLessThan(-64);
        expect(midOut.contentTranslateX).toBeGreaterThan(-144);
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        expect((await readShellMotion(page)).contentTranslateX).toBe(0);
      },
    );
  });

  it("keeps the page caret and restores the expand control when the engine cannot animate", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(Element.prototype, "animate", {
            configurable: true,
            value: undefined,
          });
        });
        await openMockedChat(page);
        const composer = page.locator(".agent-chat__input textarea");
        await composer.click();
        await page.keyboard.type("caret during the instant snap");
        await page.keyboard.press("ControlOrMeta+b");
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(1);
        // A caret already in the page wins over the focus rescue.
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.tagName ?? ""))
          .toBe("TEXTAREA");
        expect(await composer.inputValue()).toBe("caret during the instant snap");
        expect(
          await page.evaluate(() =>
            [...document.getAnimations()].some((animation) =>
              animation.id.startsWith("shell-nav-"),
            ),
          ),
        ).toBe(false);

        // Expand and collapse from the rail: focus follows onto the expand
        // button once the collapsed chrome has rendered.
        await page.keyboard.press("ControlOrMeta+b");
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(0);
        await page.locator(COLLAPSE_BUTTON).click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(1);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.classList.contains("shell-chrome-controls__nav-toggle") ??
                false,
            ),
          )
          .toBe(true);
      },
    );
  });

  it("leaves a right-docked panel untouched by the navigation motion", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": {
              agentId: "main",
              confined: false,
              cwd: "/workspace/openclaw",
              sessionId: "right-dock",
              shell: "/bin/bash",
            },
          },
          terminalEnabled: true,
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiGatewayReady(page);
        await waitForControlUiTerminalReady(page);
        await page.keyboard.press("Control+Backquote");
        const panel = page.locator("openclaw-terminal-panel");
        await panel.locator(".tp--bottom").waitFor({ state: "visible" });
        await panel.getByRole("button", { name: "Dock to right" }).click();
        await expect.poll(() => panel.locator(".tp").getAttribute("class")).toContain("tp--right");
        await waitForShellLayout(page);
        const before = await readShellMotion(page);
        expect(before.terminal?.className).toContain("tp--right");

        await page.locator(COLLAPSE_BUTTON).click();
        await holdShellMotion(page, "shell-nav-out", 0.5);
        const midOut = await readShellMotion(page);
        expect(midOut.terminal!.animations).toEqual([]);
        expect(midOut.terminal!.opacity).toBe(1);
        expect(midOut.terminal!.translateX).toBe(0);
        expect(midOut.terminal!.rect).toEqual(before.terminal!.rect);
        await finishMotionEffect(page, "shell-nav-out");
        await waitForMotionEffect(page, "shell-nav-in");
        await finishMotionEffect(page, "shell-nav-in");
        await waitForMotionSettled(page);
        expect((await readShellMotion(page)).terminal!.rect).toEqual(before.terminal!.rect);
      },
    );
  });
});
