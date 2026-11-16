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
      return { durationMs: null, easing: "" };
    }
    // The desktop width clock is a local transition on the panel element.
    const style = getComputedStyle(panel);
    const properties = style.transitionProperty.split(",").map((value) => value.trim());
    const durations = style.transitionDuration.split(",").map((value) => value.trim());
    const easings =
      style.transitionTimingFunction.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+/g) ?? [];
    const index = properties.indexOf("width");
    const duration = index >= 0 ? Number.parseFloat(durations[index] ?? "") : Number.NaN;
    return {
      durationMs: Number.isFinite(duration) ? duration * 1000 : null,
      easing: index >= 0 ? (easings[index] ?? "") : "",
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
            animation instanceof CSSTransition &&
            animation.transitionProperty === "width" &&
            animation.playState === "running",
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
    const hold = (element: Element | null | undefined, properties: string[]) => {
      for (const animation of element?.getAnimations() ?? []) {
        if (
          animation instanceof CSSTransition &&
          properties.includes(animation.transitionProperty)
        ) {
          animation.pause();
          animation.currentTime = time;
          held += 1;
        }
      }
    };
    hold(panel, ["width", "opacity"]);
    hold(shell, ["margin-right"]);
    return held;
  }, atMs);
}

export async function finishDesktopDockTransitions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    const finish = (element: Element | null | undefined, properties: string[]) => {
      for (const animation of element?.getAnimations() ?? []) {
        if (
          animation instanceof CSSTransition &&
          properties.includes(animation.transitionProperty)
        ) {
          animation.finish();
        }
      }
    };
    finish(panel, ["width", "opacity"]);
    finish(shell, ["margin-right"]);
  });
}
