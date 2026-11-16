import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI continuous corners" });

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string | undefined;

function artifact(name: string) {
  proofDir ??= createControlUiE2eArtifactDir("continuous-corners");
  return path.join(proofDir, name);
}

async function captureProof(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: artifact(name) });
}

type Corner = { radius: string; shape: string };

async function readCorner(page: Page, selector: string): Promise<Corner> {
  return await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        radius: style.borderTopLeftRadius,
        shape: style.getPropertyValue("corner-shape"),
      };
    });
}

/** Shadow-internal probe: the shared Lit rule is the only thing that can reach it. */
async function readShadowCorner(page: Page, host: string, selector: string): Promise<Corner> {
  return await page.evaluate(
    ({ host: hostSelector, selector: innerSelector }) => {
      const shadow = document.querySelector(hostSelector)?.shadowRoot;
      const element = shadow?.querySelector(innerSelector);
      if (!element) {
        throw new Error(`Missing ${innerSelector} in ${hostSelector}'s shadow root`);
      }
      const style = getComputedStyle(element);
      return {
        radius: style.borderTopLeftRadius,
        shape: style.getPropertyValue("corner-shape"),
      };
    },
    { host, selector },
  );
}

/** Pointer hit testing follows the painted corner, so this is user-visible proof. */
async function probeCornerHit(page: Page) {
  return await page.evaluate(() => {
    const make = (shape: string | null, left: number) => {
      const element = document.createElement("div");
      element.style.cssText = [
        "position:fixed",
        "top:24px",
        `left:${left}px`,
        "width:80px",
        "height:80px",
        "background:rgb(200, 30, 30)",
        "border-radius:25px",
        "z-index:2147483647",
        shape ? `corner-shape:${shape}` : "",
      ].join(";");
      document.body.append(element);
      return element;
    };
    // The styled probe inherits the app contract (no inline corner-shape); the
    // control probe forces today's circular arc.
    const styled = make(null, 0);
    const circular = make("round", 120);
    const hits = (element: HTMLElement, inset: number) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.left + inset, box.top + inset) === element;
    };
    const result = {
      circularCornerHit: hits(circular, 6),
      circularInteriorHit: hits(circular, 25),
      styledCornerHit: hits(styled, 6),
      styledInteriorHit: hits(styled, 25),
    };
    styled.remove();
    circular.remove();
    return result;
  });
}

suite.define(() => {
  it("applies one curvature contract to the shell, shadow chrome, and Web Awesome panels", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await page.locator(".agent-chat__input").waitFor({ state: "visible" });

        // The canonical tokens stay canonical where embedded documents read
        // them; the app consumes the compensated chain.
        expect(
          await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const body = document.createElement("div");
            body.style.borderTopLeftRadius = "var(--radius-md)";
            document.body.append(body);
            const appRadius = getComputedStyle(body).borderTopLeftRadius;
            body.remove();
            return { appRadius, rootRadius: root.getPropertyValue("--radius-md").trim() };
          }),
        ).toEqual({ appRadius: "12.5px", rootRadius: "10px" });

        expect({
          composer: await readCorner(page, ".agent-chat__input"),
          navItem: await readCorner(page, ".nav-item"),
          sessionsWell: await readCorner(page, ".sidebar-sessions"),
          shellPlate: await readCorner(page, ".shell"),
        }).toEqual({
          composer: { radius: "25px", shape: "superellipse(1.5)" },
          navItem: { radius: "12.5px", shape: "superellipse(1.5)" },
          // Authored pixel radius below the token ladder: curvature only.
          sessionsWell: { radius: "10px", shape: "superellipse(1.5)" },
          shellPlate: { radius: "25px", shape: "superellipse(1.5)" },
        });

        // Fully rounded chrome keeps the circular arc.
        expect(await readCorner(page, ".chat-send-btn")).toEqual({
          radius: "9999px",
          shape: expect.stringMatching(/^(?:round|superellipse\(1\))$/),
        });

        await captureProof(page, "desktop-dark-chat.png");

        await page.keyboard.press("Control+/");
        await page
          .locator("openclaw-keyboard-shortcuts-dialog")
          .getByRole("dialog", { name: "Keyboard shortcuts" })
          .waitFor({ state: "visible" });
        expect({
          dialog: await readShadowCorner(page, "openclaw-keyboard-shortcuts-dialog", ".dialog"),
          close: await readShadowCorner(page, "openclaw-keyboard-shortcuts-dialog", ".close"),
        }).toEqual({
          dialog: { radius: "14px", shape: "superellipse(1.5)" },
          close: { radius: "6px", shape: "superellipse(1.5)" },
        });
        await captureProof(page, "desktop-dark-shortcuts.png");
        await page.keyboard.press("Control+/");
        await expect
          .poll(() =>
            page
              .locator("openclaw-keyboard-shortcuts-dialog")
              .getByRole("dialog", { name: "Keyboard shortcuts" })
              .isVisible(),
          )
          .toBe(false);

        await page.locator(".agent-chat__input-btn--attach").click();
        const menuPart = page.locator("wa-dropdown.agent-chat__attach-menu [part='menu']");
        await menuPart.waitFor({ state: "visible" });
        expect(await readCorner(page, "wa-dropdown.agent-chat__attach-menu [part='menu']")).toEqual(
          {
            radius: "17.5px",
            shape: "superellipse(1.5)",
          },
        );
        // Web Awesome dropdown rows are light-DOM hosts, so the composer's menu
        // row token reaches them and the universal rule shapes them too.
        expect(await readCorner(page, ".agent-chat__attach-menu-option")).toEqual({
          radius: "12.5px",
          shape: "superellipse(1.5)",
        });
        await captureProof(page, "desktop-dark-attach-menu.png");

        expect(await probeCornerHit(page)).toEqual({
          circularCornerHit: false,
          circularInteriorHit: true,
          styledCornerHit: true,
          styledInteriorHit: true,
        });
      },
    );
  });

  it("keeps phone chrome, circular controls, and settings switches consistent", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".agent-chat__input").waitFor({ state: "visible" });

        // The phone drawer shell is full bleed: its plate radius is zero, so the
        // contract must not introduce a corner where the design has none.
        const drawerToggle = page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first();
        await drawerToggle.click();
        await expect
          .poll(() => page.locator(".shell").evaluate((element) => element.className))
          .toContain("shell--mobile-nav");
        expect(await readCorner(page, ".shell")).toMatchObject({ radius: "0px" });
        await captureProof(page, "mobile-light-drawer.png");

        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await page.locator(".settings-group").first().waitFor({ state: "visible" });
        const switchControl = page.locator("wa-switch [part='control']").first();
        await switchControl.waitFor({ state: "attached" });
        expect(
          await switchControl.evaluate((element) => {
            const style = getComputedStyle(element);
            const height = element.getBoundingClientRect().height;
            return {
              // A full-height pill track, not a fixed token step.
              fullRound: Number.parseFloat(style.borderTopLeftRadius) * 2 >= height,
              shape: style.getPropertyValue("corner-shape"),
            };
          }),
        ).toEqual({
          fullRound: true,
          shape: expect.stringMatching(/^(?:round|superellipse\(1\))$/),
        });
        expect(await readCorner(page, ".settings-group")).toEqual({
          radius: "17.5px",
          shape: "superellipse(1.5)",
        });
        await captureProof(page, "mobile-light-settings.png");
      },
    );
  });
});
