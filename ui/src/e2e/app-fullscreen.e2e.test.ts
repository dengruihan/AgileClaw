import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "app fullscreen",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir = "";
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("app-fullscreen");
  }
});

const chatFullscreenButton = (page: Page) => page.locator(".chat-pane__fullscreen");
const topbarFullscreenButton = (page: Page) => page.locator(".topbar-fullscreen");

async function openChat(page: Page): Promise<void> {
  await installMockGateway(page, { historyMessages: [], agentModel: "openai/synthetic-model" });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
  await waitForControlUiGatewayReady(page);
  await chatFullscreenButton(page).waitFor();
}

/** The shell owns the whole document, never a docked section such as the desktop viewer. */
async function documentIsFullscreen(page: Page): Promise<boolean> {
  return page.evaluate(() => document.fullscreenElement === document.documentElement);
}

/** Innermost focus across shadow roots, where the chat composer lives. */
async function activeElementTag(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    let active: Element | null = document.activeElement;
    while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active?.tagName ?? null;
  });
}

/** The browser fact changes before Lit re-renders the toolbars; wait for both. */
async function expectToolbarFullscreen(
  page: Page,
  button: Locator,
  active: boolean,
): Promise<void> {
  await expect.poll(() => documentIsFullscreen(page)).toBe(active);
  await expect.poll(() => button.getAttribute("aria-pressed")).toBe(active ? "true" : "false");
  await expect
    .poll(() => button.getAttribute("aria-label"))
    .toBe(active ? "Exit fullscreen" : "Enter fullscreen");
}

async function capture(page: Page, name: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(proofDir, `${name}.png`),
  });
}

/** Records F11 default handling and fullscreen transitions on the live document. */
async function installFullscreenKeyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.assign(window, { __openclawFullscreenChanges: 0, __openclawF11Prevented: null });
    const transitions = () => Reflect.get(window, "__openclawFullscreenChanges") as number;
    document.addEventListener("fullscreenchange", () => {
      Object.assign(window, { __openclawFullscreenChanges: transitions() + 1 });
    });
    // Bubble-phase probe: it runs after the shell's capture-phase document owner.
    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        Object.assign(window, { __openclawF11Prevented: event.defaultPrevented });
      }
    });
  });
}

async function readProbe(page: Page, key: string): Promise<unknown> {
  return page.evaluate((name) => Reflect.get(window, name), key);
}

suite.define(() => {
  it("toggles whole-document fullscreen from the chat toolbar and keeps shell state", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openChat(page);
        const button = chatFullscreenButton(page);
        expect(await button.getAttribute("aria-label")).toBe("Enter fullscreen");
        expect(await button.getAttribute("aria-pressed")).toBe("false");
        const route = page.url();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft");
        const sidebar = page.locator(".shell-nav");
        const sidebarBefore = await sidebar.boundingBox();
        expect(sidebarBefore?.width).toBeGreaterThan(0);
        await capture(page, "desktop-idle");

        // Another surface's fullscreen (the remote desktop viewer owns its own
        // section) must not read as shell fullscreen.
        await page.evaluate(() => {
          const probe = document.createElement("button");
          probe.id = "openclaw-fullscreen-probe";
          probe.textContent = "probe";
          probe.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999";
          probe.addEventListener("click", () => {
            const section = document.createElement("section");
            section.id = "openclaw-fullscreen-probe-section";
            document.body.append(section);
            void section.requestFullscreen();
          });
          document.body.append(probe);
        });
        await page.locator("#openclaw-fullscreen-probe").click();
        await expect
          .poll(() => page.evaluate(() => document.fullscreenElement?.id))
          .toBe("openclaw-fullscreen-probe-section");
        expect(await button.getAttribute("aria-pressed")).toBe("false");
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => documentIsFullscreen(page)).toBe(false);
        await page.evaluate(() => {
          document.querySelector("#openclaw-fullscreen-probe")?.remove();
          document.querySelector("#openclaw-fullscreen-probe-section")?.remove();
        });

        await button.click();
        await expectToolbarFullscreen(page, button, true);
        // The sidebar, route, and pane stay in place: only the viewport changed.
        const sidebarAfter = await sidebar.boundingBox();
        expect(sidebarAfter?.width).toBeGreaterThan(0);
        expect(page.url()).toBe(route);
        expect(await page.locator(".chat-pane__header").count()).toBe(1);
        await capture(page, "desktop-entered");

        await button.click();
        await expectToolbarFullscreen(page, button, false);
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.activeElement?.classList.contains("chat-pane__fullscreen"),
            ),
          )
          .toBe(true);
        expect(page.url()).toBe(route);
        // The viewport change never resets the focused input or its draft.
        expect(await composer.inputValue()).toBe("Keep this draft");
        await capture(page, "desktop-exited");
      },
    );
  });

  it("owns F11 for the document and restores focus on external exit", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openChat(page);
        const button = chatFullscreenButton(page);
        await installFullscreenKeyProbe(page);

        await button.focus();
        await page.keyboard.press("F11");
        await expectToolbarFullscreen(page, button, true);
        expect(await readProbe(page, "__openclawF11Prevented")).toBe(true);
        await expect.poll(() => readProbe(page, "__openclawFullscreenChanges")).toBe(1);

        // One press owns one transition: the native browser fullscreen must not
        // run alongside the API request.
        await page.keyboard.press("F11");
        await expectToolbarFullscreen(page, button, false);
        await expect.poll(() => readProbe(page, "__openclawFullscreenChanges")).toBe(2);

        // Escape/browser UI exit outside the app; fullscreenchange syncs the
        // toolbars and focus returns to the control that entered.
        await page.keyboard.press("F11");
        await expectToolbarFullscreen(page, button, true);
        await page.evaluate(() => document.exitFullscreen());
        await expectToolbarFullscreen(page, button, false);
        await expect
          .poll(() =>
            page.evaluate(() =>
              document.activeElement?.classList.contains("chat-pane__fullscreen"),
            ),
          )
          .toBe(true);

        // Entering from the keyboard restores the pre-fullscreen focus instead.
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.focus();
        await page.keyboard.press("F11");
        await expect.poll(() => documentIsFullscreen(page)).toBe(true);
        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => documentIsFullscreen(page)).toBe(false);
        await expect.poll(() => activeElementTag(page)).toBe("TEXTAREA");

        // Modified, repeated, modal, and remote-desktop keys keep their default.
        const ctrlF11 = await page.evaluate(() =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "F11",
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        expect(ctrlF11).toBe(true);
        const repeatedF11 = await page.evaluate(() =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "F11",
              repeat: true,
              bubbles: true,
              cancelable: true,
            }),
          ),
        );
        expect(repeatedF11).toBe(true);
        const modalF11 = await page.evaluate(() => {
          const layer = document.createElement("div");
          const layers = (document.openClawModalLayers ??= new Set<HTMLElement>());
          layers.add(layer);
          const handled = document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "F11", bubbles: true, cancelable: true }),
          );
          layers.delete(layer);
          return handled;
        });
        expect(modalF11).toBe(true);
        const remoteF11 = await page.evaluate(() => {
          const input = document.createElement("textarea");
          input.className = "desktop-keyboard-input";
          document.body.append(input);
          const handled = input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "F11", bubbles: true, cancelable: true }),
          );
          input.remove();
          return handled;
        });
        expect(remoteF11).toBe(true);
        expect(await documentIsFullscreen(page)).toBe(false);
      },
    );
  });

  it("keeps the control unavailable and visible when the browser cannot fullscreen", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(document, "fullscreenEnabled", {
            configurable: true,
            value: false,
          });
        });
        await openChat(page);
        const button = chatFullscreenButton(page);
        expect(await button.getAttribute("aria-label")).toBe(
          "Fullscreen is unavailable in this browser",
        );
        expect(await button.getAttribute("aria-disabled")).toBe("true");
        await button.focus();
        await button.press("Enter");
        await page
          .locator(".app-toast")
          .filter({ hasText: "Fullscreen is unavailable in this browser" })
          .waitFor();

        // Without the API the native shortcut is the only working path, so the
        // shell must leave its default behavior alone.
        await installFullscreenKeyProbe(page);
        await page.keyboard.press("F11");
        await expect.poll(() => readProbe(page, "__openclawF11Prevented")).toBe(false);
        expect(await documentIsFullscreen(page)).toBe(false);
        expect(await readProbe(page, "__openclawFullscreenChanges")).toBe(0);
      },
    );
  });

  it("reports a rejected fullscreen request without changing state", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        await openChat(page);
        await page.evaluate(() => {
          Element.prototype.requestFullscreen = () =>
            Promise.reject(new DOMException("Fullscreen permission denied", "NotAllowedError"));
        });
        const button = chatFullscreenButton(page);
        await button.click();
        await page
          .locator(".app-toast")
          .filter({ hasText: "Could not change fullscreen mode: Fullscreen permission denied" })
          .waitFor();
        expect(await documentIsFullscreen(page)).toBe(false);
        expect(await button.getAttribute("aria-pressed")).toBe("false");
        expect(await button.getAttribute("aria-label")).toBe("Enter fullscreen");
      },
    );
  });

  it("keeps the narrow chat header and topbar controls visible without covering actions", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { height: 844, width: 390 } },
      async ({ page }) => {
        await openChat(page);
        // Plain-browser chat merges the narrow chrome into the pane header.
        expect(await page.locator(".topbar").isVisible()).toBe(false);
        const button = chatFullscreenButton(page);
        await button.waitFor();
        await page.locator(".chat-pane__nav-toggle").waitFor();
        const geometry = await page.evaluate(() => {
          const fullscreen = document
            .querySelector(".chat-pane__fullscreen")
            ?.getBoundingClientRect();
          if (!fullscreen) {
            return null;
          }
          const header = document.querySelector(".chat-pane__header")?.getBoundingClientRect();
          const overlaps = [...document.querySelectorAll(".chat-pane__header-trailing button")]
            .filter((element) => !element.classList.contains("chat-pane__fullscreen"))
            .some((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.left < fullscreen.right &&
                fullscreen.left < rect.right &&
                rect.top < fullscreen.bottom &&
                fullscreen.top < rect.bottom
              );
            });
          return {
            insideHeader:
              Boolean(header) &&
              fullscreen.left >= header.left &&
              fullscreen.right <= header.right &&
              fullscreen.top >= header.top &&
              fullscreen.bottom <= header.bottom,
            overlaps,
            width: Math.round(fullscreen.width),
          };
        });
        expect(geometry?.insideHeader).toBe(true);
        expect(geometry?.overlaps).toBe(false);
        expect(geometry?.width).toBeGreaterThanOrEqual(24);
        expect(geometry?.width).toBeLessThanOrEqual(40);
        await capture(page, "narrow-chat-idle");

        await button.click();
        await expectToolbarFullscreen(page, button, true);
        await capture(page, "narrow-chat-entered");
        await button.click();
        await expectToolbarFullscreen(page, button, false);

        // Non-session routes keep the topbar as the only narrow chrome row.
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiGatewayReady(page);
        const topbarButton = topbarFullscreenButton(page);
        await topbarButton.waitFor();
        expect(
          await page.evaluate(() => {
            const fullscreen = document
              .querySelector(".topbar-fullscreen")
              ?.getBoundingClientRect();
            const topnav = document.querySelector(".topnav-shell")?.getBoundingClientRect();
            if (!fullscreen || !topnav) {
              return null;
            }
            const drawer = document.querySelector(".topbar-nav-toggle")?.getBoundingClientRect();
            return {
              insideTopnav:
                fullscreen.left >= topnav.left &&
                fullscreen.right <= topnav.right &&
                fullscreen.top >= topnav.top &&
                fullscreen.bottom <= topnav.bottom,
              overlapsDrawer:
                Boolean(drawer) &&
                drawer.left < fullscreen.right &&
                fullscreen.left < drawer.right &&
                drawer.top < fullscreen.bottom &&
                fullscreen.top < drawer.bottom,
            };
          }),
        ).toEqual({ insideTopnav: true, overlapsDrawer: false });
        await capture(page, "narrow-topbar-idle");
        await topbarButton.click();
        await expectToolbarFullscreen(page, topbarButton, true);
        await capture(page, "narrow-topbar-entered");
        await topbarButton.click();
        await expectToolbarFullscreen(page, topbarButton, false);
      },
    );
  });

  it("keeps the control in the Chinese narrow chrome", async () => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: "zh-CN",
      viewport: { height: 844, width: 390 },
    });
    try {
      const page = await context.newPage();
      await openChat(page);
      await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("zh-CN");
      // Adjacent chrome proves the Chinese catalog loaded for this document.
      expect(await page.locator(".chat-pane__nav-toggle").getAttribute("aria-label")).toBe(
        "展开侧边栏",
      );
      const button = chatFullscreenButton(page);
      await button.waitFor();
      // The new shell source copies reach zh-CN through the post-merge locale
      // refresh; either the translated copy or its English source is valid here.
      expect(["进入全屏", "Enter fullscreen"]).toContain(await button.getAttribute("aria-label"));
      await capture(page, "narrow-chat.zh-CN");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
