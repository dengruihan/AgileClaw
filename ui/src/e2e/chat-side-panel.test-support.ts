import type { Page } from "playwright";

export type SidebarRegionMotionSample = {
  t: number;
  regionWidth: number;
  mainWidth: number;
  sideWidth: number;
  dividerWidth: number;
  sideOpacity: number;
  headerOpacity: number;
  contentWidth: number;
  sideVisible: boolean;
  sideConnected: boolean;
  grid: string;
  regionAnimations: number;
  gridTransition: { durationMs: number | string; easing: string } | null;
};

/**
 * Passive rAF sampling of the real chat-grid geometry around a toggle. The
 * side surface is the track-sized box ([data-region="side"]); its first child
 * is the pinned content root. Reads force layout, so keep the window short.
 */
export function sampleSidebarRegionMotion(
  page: Page,
  windowMs = 500,
): Promise<SidebarRegionMotionSample[]> {
  return page.evaluate(async (durationMs) => {
    const region = document.querySelector<HTMLElement>(".sidebar-region");
    if (!region) {
      throw new Error("Missing .sidebar-region");
    }
    const samples: SidebarRegionMotionSample[] = [];
    const start = performance.now();
    while (performance.now() - start < durationMs) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const side = region.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const main = region.querySelector<HTMLElement>('[data-region="main"]:not([hidden])');
      const divider = region.querySelector<HTMLElement>(".sidebar-column__divider");
      const header = region.querySelector<HTMLElement>('[data-region-header="side"]');
      const content = side?.firstElementChild ?? null;
      const sideStyle = side ? getComputedStyle(side) : null;
      const gridTransition = region
        .getAnimations()
        .find(
          (animation) =>
            (animation as CSSTransition).transitionProperty === "grid-template-columns",
        );
      const gridTiming = gridTransition?.effect?.getTiming();
      const gridDuration = gridTiming?.duration ?? 0;
      samples.push({
        t: performance.now() - start,
        regionWidth: region.getBoundingClientRect().width,
        mainWidth: main?.getBoundingClientRect().width ?? 0,
        sideWidth: side?.getBoundingClientRect().width ?? 0,
        dividerWidth: divider?.getBoundingClientRect().width ?? 0,
        sideOpacity: sideStyle ? Number(sideStyle.opacity) : 0,
        headerOpacity: header ? Number(getComputedStyle(header).opacity) : 0,
        contentWidth: content?.getBoundingClientRect().width ?? 0,
        sideVisible: Boolean(side && sideStyle && sideStyle.display !== "none"),
        sideConnected: side?.isConnected ?? false,
        grid: getComputedStyle(region).gridTemplateColumns,
        regionAnimations: region.getAnimations().length,
        gridTransition: gridTiming
          ? {
              durationMs:
                typeof gridDuration === "number" || typeof gridDuration === "string"
                  ? gridDuration
                  : 0,
              easing: String(gridTiming.easing ?? ""),
            }
          : null,
      });
    }
    return samples;
  }, windowMs);
}

/** Samples whose side track is strictly between closed and the open target. */
export function midSidebarRegionSamples(
  samples: SidebarRegionMotionSample[],
  target: number,
): SidebarRegionMotionSample[] {
  return samples.filter((sample) => sample.sideWidth > 1 && sample.sideWidth < target - 1);
}

export type SidebarRegionAnimationDescriptor = {
  root: string;
  property: string;
  durationMs: number | string;
  easing: string;
  playState: string;
};

/**
 * Animations must be read from their owning root: the grid and side surfaces
 * are light DOM on the region, while embedded panel content lives in shadow
 * roots that document.getAnimations() never reaches (M185 probe gotcha).
 */
export function readSidebarRegionAnimations(
  page: Page,
): Promise<SidebarRegionAnimationDescriptor[]> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".sidebar-region");
    if (!region) {
      throw new Error("Missing .sidebar-region");
    }
    const describe = (root: string, animations: Animation[]) =>
      animations.map((animation) => {
        const timing = animation.effect?.getTiming();
        const duration = timing?.duration ?? 0;
        return {
          root,
          property: (animation as CSSTransition).transitionProperty ?? "unknown",
          durationMs: typeof duration === "number" || typeof duration === "string" ? duration : 0,
          easing: String(timing?.easing ?? ""),
          playState: animation.playState,
        };
      });
    const found = describe("region", region.getAnimations());
    const side = region.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
    if (side) {
      found.push(...describe("side", side.getAnimations()));
    }
    const header = region.querySelector<HTMLElement>('[data-region-header="side"]');
    if (header) {
      found.push(...describe("header", header.getAnimations()));
    }
    for (const panel of region.querySelectorAll<HTMLElement>("[data-panel-slot] > *")) {
      if (panel.shadowRoot) {
        found.push(
          ...describe(`shadow:${panel.getAttribute("data-panel-slot") ?? panel.localName}`, [
            ...panel.shadowRoot.getAnimations(),
          ]),
        );
      }
    }
    return found;
  });
}

/** Waits for a quiet region (no animations, stable side width) and returns it. */
export function waitForSidebarRegionSettled(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const region = document.querySelector<HTMLElement>(".sidebar-region");
    if (!region) {
      throw new Error("Missing .sidebar-region");
    }
    let stable = 0;
    let lastWidth = -1;
    for (let frame = 0; frame < 180; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const side = region.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const width = side?.getBoundingClientRect().width ?? 0;
      const quiet = region.getAnimations().length === 0 && width === lastWidth;
      stable = quiet ? stable + 1 : 0;
      lastWidth = width;
      if (stable >= 3) {
        return width;
      }
    }
    throw new Error("Sidebar region did not settle");
  });
}

/** Waits until the side track's drawn width enters the requested band. */
export async function waitForSidebarSideWidth(
  page: Page,
  band: { above?: number; below?: number },
): Promise<void> {
  await page.waitForFunction(
    ({ above, below }) => {
      const region = document.querySelector<HTMLElement>(".sidebar-region");
      const side = region?.querySelector<HTMLElement>('[data-region="side"]:not([hidden])');
      const width = side?.getBoundingClientRect().width ?? 0;
      return (above === undefined || width > above) && (below === undefined || width < below);
    },
    band,
    { timeout: 5_000, polling: "raf" },
  );
}

export async function failNextDeviceIdentityMint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    let identityMintFailed = false;
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      configurable: true,
      value(array: Uint8Array<ArrayBuffer>) {
        if (!identityMintFailed) {
          identityMintFailed = true;
          throw new Error("device identity unavailable");
        }
        Object.defineProperty(globalThis.crypto, "getRandomValues", {
          configurable: true,
          value: getRandomValues,
        });
        getRandomValues(array);
        return array;
      },
    });
  });
}

export async function openChatSidePanelType(page: Page, label: string): Promise<void> {
  const panel = page.locator(".sidebar-region__right-runtime .side-panel");
  if (
    !(await panel.locator('[data-region-header="side"]').isVisible()) &&
    !(await panel.locator(".side-panel-empty--selector").isVisible())
  ) {
    await page.locator(".chat-side-panel-toggle").click();
  }
  // An empty panel offers its type list; a populated one offers the header "+" menu,
  // and only one of the two ever exists. The toggle above renders asynchronously, so
  // settle on whichever surface arrives before branching — probing first would read
  // an unrendered panel as populated and then wait forever for a "+" that never comes.
  await panel.locator(".side-panel-empty__types, .side-panel__header-tabs").first().waitFor();
  const emptyChoice = panel.locator(".side-panel-empty__type").filter({ hasText: label });
  if ((await emptyChoice.count()) > 0) {
    await emptyChoice.click();
    return;
  }
  await panel.getByRole("button", { name: "Add side panel tab" }).click();
  await panel.locator("wa-dropdown-item").filter({ hasText: label }).click();
}

export async function focusChatSidePanel(page: Page): Promise<void> {
  await page.locator(".chat-panel-swap").click();
  await page
    .locator(".chat-pane__header")
    .getByRole("button", { name: "Focus", exact: true })
    .click();
  await page.getByRole("button", { name: "Restore split", exact: true }).waitFor();
}

export async function restoreChatAsMain(page: Page): Promise<void> {
  const side = page.locator('[data-region-header="side"]');
  await side.locator('wa-tab[panel="conversation"]').click();
  await page.locator(".chat-panel-swap").click();
  await page.locator('.sidebar-region__primary[data-region="main"]').waitFor();
}

export async function dockChatSidePanel(
  page: Page,
  dock: "left" | "right" | "bottom",
): Promise<void> {
  const menu = page.locator(".chat-panel-layout-menu");
  await menu.getByRole("button", { name: "Layout", exact: true }).click();
  await menu.locator(`wa-dropdown-item[value="${dock}"]`).click();
  await page.locator(`.sidebar-region--${dock}`).waitFor();
}

export async function activateChatHeaderPanelAction(page: Page, label: string): Promise<void> {
  await page.locator(".chat-header-session-menu__trigger").click();
  const menu = page.locator("openclaw-chat-header-session-menu");
  const action = menu
    .locator('wa-dropdown-item[value^="quick:panels:"]')
    .filter({ hasText: label });
  if (!(await action.isVisible())) {
    const panels = menu.locator(".session-menu__text").filter({ hasText: /^Panels$/ });
    if ((await menu.locator("wa-dropdown.chat-header-session-menu--compact").count()) > 0) {
      await panels.click();
    } else {
      await panels.hover();
    }
  }
  await action.waitFor({ state: "visible" });
  await action.click();
  await page.waitForFunction(() => {
    const dropdown = document.querySelector("openclaw-chat-header-session-menu wa-dropdown");
    // Web Awesome clears `open` before its hide animation; reopening while the popup is active
    // skips showMenu setup and can let the previous close hide the newly opened submenu.
    const popup = dropdown?.shadowRoot?.querySelector("wa-popup");
    return (
      (!dropdown || Reflect.get(dropdown, "open") !== true) &&
      (!popup || !Reflect.get(popup, "active"))
    );
  });
  await action.waitFor({ state: "hidden" });
}
