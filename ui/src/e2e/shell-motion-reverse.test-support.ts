import type { Page } from "playwright";

type ReverseFrame = {
  atMs: number;
  panelPresent: boolean;
  panelWidth: number;
  panelLeft: number;
  shellRight: number;
  shellMarginRight: number;
  panelWidthDuration: number | null;
  panelWidthRemaining: number | null;
};

export async function runTerminalReverse(
  page: Page,
  mode: "close-open" | "open-close",
): Promise<{ afterDispatch: ReverseFrame; samples: ReverseFrame[] }> {
  return page.evaluate(async (direction) => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) {
      throw new Error("Missing shell");
    }
    const panel = () =>
      document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const timing = (element: Element, property: string) => {
      const animation = element
        .getAnimations()
        .find(
          (entry): entry is CSSTransition =>
            entry instanceof CSSTransition && entry.transitionProperty === property,
        );
      if (!animation) {
        return { duration: null, remaining: null };
      }
      const computed = animation.effect?.getComputedTiming();
      const endTime = Number(computed?.endTime ?? 0);
      const duration = Number(computed?.duration ?? 0);
      return { duration, remaining: endTime - Number(animation.currentTime ?? 0) };
    };
    const sample = (origin: number): ReverseFrame => {
      const element = panel();
      if (!element) {
        return {
          atMs: performance.now() - origin,
          panelPresent: false,
          panelWidth: 0,
          panelLeft: 0,
          shellRight: shell.getBoundingClientRect().right,
          shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
          panelWidthDuration: null,
          panelWidthRemaining: null,
        };
      }
      const rect = element.getBoundingClientRect();
      const panelTiming = timing(document.documentElement, "--oc-terminal-reserve-right");
      return {
        atMs: performance.now() - origin,
        panelPresent: true,
        panelWidth: rect.width,
        panelLeft: rect.left,
        shellRight: shell.getBoundingClientRect().right,
        shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
        panelWidthDuration: panelTiming.duration,
        panelWidthRemaining: panelTiming.remaining,
      };
    };
    const close = () => {
      window.dispatchEvent(
        new CustomEvent("openclaw:terminal-toggle", { detail: { open: false } }),
      );
    };
    const open = () => {
      window.dispatchEvent(new CustomEvent("openclaw:terminal-toggle", { detail: { open: true } }));
    };
    const origin = performance.now();
    if (direction === "open-close") {
      // Start closed and reverse an opening motion.
      open();
      for (let index = 0; index < 7; index += 1) {
        await frame();
      }
      close();
    } else {
      close();
      for (let index = 0; index < 7; index += 1) {
        await frame();
      }
      open();
    }
    // Reversal was dispatched through the real event path above; no animation
    // is paused or seeked.
    await frame();
    await frame();
    const afterDispatch = sample(origin);
    const samples: ReverseFrame[] = [];
    for (let index = 0; index < 8; index += 1) {
      await frame();
      samples.push(sample(origin));
    }
    return { afterDispatch, samples };
  }, mode);
}

type SiblingFrame = {
  atMs: number;
  terminalWidth: number;
  terminalLeft: number;
  browserWidth: number;
  browserLeft: number;
  browserRight: number;
  shellRight: number;
  shellMarginRight: number;
  terminalContentWidth: number;
  browserContentWidth: number;
  terminalTarget: number;
  browserTarget: number;
  terminalDuration: number | null;
  terminalRemaining: number | null;
  browserDuration: number | null;
  browserRemaining: number | null;
};

export async function runSiblingReverse(
  page: Page,
  mode: "moving" | "stationary",
): Promise<{
  afterDispatch: SiblingFrame;
  samples: SiblingFrame[];
  stationary: { width: number; target: number; contentPin: string } | null;
}> {
  return page.evaluate(async (kind) => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) {
      throw new Error("Missing shell");
    }
    const terminal = () =>
      document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const browser = () =>
      document
        .querySelector("openclaw-browser-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const timing = (prefix: string) => {
      const animation = document.documentElement
        .getAnimations()
        .find(
          (entry): entry is CSSTransition =>
            entry instanceof CSSTransition &&
            entry.transitionProperty === `--oc-${prefix}-reserve-right`,
        );
      if (!animation) {
        return { duration: null, remaining: null };
      }
      const computed = animation.effect?.getComputedTiming();
      return {
        duration: Number(computed?.duration ?? 0),
        remaining: Number(computed?.endTime ?? 0) - Number(animation.currentTime ?? 0),
      };
    };
    const sample = (origin: number): SiblingFrame => {
      const terminalElement = terminal();
      const browserElement = browser();
      if (!terminalElement || !browserElement) {
        throw new Error(
          `Missing sibling dock terminal=${Boolean(terminalElement)} browser=${Boolean(browserElement)}`,
        );
      }
      const terminalRect = terminalElement.getBoundingClientRect();
      const browserRect = browserElement.getBoundingClientRect();
      const terminalTiming = timing("terminal");
      const browserTiming = timing("browser");
      const terminalTarget = Number.parseFloat(
        document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
      );
      const browserTarget = Number.parseFloat(
        document.documentElement.style.getPropertyValue("--oc-browser-reserve-right"),
      );
      const contentWidth = (element: HTMLElement) =>
        element.querySelector<HTMLElement>(".dock-panel-content")?.getBoundingClientRect().width ??
        0;
      return {
        atMs: performance.now() - origin,
        terminalWidth: terminalRect.width,
        terminalLeft: terminalRect.left,
        browserWidth: browserRect.width,
        browserLeft: browserRect.left,
        browserRight: browserRect.right,
        shellRight: shell.getBoundingClientRect().right,
        shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
        terminalContentWidth: contentWidth(terminalElement),
        browserContentWidth: contentWidth(browserElement),
        terminalTarget: Number.isFinite(terminalTarget) ? terminalTarget : 0,
        browserTarget: Number.isFinite(browserTarget) ? browserTarget : 0,
        terminalDuration: terminalTiming.duration,
        terminalRemaining: terminalTiming.remaining,
        browserDuration: browserTiming.duration,
        browserRemaining: browserTiming.remaining,
      };
    };
    const terminalToggle = (open: boolean) =>
      window.dispatchEvent(new CustomEvent("openclaw:terminal-toggle", { detail: { open } }));
    const browserToggle = () =>
      window.dispatchEvent(
        new CustomEvent("openclaw:browser-toggle", {
          detail: { open: true, dock: "right" },
        }),
      );
    const terminalTarget =
      Number.parseFloat(
        document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
      ) || 600;
    const waitForTerminalMid = async (): Promise<boolean> => {
      for (let index = 0; index < 20; index += 1) {
        await frame();
        const element = terminal();
        if (!element) {
          return false;
        }
        const width = element.getBoundingClientRect().width;
        if (width > 1 && width < terminalTarget - 20) {
          return true;
        }
      }
      return false;
    };
    const origin = performance.now();
    let stationary: { width: number; target: number; contentPin: string } | null = null;
    if (kind === "moving") {
      // Start the browser moving first, then close the terminal and reverse
      // it while both are still in flight.
      browserToggle();
      let browserMoving = false;
      for (let index = 0; index < 40; index += 1) {
        await frame();
        const browserElement = browser();
        const browserTarget = Number.parseFloat(
          document.documentElement.style.getPropertyValue("--oc-browser-reserve-right"),
        );
        if (
          browserElement &&
          browserElement.getBoundingClientRect().width > 1 &&
          Number.isFinite(browserTarget) &&
          browserElement.getBoundingClientRect().width < browserTarget - 20
        ) {
          browserMoving = true;
          break;
        }
      }
      if (!browserMoving) {
        throw new Error(
          JSON.stringify({
            stage: "moving-sibling-browser",
            browser: browser()?.getBoundingClientRect().width ?? null,
            browserTarget: document.documentElement.style.getPropertyValue(
              "--oc-browser-reserve-right",
            ),
          }),
        );
      }
      terminalToggle(false);
      if (!(await waitForTerminalMid())) {
        throw new Error("Terminal left the mid-close frame before reversal");
      }
      terminalToggle(true);
    } else {
      // A settled browser is the stationary sibling; reverse the terminal
      // while it closes.
      browserToggle();
      let settled = false;
      for (let index = 0; index < 60; index += 1) {
        await frame();
        const browserElement = browser();
        if (!browserElement) {
          continue;
        }
        const browserTarget = Number.parseFloat(
          document.documentElement.style.getPropertyValue("--oc-browser-reserve-right"),
        );
        const browserSettling = document.documentElement
          .getAnimations()
          .some(
            (entry) =>
              entry instanceof CSSTransition &&
              entry.transitionProperty === "--oc-browser-reserve-right",
          );
        const width = browserElement.getBoundingClientRect().width;
        const contentPin = browserElement.style.getPropertyValue("--oc-dock-content-width");
        if (
          width > 1 &&
          Number.isFinite(browserTarget) &&
          Math.abs(width - browserTarget) < 0.5 &&
          !browserSettling &&
          contentPin === ""
        ) {
          stationary = { width, target: browserTarget, contentPin };
          settled = true;
          break;
        }
      }
      if (!settled) {
        throw new Error("Stationary browser did not reach its pinned-free target");
      }
      terminalToggle(false);
      if (!(await waitForTerminalMid())) {
        throw new Error("Stationary sibling terminal did not reach a mid-close frame");
      }
      terminalToggle(true);
    }
    await frame();
    await frame();
    const afterDispatch = sample(origin);
    const samples: SiblingFrame[] = [];
    for (let index = 0; index < 8; index += 1) {
      await frame();
      samples.push(sample(origin));
    }
    return { afterDispatch, samples, stationary };
  }, mode);
}

export type TerminalResizeFrame = {
  atMs: number;
  width: number;
  contentWidth: number;
  contentPin: string;
  target: string;
  shellMarginRight: number;
  widthRunning: boolean;
};

export async function startTerminalOpenForResize(page: Page): Promise<TerminalResizeFrame> {
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    window.dispatchEvent(new CustomEvent("openclaw:terminal-toggle", { detail: { open: true } }));
    for (let index = 0; index < 6; index += 1) {
      await frame();
    }
    const panel = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!panel || !shell) {
      throw new Error("Missing terminal panel");
    }
    const content = panel.querySelector<HTMLElement>(".dock-panel-content");
    return {
      atMs: 0,
      width: panel.getBoundingClientRect().width,
      contentWidth: content?.getBoundingClientRect().width ?? 0,
      contentPin: panel.style.getPropertyValue("--oc-dock-content-width"),
      target: document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
      shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
      widthRunning: document.documentElement
        .getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "--oc-terminal-reserve-right",
        ),
    };
  });
}

export async function sampleTerminalOpenForResize(
  page: Page,
  count: number,
): Promise<TerminalResizeFrame[]> {
  return page.evaluate(async (frames) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const origin = performance.now();
    const samples: TerminalResizeFrame[] = [];
    for (let index = 0; index < frames; index += 1) {
      await frame();
      const panel = document
        .querySelector("openclaw-terminal-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".tp");
      const shell = document.querySelector<HTMLElement>(".shell");
      if (!panel || !shell) {
        throw new Error("Missing terminal panel");
      }
      const content = panel.querySelector<HTMLElement>(".dock-panel-content");
      samples.push({
        atMs: performance.now() - origin,
        width: panel.getBoundingClientRect().width,
        contentWidth: content?.getBoundingClientRect().width ?? 0,
        contentPin: panel.style.getPropertyValue("--oc-dock-content-width"),
        target: document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
        shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
        widthRunning: document.documentElement
          .getAnimations()
          .some(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === "--oc-terminal-reserve-right",
          ),
      });
    }
    return samples;
  }, count);
}

export async function readTerminalResizeSettle(page: Page) {
  return page.evaluate(() => {
    const panel = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!panel || !shell) {
      throw new Error("Missing terminal panel");
    }
    const content = panel.querySelector<HTMLElement>(".dock-panel-content");
    return {
      width: panel.getBoundingClientRect().width,
      contentWidth: content?.getBoundingClientRect().width ?? 0,
      contentPin: panel.style.getPropertyValue("--oc-dock-content-width"),
      target: document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right"),
      shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
      widthRunning: document.documentElement
        .getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "--oc-terminal-reserve-right",
        ),
    };
  });
}

export async function readSiblingSettle(page: Page) {
  return page.evaluate(() => {
    const terminal = document
      .querySelector("openclaw-terminal-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".tp");
    const browser = document
      .querySelector("openclaw-browser-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!terminal || !browser || !shell) {
      throw new Error("Missing sibling dock");
    }
    const terminalRect = terminal.getBoundingClientRect();
    const browserRect = browser.getBoundingClientRect();
    const root = document.documentElement;
    const running = root
      .getAnimations()
      .filter(
        (animation): animation is CSSTransition =>
          animation instanceof CSSTransition &&
          (animation.transitionProperty === "--oc-terminal-reserve-right" ||
            animation.transitionProperty === "--oc-browser-reserve-right") &&
          animation.playState !== "finished" &&
          animation.playState !== "idle",
      )
      .map((animation) => animation.transitionProperty);
    const contentWidth = (element: HTMLElement) =>
      element.querySelector<HTMLElement>(".dock-panel-content")?.getBoundingClientRect().width ?? 0;
    return {
      terminalWidth: terminalRect.width,
      terminalLeft: terminalRect.left,
      terminalContentWidth: contentWidth(terminal),
      terminalContentPin: terminal.style.getPropertyValue("--oc-dock-content-width"),
      browserWidth: browserRect.width,
      browserLeft: browserRect.left,
      browserRight: browserRect.right,
      browserContentWidth: contentWidth(browser),
      browserContentPin: browser.style.getPropertyValue("--oc-dock-content-width"),
      shellRight: shell.getBoundingClientRect().right,
      shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
      terminalTarget:
        Number.parseFloat(root.style.getPropertyValue("--oc-terminal-reserve-right")) || 0,
      browserTarget:
        Number.parseFloat(root.style.getPropertyValue("--oc-browser-reserve-right")) || 0,
      running,
    };
  });
}
