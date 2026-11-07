import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  type MockGatewayControls,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  expectAppArtwork,
  expectComposerSurface,
  expectMobileComposer,
  readArtwork,
} from "./theme-background.test-support.ts";

const styleCases = [
  { mode: "dark", resolved: "phosphor" },
  { mode: "light", resolved: "phosphor-light" },
] as const;

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({ name: "Control UI app style artwork" });

function styleConfig(mode: "dark" | "light" | "system") {
  const config = {
    ui: { prefs: { themeMode: mode } },
  };
  const hash = `style-background-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function changeMode(
  page: Page,
  gateway: MockGatewayControls,
  selection: { mode: "dark" | "light"; resolved: string },
) {
  // Exercise the live preference-refresh boundary, not synthetic root attributes.
  // A synced mode change must repaint the app without resetting a mounted draft.
  const configGets = (await gateway.getRequests("config.get")).length;
  await gateway.setMethodResponse("config.get", styleConfig(selection.mode));
  await gateway.emitGatewayEvent("config.changed", {});
  await expect
    .poll(async () => (await gateway.getRequests("config.get")).length)
    .toBeGreaterThan(configGets);
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(selection.resolved);
  await expect
    .poll(() => page.locator("html").getAttribute("data-theme-mode"))
    .toBe(selection.mode);
}

async function captureProof(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(suite.artifactDir, `${name}.png`),
  });
}

suite.define(() => {
  it("shares one readable app canvas across new, chat, and settings without losing drafts", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "example/demo",
          models: [{ id: "demo", name: "Demo model", provider: "example" }],
          methodResponses: { "config.get": styleConfig("dark") },
          historyMessages: [
            {
              role: "user",
              content: [{ type: "text", text: "Help me organize a focused afternoon." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Start with one meaningful task. Close unrelated tabs and leave space for a short break.\n\n### A simple plan\n- Review the open questions.\n- Work through the most important decision.\n- Write down the next step before you finish.",
                },
              ],
            },
            {
              role: "user",
              content: [{ type: "text", text: "Keep the plan practical and easy to revisit." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "A useful plan leaves room to think. Keep your notes brief, make the next action specific, and adjust the schedule when new information arrives.\n\nYou can return to this conversation whenever you need the context.",
                },
              ],
            },
          ],
        });
        const images = new Map<string, string>();
        const decoded = new Set<string>();
        for (const route of ["new", "chat", "settings/appearance"] as const) {
          const url =
            route === "chat"
              ? controlUiSessionUrl(suite.server.baseUrl, "agent:main:main")
              : `${suite.server.baseUrl}${route}`;
          await page.goto(url);
          await gateway.waitForRequest("config.get");
          if (route === "chat") {
            await page
              .getByText("You can return to this conversation whenever you need the context.", {
                exact: true,
              })
              .waitFor({ state: "visible" });
          }
          const shell = page.locator(".shell");
          const composer =
            route === "settings/appearance" ? null : page.locator(".agent-chat__input");
          const textarea = composer?.locator("textarea");
          const draft = `An unsent ${route} draft stays here while the mode changes.`;
          if (textarea) {
            await textarea.fill(draft);
          } else {
            await page.locator(".settings-section__desc").first().waitFor({ state: "visible" });
          }
          for (const selection of styleCases) {
            await changeMode(page, gateway, selection);
            for (const viewport of ["desktop", "mobile"] as const) {
              await page.setViewportSize(
                viewport === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 },
              );
              if (textarea && composer) {
                await textarea.click();
                expect(await textarea.inputValue()).toBe(draft);
                await expectComposerSurface(composer);
                if (viewport === "mobile") {
                  await expectMobileComposer(composer);
                }
              }
              const label = `${selection.resolved}-${route.replace("/", "-")}-${viewport}`;
              const artwork = await readArtwork(shell);
              expectAppArtwork(artwork, label);
              expect
                .soft(artwork.canvasContrast, `${label}: muted text on app artwork`)
                .toBeGreaterThanOrEqual(4.5);
              if (composer) {
                expect
                  .soft(
                    artwork.composerContrast,
                    `${label}: placeholder contrast (opaque reference ${artwork.opaqueComposerContrast})`,
                  )
                  .toBeGreaterThanOrEqual(4.5);
              }
              if (route === "chat") {
                expect(
                  artwork.transcriptContrast,
                  `${label}: conversation text on artwork`,
                ).toBeGreaterThanOrEqual(4.5);
              }
              if (route === "new" && viewport === "desktop") {
                images.set(selection.resolved, artwork.backgroundImage);
                decoded.add(artwork.pixels);
              } else {
                expect(artwork.backgroundImage, label).toBe(images.get(selection.resolved));
              }
              await captureProof(page, label);
            }
          }
          if (composer && textarea) {
            // Glass must not obstruct real controls on either composer surface.
            await composer.getByRole("button", { name: "Add attachment", exact: true }).click();
            await composer
              .getByRole("menuitem", { name: "File", exact: true })
              .waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
          }
          const background = () =>
            shell.evaluate((element) => getComputedStyle(element).backgroundImage);
          for (const media of [
            { contrast: "more", forcedColors: "none" },
            { contrast: "no-preference", forcedColors: "active" },
          ] as const) {
            await page.emulateMedia(media);
            await expect.poll(background).toBe("none");
            if (composer && textarea) {
              await expectComposerSurface(composer, true);
              expect(await textarea.inputValue()).toBe(draft);
            }
          }
          await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" });
          await expect.poll(background).toBe(images.get("phosphor-light"));
          if (composer && textarea) {
            // Playwright's media options do not expose reduced transparency;
            // exercise the real browser media query through Chromium's protocol.
            const session = await context.newCDPSession(page);
            try {
              await session.send("Emulation.setEmulatedMedia", {
                features: [
                  { name: "prefers-color-scheme", value: "light" },
                  { name: "prefers-reduced-transparency", value: "reduce" },
                ],
              });
              expect(
                await page.evaluate(
                  () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
                ),
              ).toBe(true);
              await expectComposerSurface(composer, true);
              expect(await background()).toBe(images.get("phosphor-light"));
              expect(await textarea.inputValue()).toBe(draft);
            } finally {
              await session.send("Emulation.setEmulatedMedia", { features: [] });
              await session.detach();
            }
          }
          await gateway.setMethodResponse("config.get", styleConfig("system"));
          await gateway.emitGatewayEvent("config.changed", {});
          for (const mode of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: mode });
            const resolved = mode === "dark" ? "phosphor" : "phosphor-light";
            await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
            expect(await background()).toBe(images.get(resolved));
            if (composer && textarea) {
              await expectComposerSurface(composer);
              expect(await textarea.inputValue()).toBe(draft);
            }
          }
          await page.setViewportSize({ width: 1440, height: 900 });
        }
        expect(new Set(images.values()).size).toBe(styleCases.length);
        expect(decoded.size).toBe(styleCases.length);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
