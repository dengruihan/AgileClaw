import type { Page } from "playwright";

type DesktopShellGeometry = {
  panelWidth: number;
  panelLeft: number;
  shellRight: number;
  shellMarginRight: number;
  contentRight: number;
  reserveRight: string;
};

export async function readDesktopShellGeometry(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    if (!shell || !content) {
      throw new Error("Missing shell geometry");
    }
    const panelRect = panel?.getBoundingClientRect();
    return {
      panelWidth: panelRect?.width ?? 0,
      panelLeft: panelRect?.left ?? 0,
      shellRight: shell.getBoundingClientRect().right,
      shellMarginRight: Number.parseFloat(getComputedStyle(shell).marginRight),
      contentRight: content.getBoundingClientRect().right,
      reserveRight: document.documentElement.style.getPropertyValue("--oc-desktop-reserve-right"),
    } satisfies DesktopShellGeometry;
  });
}

export async function readDesktopDockTransition(page: Page) {
  return page.evaluate(() => {
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    if (!panel) {
      throw new Error("Missing desktop panel");
    }
    const style = getComputedStyle(panel);
    const split = (value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const easingValues = (value: string) =>
      value.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+/g) ?? [];
    return {
      properties: split(style.transitionProperty),
      durations: split(style.transitionDuration),
      easings: easingValues(style.transitionTimingFunction),
    };
  });
}

export async function hasDesktopDockWidthTransition(page: Page) {
  return page.evaluate(
    () =>
      document
        .querySelector("openclaw-desktop-panel")
        ?.shadowRoot?.querySelector<HTMLElement>(".bp")
        ?.getAnimations()
        .some(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === "width",
        ) ?? false,
  );
}

export async function holdDesktopDockTransitions(page: Page, atMs: number): Promise<number> {
  return page.evaluate((time) => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    let held = 0;
    for (const animation of panel?.getAnimations() ?? []) {
      if (
        animation instanceof CSSTransition &&
        (animation.transitionProperty === "width" || animation.transitionProperty === "opacity")
      ) {
        animation.pause();
        animation.currentTime = time;
        held += 1;
      }
    }
    for (const animation of shell?.getAnimations() ?? []) {
      if (animation instanceof CSSTransition && animation.transitionProperty === "margin-right") {
        animation.pause();
        animation.currentTime = time;
        held += 1;
      }
    }
    return held;
  }, atMs);
}

export async function finishDesktopDockTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    for (const element of [shell, panel]) {
      for (const animation of element?.getAnimations() ?? []) {
        if (animation instanceof CSSTransition) {
          animation.finish();
        }
      }
    }
  });
}
