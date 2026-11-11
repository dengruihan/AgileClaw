import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectComposerSurface } from "./theme-background.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer focus",
});

suite.define(() => {
  it("routes agent-menu letters and selection keys to their owners", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", workspace: "/tmp/main" },
              { id: "research", workspace: "/tmp/research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      const trigger = picker.locator(".agent-select__trigger");
      await trigger.waitFor({ state: "visible" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      // Opening initializes the selected row after its animation completes.
      const selected = picker.getByRole("menuitemradio", { name: "main", exact: true });
      await expect
        .poll(() => selected.evaluate((element) => document.activeElement === element))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      const option = picker.getByRole("menuitemradio", { name: "research", exact: true });
      await expect
        .poll(() => option.evaluate((element) => document.activeElement === element))
        .toBe(true);

      await page.keyboard.press("Space");

      await expect
        .poll(() => picker.locator(".agent-select__label").textContent())
        .toBe("research");
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      await expect
        .poll(() =>
          picker
            .locator("wa-dropdown")
            .evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      // The open property clears before the closing popup retires.
      await picker.locator('wa-dropdown-item[aria-label="research"]').waitFor({ state: "hidden" });

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => option.evaluate((element) => document.activeElement === element))
        .toBe(true);

      await page.keyboard.type("r");

      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("r");
    });
  });

  it("protects an open agent dropdown before an item receives focus", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", workspace: "/tmp/main" },
              { id: "research", workspace: "/tmp/research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const composer = page.locator(".new-session-page__message");
      await composer.waitFor({ state: "visible" });

      const result = await page.evaluate(() => {
        const dropdown = document.querySelector<HTMLElement & { open: boolean }>(
          ".new-session-page__select--agent wa-dropdown",
        );
        const main = document.querySelector<HTMLElement>("main");
        if (!dropdown || !main) {
          throw new Error("missing real agent dropdown fixture");
        }
        dropdown.open = true;
        main.focus();
        main.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }),
        );
        return {
          activeTag: document.activeElement?.localName,
          dropdownOpen: dropdown.open,
        };
      });

      expect(result).toEqual({ activeTag: "main", dropdownOpen: true });
      await expect.poll(() => composer.inputValue()).toBe("");
    });
  });

  it("routes printable input from the real Chat context menu to the composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const messageText = "Context menu typing route";
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: messageText }],
            timestamp: 1_000,
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const bubble = page.locator(".chat-bubble").filter({ hasText: messageText });
      await bubble.waitFor();
      await bubble.click({ button: "right" });
      const menuItem = page
        .locator(".chat-reply-context-menu")
        .getByRole("menuitem", { name: "Reply to message", exact: true });
      await menuItem.focus();

      await page.keyboard.type("x");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.inputValue()).toBe("x");
      await expect
        .poll(() => composer.evaluate((element) => document.activeElement === element))
        .toBe(true);
    });
  });

  it("preserves the first character typed outside the new-session composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);

      const composer = page.locator(".new-session-page__message");
      await composer.waitFor({ state: "visible" });
      await page.locator("main").click({ position: { x: 5, y: 5 } });
      await page.keyboard.type("x");

      await expect.poll(() => composer.inputValue()).toBe("x");
      await expect
        .poll(() => composer.evaluate((element) => document.activeElement === element))
        .toBe(true);
    });
  });

  it("keeps remote-control typing out of the chat composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request", "chat.startup", "desktop.observe", "environments.list"],
        methodResponses: {
          "browser.request": {
            cases: [
              {
                match: { method: "GET", path: "/tabs" },
                response: { running: true, tabs: [] },
              },
            ],
          },
          "environments.list": { environments: [] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await composer.waitFor({ state: "visible" });

      for (const [label, selector] of [
        ["Browser", "openclaw-browser-panel"],
        ["Desktop", "openclaw-desktop-panel"],
      ] as const) {
        await openChatSidePanelType(page, label);
        const panel = page.locator(selector);
        await panel.waitFor({ state: "visible" });
        await composer.blur();
        await panel.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "a",
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
        });
        await expect
          .poll(() => composer.evaluate((element) => document.activeElement === element))
          .toBe(false);
      }
    });
  });

  it("keeps the recessed well material stable on neutral focus in dark and light themes", async () => {
    const artifactDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("chat-composer-focus")
        : undefined;
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);

      const parseShadowLayers = (value: string) =>
        value.split(/, (?=color\(|rgba?\()/).map((segment) => {
          const match = segment.match(
            /^(rgba?\([^)]*\)|color\(srgb[^)]*\)) (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px(?: )?(inset)?$/,
          );
          if (!match) {
            throw new Error(`unparsed shadow layer: ${segment}`);
          }
          const numbers = match[1]!.match(/[\d.]+/g)!.map(Number);
          const scale = match[1]!.startsWith("color(srgb") ? 255 : 1;
          return {
            inset: match[6] === "inset",
            rgb: numbers.slice(0, 3).map((channel) => channel * scale),
          };
        });
      const readMaterial = (composer: Locator) =>
        composer.evaluate(async (element) => {
          // Let a focus transition start before awaiting it, so a fade cannot
          // mask a lasting material change.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
          const style = getComputedStyle(element);
          const { width, height } = element.getBoundingClientRect();
          return {
            borderColor: style.borderColor,
            boxShadow: style.boxShadow,
            height,
            width,
          };
        });

      for (const [route, url, composerSelector] of [
        [
          "chat",
          controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
          ".chat-footer .agent-chat__input",
        ],
        ["new", `${suite.server.baseUrl}new`, ".new-session-page__composer .agent-chat__input"],
      ] as const) {
        await page.goto(url);
        if (route === "chat") {
          await gateway.waitForRequest("chat.startup");
        }
        const composer = page.locator(composerSelector);
        const textarea = composer.locator("textarea");
        await composer.waitFor({ state: "visible" });

        for (const theme of ["dark", "light"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
            .toBe(theme);
          const capture = async (state: string) => {
            if (!artifactDir) {
              return;
            }
            await composer.screenshot({
              animations: "disabled",
              path: `${artifactDir}/${route}-${theme}-${state}.png`,
            });
          };

          await textarea.evaluate((element) => element.blur());
          const resting = await readMaterial(composer);
          await expectComposerSurface(composer);
          await capture("resting");

          await textarea.click();
          await expect
            .poll(() => textarea.evaluate((element) => document.activeElement === element))
            .toBe(true);
          const focused = await readMaterial(composer);
          await expectComposerSurface(composer);
          await capture("focused");

          const draft = `focus proof ${route} ${theme}`;
          await page.keyboard.type(draft);
          await expect.poll(() => textarea.inputValue()).toBe(draft);
          await expect
            .poll(() => textarea.evaluate((element) => document.activeElement === element))
            .toBe(true);
          await capture("typed");
          await textarea.fill("");

          const restingLayers = parseShadowLayers(resting.boxShadow);
          const focusedLayers = parseShadowLayers(focused.boxShadow);
          // Focus keeps the seated recess: no deeper carve, no inner rim, no
          // outer ring, and no resize that would move the surface under the
          // caret.
          expect(
            restingLayers.every((layer) => layer.inset),
            `resting shadows stay inset (${route}, ${theme})`,
          ).toBe(true);
          expect(
            focusedLayers.every((layer) => layer.inset),
            `focused shadows stay inset (${route}, ${theme})`,
          ).toBe(true);
          for (const layer of [...restingLayers, ...focusedLayers]) {
            const channelSpread = Math.max(...layer.rgb) - Math.min(...layer.rgb);
            expect(
              channelSpread,
              `the well stays in the neutral ramp (${route}, ${theme})`,
            ).toBeLessThanOrEqual(66);
          }
          expect(focused.boxShadow, `focus keeps the resting well (${route}, ${theme})`).toBe(
            resting.boxShadow,
          );
          expect(
            focused.borderColor.replace(/\s/g, ""),
            `focus keeps no frame (${route}, ${theme})`,
          ).toBe(resting.borderColor.replace(/\s/g, ""));
          expect(
            [focused.width, focused.height],
            `focus keeps the surface size (${route}, ${theme})`,
          ).toEqual([resting.width, resting.height]);
        }
      }
    });
  });
});
