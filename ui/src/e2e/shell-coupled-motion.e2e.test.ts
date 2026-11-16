import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// ZCode desktop shell motion contract (zai-org/ZCode fec975905a2):
// - left navigation: width + opacity, 200ms ease-out, the main column follows
//   through the shared layout.
// - right dock: width + opacity, 200ms ease-out, content fixed at the target
//   width during the transition, temporary styles released by the real
//   transition completion/cancellation.
// Both use cubic-bezier(0, 0, 0.2, 1), Tailwind's `ease-out`, which is what the
// upstream `duration-200 ease-out` utilities compute to.
const suite = createControlUiE2eSuite({
  name: "Control UI shell motion",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const SESSION_KEY = "agent:main:main";
const COLLAPSE_BUTTON = ".sidebar-brand__collapse";
const EXPAND_BUTTON = ".shell-chrome-controls__nav-toggle";
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";
const TERMINAL_WIDTH = 600;

let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
    ? createControlUiE2eArtifactDir("shell-coupled-motion")
    : undefined;
});

async function capture(page: Page, name: string): Promise<void> {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({
    // Mid-motion proofs keep the paused transition frame.
    animations: "allow",
    caret: "hide",
    path: path.join(artifactDir, `${name}.png`),
  });
}

function proofVideo(): { dir: string; size: { height: number; width: number } } | undefined {
  return artifactDir
    ? { dir: path.join(artifactDir, "video"), size: { height: 900, width: 1440 } }
    : undefined;
}

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

async function openMockedChat(page: Page): Promise<void> {
  await installMockGateway(page, {
    historyMessages: history(),
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
  await waitForControlUiGatewayReady(page);
  await page.locator(".chat-thread").waitFor();
  await waitForShellLayout(page);
}

async function openMockedActivity(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 240, width: 600 }),
    );
  });
  await installMockGateway(page, {
    featureMethods: ["terminal.open"],
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
  await page.goto(`${suite.server.baseUrl}activity`);
  await waitForControlUiGatewayReady(page);
  await openTerminalPanel(page, "right");
}

async function waitForShellLayout(page: Page): Promise<void> {
  await page.locator(".shell").evaluate(async (shell) => {
    const animations = shell
      .getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number };

type TransitionProfile = {
  properties: string[];
  durations: string[];
  easings: string[];
};

type NavMotion = {
  collapsed: boolean;
  nav: Rect & { opacity: number };
  content: Rect & { opacity: number; transform: string };
  composer: Rect | null;
  shell: { width: number };
  transition: TransitionProfile;
  motionAnimations: string[];
};

async function readNavMotion(page: Page): Promise<NavMotion> {
  return page.evaluate(() => {
    const rect = (element: Element | null | undefined): Rect | null => {
      const box = element?.getBoundingClientRect();
      return box
        ? {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            width: box.width,
          }
        : null;
    };
    const shell = document.querySelector<HTMLElement>(".shell");
    const nav = document.querySelector<HTMLElement>(".shell-nav");
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    if (!shell || !nav || !content) {
      throw new Error("Missing shell nav surface");
    }
    const style = getComputedStyle(nav);
    const split = (value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const easingValues = (value: string) =>
      value.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+/g) ?? [];
    return {
      collapsed: shell.classList.contains("shell--nav-collapsed"),
      nav: {
        ...rect(nav)!,
        opacity: Number.parseFloat(getComputedStyle(nav).opacity),
      },
      content: {
        ...rect(content)!,
        opacity: Number.parseFloat(getComputedStyle(content).opacity),
        transform: getComputedStyle(content).transform,
      },
      composer: rect(document.querySelector(".agent-chat__input")),
      shell: { width: shell.clientWidth },
      transition: {
        properties: split(style.transitionProperty),
        durations: split(style.transitionDuration),
        easings: easingValues(style.transitionTimingFunction),
      },
      motionAnimations: [...document.getAnimations()]
        .map((animation) => animation.id)
        .filter((id) => id.startsWith("shell-nav-")),
    };
  });
}

/** Pauses every nav/plate CSS transition at one moment of its own clock. */
async function holdNavTransitions(page: Page, atMs: number): Promise<number> {
  return page.evaluate((time) => {
    let held = 0;
    for (const element of [
      document.querySelector<HTMLElement>(".shell"),
      document.querySelector<HTMLElement>(".shell-nav"),
    ]) {
      for (const animation of element?.getAnimations() ?? []) {
        if (
          !(animation instanceof CSSTransition) ||
          animation.transitionProperty === "grid-template-rows"
        ) {
          continue;
        }
        animation.pause();
        animation.currentTime = time;
        held += 1;
      }
    }
    return held;
  }, atMs);
}

async function finishTransitions(page: Page, selectors: readonly string[]): Promise<void> {
  await page.evaluate((targets) => {
    for (const selector of targets) {
      for (const animation of document.querySelector(selector)?.getAnimations() ?? []) {
        if (animation instanceof CSSTransition) {
          animation.finish();
        }
      }
    }
  }, selectors);
}

async function waitForNavTransition(page: Page, property: "width" | "opacity"): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((wanted) => {
        const nav = document.querySelector<HTMLElement>(".shell-nav");
        return (
          nav
            ?.getAnimations()
            .some(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === wanted &&
                animation.playState === "running",
            ) ?? false
        );
      }, property),
    )
    .toBe(true);
}

async function waitForNavSettled(page: Page, collapsed: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((expected) => {
        const shell = document.querySelector(".shell");
        const nav = document.querySelector<HTMLElement>(".shell-nav");
        if (!shell || !nav) {
          return false;
        }
        const running = nav
          .getAnimations()
          .some(
            (animation) => animation instanceof CSSTransition && animation.playState === "running",
          );
        const width = nav.getBoundingClientRect().width;
        const opacity = Number.parseFloat(getComputedStyle(nav).opacity);
        // The rail keeps its 1px divider border at the collapsed width.
        return !running && (expected ? width < 1.5 && opacity === 0 : width > 200 && opacity === 1);
      }, collapsed),
    )
    .toBe(true);
}

type DockMotion = {
  connected: boolean;
  width: number;
  opacity: number;
  contentWidth: number;
  contentVariable: string;
  motionClasses: string[];
  left: number;
  shellRight: number;
  transition: TransitionProfile;
};

async function readRightDock(page: Page): Promise<DockMotion> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) {
      throw new Error("Missing shell");
    }
    const panel = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const style = panel ? getComputedStyle(panel) : null;
    const content = panel?.querySelector<HTMLElement>(".dock-panel-content");
    const split = (value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const easingValues = (value: string) =>
      value.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+/g) ?? [];
    return {
      connected: panel !== null,
      width: panel?.getBoundingClientRect().width ?? 0,
      opacity: style ? Number.parseFloat(style.opacity) : 1,
      contentWidth: content?.getBoundingClientRect().width ?? 0,
      contentVariable: panel?.style.getPropertyValue("--oc-dock-content-width") ?? "",
      motionClasses: panel
        ? [...panel.classList].filter((name) => name.startsWith("dock-panel--"))
        : [],
      left: panel?.getBoundingClientRect().left ?? 0,
      shellRight: shell.getBoundingClientRect().right,
      transition: {
        properties: split(style?.transitionProperty ?? ""),
        durations: split(style?.transitionDuration ?? ""),
        easings: easingValues(style?.transitionTimingFunction ?? ""),
      },
    };
  });
}

async function readRightDockWidth(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp")
        ?.getBoundingClientRect().width ?? 0,
  );
}

async function waitForDockTransition(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const panel = document
          .querySelector("openclaw-terminal-panel")
          ?.shadowRoot?.querySelector<HTMLElement>(".tp");
        return (
          panel
            ?.getAnimations()
            .some(
              (animation) =>
                animation instanceof CSSTransition &&
                (animation.transitionProperty === "width" ||
                  animation.transitionProperty === "opacity"),
            ) ?? false
        );
      }),
    )
    .toBe(true);
}

/** Pauses the dock and plate transitions that make the reserved area move. */
async function holdDockTransitions(page: Page, atMs: number): Promise<number> {
  return page.evaluate((time) => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    let held = 0;
    for (const element of [shell, panel]) {
      for (const animation of element?.getAnimations() ?? []) {
        if (!(animation instanceof CSSTransition)) {
          continue;
        }
        if (element === shell && animation.transitionProperty !== "margin-right") {
          continue;
        }
        animation.pause();
        animation.currentTime = time;
        held += 1;
      }
    }
    return held;
  }, atMs);
}

async function finishDockTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    for (const element of [shell, panel]) {
      for (const animation of element?.getAnimations() ?? []) {
        if (animation instanceof CSSTransition) {
          animation.finish();
        }
      }
    }
  });
}

async function dispatchTerminalToggle(page: Page, detail: { open: boolean }): Promise<void> {
  await page.evaluate((next) => {
    window.dispatchEvent(
      new CustomEvent("openclaw:terminal-toggle", { cancelable: true, detail: next }),
    );
  }, detail);
}

async function openTerminalPanel(page: Page, dock: "bottom" | "right"): Promise<void> {
  await waitForControlUiTerminalReady(page);
  await page
    .locator(`openclaw-terminal-panel .tp--${dock}`)
    .waitFor({ state: "visible", timeout: 15_000 });
  await waitForShellLayout(page);
}

suite.define(() => {
  it("animates the nav width and opacity at 200ms ease-out while the chat column follows", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: proofVideo(),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedChat(page);
        const expanded = await readNavMotion(page);
        expect(expanded.transition.properties).toEqual(
          expect.arrayContaining(["width", "opacity"]),
        );
        expect(expanded.transition.durations.every((value) => value === "0.2s")).toBe(true);
        expect(expanded.transition.easings.every((value) => value === EASE_OUT)).toBe(true);
        expect(expanded.nav.width).toBeGreaterThan(200);
        expect(expanded.nav.opacity).toBe(1);
        expect(expanded.content.opacity).toBe(1);
        expect(expanded.content.transform).toBe("none");
        expect(expanded.content.left).toBeCloseTo(expanded.nav.right, 1);

        await page.locator(COLLAPSE_BUTTON).click();
        await waitForNavTransition(page, "width");
        expect(await holdNavTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const midOut = await readNavMotion(page);
        expect(midOut.collapsed).toBe(true);
        expect(midOut.nav.width).toBeGreaterThan(1);
        expect(midOut.nav.width).toBeLessThan(expanded.nav.width - 1);
        expect(midOut.nav.opacity).toBeGreaterThan(0);
        expect(midOut.nav.opacity).toBeLessThan(1);
        expect(midOut.content.opacity).toBe(1);
        expect(midOut.content.transform).toBe("none");
        expect(midOut.content.left).toBeCloseTo(midOut.nav.right, 1);
        expect(midOut.content.width).toBeCloseTo(midOut.shell.width - midOut.nav.width, 0.5);
        // The composer rides the narrowing column (its own max width may
        // already be capped at both ends, so the column offset is the proof).
        expect(midOut.composer!.left).toBeLessThan(expanded.composer!.left - 1);
        expect(midOut.motionAnimations).toEqual([]);

        // Native input, selection, and wheel scrolling stay live on the frozen
        // intermediate frame; the layout is the only thing moving.
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
        await page.keyboard.type("typed while the nav width moves");
        await expect.poll(() => composer.inputValue()).toBe("typed while the nav width moves");
        await capture(page, "nav-mid-collapse");

        await finishTransitions(page, [".shell-nav", ".shell"]);
        await waitForNavSettled(page, true);
        const collapsed = await readNavMotion(page);
        expect(collapsed.nav.width).toBeLessThan(1.5);
        expect(collapsed.nav.opacity).toBe(0);
        expect(collapsed.content.width).toBeCloseTo(collapsed.shell.width, 0.5);
        expect(await composer.inputValue()).toBe("typed while the nav width moves");

        // Expanding mirrors the same width/opacity clock.
        await page.locator(EXPAND_BUTTON).click();
        await waitForNavTransition(page, "width");
        expect(await holdNavTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const midIn = await readNavMotion(page);
        expect(midIn.collapsed).toBe(false);
        expect(midIn.nav.width).toBeGreaterThan(1);
        expect(midIn.nav.width).toBeLessThan(expanded.nav.width - 1);
        expect(midIn.nav.opacity).toBeGreaterThan(0);
        expect(midIn.nav.opacity).toBeLessThan(1);
        expect(midIn.content.opacity).toBe(1);
        expect(midIn.content.transform).toBe("none");
        expect(midIn.content.left).toBeCloseTo(midIn.nav.right, 1);
        await capture(page, "nav-mid-expand");
        await finishTransitions(page, [".shell-nav", ".shell"]);
        await waitForNavSettled(page, false);
        const restored = await readNavMotion(page);
        expect(restored.nav.width).toBeCloseTo(expanded.nav.width, 0.5);
        expect(restored.nav.opacity).toBe(1);
        expect(restored.content.width).toBeCloseTo(expanded.content.width, 0.5);
      },
    );
  });

  it("retargets an in-flight nav width from its current geometry", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: proofVideo(),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedChat(page);
        const expanded = await readNavMotion(page);
        await page.locator(COLLAPSE_BUTTON).click();
        await waitForNavTransition(page, "width");
        expect(await holdNavTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const held = await readNavMotion(page);
        expect(held.nav.width).toBeGreaterThan(1);
        expect(held.nav.width).toBeLessThan(expanded.nav.width - 1);

        await page.keyboard.press("ControlOrMeta+b");
        const resumed = await page.evaluate(async () => {
          for (const element of [
            document.querySelector<HTMLElement>(".shell"),
            document.querySelector<HTMLElement>(".shell-nav"),
          ]) {
            for (const animation of element?.getAnimations() ?? []) {
              if (animation instanceof CSSTransition && animation.playState === "paused") {
                animation.play();
              }
            }
          }
          const nav = document.querySelector<HTMLElement>(".shell-nav")!;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return {
            width: nav.getBoundingClientRect().width,
            opacity: Number.parseFloat(getComputedStyle(nav).opacity),
            collapsed: document.querySelector(".shell")?.classList.contains("shell--nav-collapsed"),
          };
        });
        // The reversal continues from the held frame instead of snapping to
        // either endpoint.
        expect(resumed.width).toBeGreaterThan(held.nav.width + 1);
        expect(resumed.width).toBeLessThan(expanded.nav.width);
        expect(resumed.opacity).toBeGreaterThan(held.nav.opacity);
        expect(resumed.collapsed).toBe(false);
        await waitForNavSettled(page, false);
        expect((await readNavMotion(page)).nav.width).toBeCloseTo(expanded.nav.width, 0.5);
      },
    );
  });

  it("animates the right dock width and opacity at 200ms ease-out with content width locked", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: proofVideo(),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedActivity(page);
        const expanded = await readRightDock(page);
        expect(expanded.width).toBe(TERMINAL_WIDTH);
        expect(expanded.opacity).toBe(1);
        expect(expanded.contentWidth).toBeCloseTo(TERMINAL_WIDTH, 0.5);
        expect(expanded.contentVariable).toBe("");

        await page
          .locator("openclaw-terminal-panel")
          .getByRole("button", { name: "Hide terminal" })
          .click();
        await waitForDockTransition(page);
        expect(await holdDockTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const midClose = await readRightDock(page);
        expect(midClose.connected).toBe(true);
        expect(midClose.width).toBeGreaterThan(1);
        expect(midClose.width).toBeLessThan(TERMINAL_WIDTH - 1);
        expect(midClose.opacity).toBeGreaterThan(0);
        expect(midClose.opacity).toBeLessThan(1);
        // The content keeps its expanded width while the panel frame clips it,
        // so tabs and the terminal never reflow mid-transition.
        expect(midClose.contentWidth).toBeCloseTo(TERMINAL_WIDTH, 0.5);
        expect(midClose.contentVariable).toBe(`${TERMINAL_WIDTH}px`);
        expect(midClose.transition.properties).toEqual(
          expect.arrayContaining(["width", "opacity"]),
        );
        expect(midClose.transition.durations.every((value) => value === "0.2s")).toBe(true);
        expect(midClose.transition.easings.every((value) => value === EASE_OUT)).toBe(true);
        // The reserved shell plate and the panel edge travel together (the
        // plate keeps its 8px window inset while the dock width shrinks).
        expect(midClose.left - midClose.shellRight).toBeCloseTo(8, 1);
        await capture(page, "dock-mid-close");

        await finishDockTransitions(page);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document
                  .querySelector("openclaw-terminal-panel")
                  ?.shadowRoot?.querySelector(".tp") === null,
            ),
          )
          .toBe(true);
        expect(
          await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
          ),
        ).toBe("0px");

        await dispatchTerminalToggle(page, { open: true });
        await waitForDockTransition(page);
        expect(await holdDockTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const midOpen = await readRightDock(page);
        expect(midOpen.connected).toBe(true);
        expect(midOpen.width).toBeGreaterThan(1);
        expect(midOpen.width).toBeLessThan(TERMINAL_WIDTH - 1);
        expect(midOpen.opacity).toBeGreaterThan(0);
        expect(midOpen.opacity).toBeLessThan(1);
        expect(midOpen.contentWidth).toBeCloseTo(TERMINAL_WIDTH, 0.5);
        expect(midOpen.contentVariable).toBe(`${TERMINAL_WIDTH}px`);
        expect(midOpen.left - midOpen.shellRight).toBeCloseTo(8, 1);
        await capture(page, "dock-mid-open");
        await finishDockTransitions(page);
        await expect.poll(() => readRightDockWidth(page)).toBe(TERMINAL_WIDTH);
        const restored = await readRightDock(page);
        expect(restored.opacity).toBe(1);
        expect(restored.contentVariable).toBe("");
        expect(restored.motionClasses).toEqual([]);
      },
    );
  });

  it("retargets an in-flight right dock width from its current geometry", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: proofVideo(),
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedActivity(page);
        await dispatchTerminalToggle(page, { open: false });
        await waitForDockTransition(page);
        expect(await holdDockTransitions(page, 100)).toBeGreaterThanOrEqual(2);
        const held = await readRightDock(page);
        expect(held.width).toBeGreaterThan(1);
        expect(held.width).toBeLessThan(TERMINAL_WIDTH - 1);

        await dispatchTerminalToggle(page, { open: true });
        const resumed = await page.evaluate(async () => {
          for (const element of [
            document.querySelector<HTMLElement>(".shell"),
            document
              .querySelector("openclaw-terminal-panel")
              ?.shadowRoot?.querySelector<HTMLElement>(".tp"),
          ]) {
            for (const animation of element?.getAnimations() ?? []) {
              if (animation instanceof CSSTransition && animation.playState === "paused") {
                animation.play();
              }
            }
          }
          const panel = document
            .querySelector("openclaw-terminal-panel")
            ?.shadowRoot?.querySelector<HTMLElement>(".tp");
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return {
            width: panel?.getBoundingClientRect().width ?? 0,
            opacity: panel ? Number.parseFloat(getComputedStyle(panel).opacity) : 0,
          };
        });
        // A reversal continues from the held frame instead of snapping to
        // either endpoint (zero width or the settled width).
        await capture(page, "dock-reverse-mid");
        expect(resumed.width).toBeGreaterThanOrEqual(held.width - 0.5);
        expect(resumed.width).toBeLessThan(TERMINAL_WIDTH);
        expect(resumed.opacity).toBeGreaterThanOrEqual(held.opacity - 0.01);
        await finishDockTransitions(page);
        await expect.poll(() => readRightDockWidth(page)).toBe(TERMINAL_WIDTH);
      },
    );
  });

  it("snaps both columns without transitions under reduced motion", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await openMockedActivity(page);
        const motionless = await page.evaluate(() => {
          const nav = document.querySelector<HTMLElement>(".shell-nav");
          const shell = document.querySelector<HTMLElement>(".shell");
          return {
            navTransition: nav ? getComputedStyle(nav).transitionProperty : "",
            shellTransition: shell ? getComputedStyle(shell).transitionProperty : "",
          };
        });
        expect(motionless.navTransition).toBe("none");
        expect(motionless.shellTransition.split(",").map((value) => value.trim())).not.toContain(
          "margin-right",
        );

        await page.locator(COLLAPSE_BUTTON).click();
        await waitForNavSettled(page, true);
        const collapsed = await readNavMotion(page);
        expect(collapsed.nav.width).toBeLessThan(1.5);
        expect(
          await page.evaluate(() =>
            [
              ...document.querySelector(".shell-nav")!.getAnimations(),
              ...document.querySelector(".shell")!.getAnimations(),
            ].some(
              (animation) =>
                animation instanceof CSSTransition &&
                (animation.transitionProperty === "width" ||
                  animation.transitionProperty === "opacity" ||
                  animation.transitionProperty === "margin-right"),
            ),
          ),
        ).toBe(false);

        await dispatchTerminalToggle(page, { open: false });
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document
                  .querySelector("openclaw-terminal-panel")
                  ?.shadowRoot?.querySelector(".tp") === null,
            ),
          )
          .toBe(true);
        expect(
          await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
          ),
        ).toBe("0px");

        await page.locator(EXPAND_BUTTON).click();
        await waitForNavSettled(page, false);
        await dispatchTerminalToggle(page, { open: true });
        await expect.poll(() => readRightDockWidth(page)).toBe(TERMINAL_WIDTH);
      },
    );
  });
});
