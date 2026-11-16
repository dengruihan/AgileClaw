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
    const style = getComputedStyle(document.documentElement);
    const properties = style.transitionProperty.split(",").map((value) => value.trim());
    const durations = style.transitionDuration.split(",").map((value) => value.trim());
    const easings =
      style.transitionTimingFunction.match(/cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+/g) ?? [];
    const index = properties.indexOf("--oc-desktop-reserve-right");
    const duration = index >= 0 ? Number.parseFloat(durations[index] ?? "") : Number.NaN;
    return {
      durationMs: Number.isFinite(duration) ? duration * 1000 : null,
      easing: index >= 0 ? (easings[index] ?? "") : "",
    };
  });
}

export async function hasDesktopDockWidthTransition(page: Page) {
  return page.evaluate(() =>
    document.documentElement
      .getAnimations()
      .some(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "--oc-desktop-reserve-right",
      ),
  );
}

export async function holdDesktopDockTransitions(page: Page, atMs: number): Promise<number> {
  return page.evaluate((time) => {
    const root = document.documentElement;
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    let held = 0;
    for (const animation of root.getAnimations()) {
      if (
        animation instanceof CSSTransition &&
        animation.transitionProperty === "--oc-desktop-reserve-right"
      ) {
        animation.pause();
        animation.currentTime = time;
        held += 1;
      }
    }
    for (const animation of panel?.getAnimations() ?? []) {
      if (animation instanceof CSSTransition && animation.transitionProperty === "opacity") {
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
    const root = document.documentElement;
    const panel = document
      .querySelector("openclaw-desktop-panel")
      ?.shadowRoot?.querySelector<HTMLElement>(".bp");
    for (const animation of root.getAnimations()) {
      if (
        animation instanceof CSSTransition &&
        animation.transitionProperty === "--oc-desktop-reserve-right"
      ) {
        animation.finish();
      }
    }
    for (const animation of panel?.getAnimations() ?? []) {
      if (animation instanceof CSSTransition && animation.transitionProperty === "opacity") {
        animation.finish();
      }
    }
  });
}
