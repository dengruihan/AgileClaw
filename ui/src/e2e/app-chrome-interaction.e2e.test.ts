// Control UI tests cover the canonical scrollbar profile and native-style text selection.
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI app chrome interaction mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("app-chrome-interaction");
  }
});

async function dragAcross(page: Page, locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a visible text-selection target");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(3, box.width - 2), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

async function readFocusOutline(locator: Locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: styles.outlineStyle,
    };
  });
}

async function readShellNavGeometry(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    const nav = document.querySelector<HTMLElement>(".shell-nav");
    const content = document.querySelector<HTMLElement>("#control-ui-main");
    if (!shell || !content) {
      throw new Error("Missing shell navigation surface");
    }
    return {
      expandedWidth: getComputedStyle(shell).getPropertyValue("--shell-nav-expanded-width").trim(),
      navInert: nav?.inert ?? false,
      navWidth: nav?.getBoundingClientRect().width ?? 0,
      contentWidth: content.getBoundingClientRect().width,
      shellWidth: shell.clientWidth,
    };
  });
}

async function readFirstSessionTitleGeometry(page: Page) {
  return page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(".sidebar-recent-session__name");
    if (!title) {
      throw new Error("Missing sidebar session title");
    }
    return { clientWidth: title.clientWidth, scrollWidth: title.scrollWidth };
  });
}

const LONG_SESSION_TITLE =
  "Investigate sidebar width motion where historical session titles keep their final expanded width while the rail changes size";

function buildLongTitleSessionRows(count: number) {
  const base = Date.parse("2026-11-14T10:00:00Z");
  return [
    createControlUiSessionRow("agent:main:main", `${LONG_SESSION_TITLE} (main)`, base),
    ...Array.from({ length: count }, (_value, index) =>
      createControlUiSessionRow(
        `agent:main:s${index}`,
        `${LONG_SESSION_TITLE} #${index}`,
        base - (index + 1) * 60_000,
      ),
    ),
  ];
}

async function captureUiProof(
  page: Page,
  fileName: string,
  // Mid-motion proofs must keep the paused animation state; "disabled" would
  // fast-forward the held effect to its end before the shutter.
  animations: "allow" | "disabled" = "disabled",
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({
    animations,
    path: path.join(uiProofArtifactDir, fileName),
  });
}

suite.define(() => {
  it("toggles the desktop nav with focus and sidebar entries intact", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, { sessions: buildLongTitleSessionRows(6) });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".sidebar-recent-session").first().waitFor();

        const newSessionAction = page.locator(
          "openclaw-app-sidebar .sidebar-primary-actions .sidebar-new-session-action",
        );
        await newSessionAction.waitFor({ state: "visible" });
        const titleBaseline = await readFirstSessionTitleGeometry(page);
        expect(titleBaseline.scrollWidth).toBeGreaterThan(titleBaseline.clientWidth);

        await page.locator(".sidebar-brand__collapse").click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(1);
        await expect
          .poll(async () => (await readShellNavGeometry(page)).navWidth)
          .toBeLessThan(1.5);
        // Focus follows the settled collapse onto the only visible chrome control.
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.classList.contains("shell-chrome-controls__nav-toggle") ??
                false,
            ),
          )
          .toBe(true);
        expect(await page.locator(".shell-chrome-controls button").count()).toBe(1);
        expect(await page.locator(".shell-chrome-controls__new-thread").count()).toBe(0);
        expect(await page.locator(".sidebar-attention--floating").count()).toBe(0);
        await captureUiProof(page, "collapsed-toggle-only.png");

        await page.locator(".shell-chrome-controls__nav-toggle").click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(0);
        await expect
          .poll(async () => (await readShellNavGeometry(page)).navWidth)
          .toBeGreaterThan(257.5);
        await newSessionAction.waitFor({ state: "visible" });
        // Re-expanding keeps the long-title row geometry and its inert state.
        expect(await readFirstSessionTitleGeometry(page)).toEqual(titleBaseline);
        const expanded = await readShellNavGeometry(page);
        expect(expanded.navInert).toBe(false);
        expect(expanded.navWidth).toBe(Number.parseFloat(expanded.expandedWidth));

        // A persisted custom rail width drives the same toggle.
        const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
        await page.evaluate(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ navWidth: 320 }));
          },
          { key: settingsKey },
        );
        await page.reload();
        await page.locator(".sidebar-recent-session").first().waitFor();
        const customBaseline = await readFirstSessionTitleGeometry(page);
        expect((await readShellNavGeometry(page)).navWidth).toBe(320);

        await page.locator(".sidebar-brand__collapse").click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(1);
        await expect
          .poll(async () => (await readShellNavGeometry(page)).navWidth)
          .toBeLessThan(1.5);
        await page.locator(".shell-chrome-controls__nav-toggle").click();
        await expect.poll(() => page.locator(".shell--nav-collapsed").count()).toBe(0);
        await expect
          .poll(async () => (await readShellNavGeometry(page)).navWidth)
          .toBeGreaterThan(319.5);
        await newSessionAction.waitFor({ state: "visible" });
        const reexpanded = await readShellNavGeometry(page);
        // The expand transition ends on the persisted 320px rail; allow
        // subpixel sampling if the poll caught the final frame.
        expect(reexpanded.navWidth).toBeGreaterThan(319.5);
        expect(reexpanded.navWidth).toBeLessThan(320.5);
        expect(reexpanded.navInert).toBe(false);
        expect(await readFirstSessionTitleGeometry(page)).toEqual(customBaseline);
      },
    );
  });

  it("keeps canonical scrollbars without horizontal model-picker overflow and preserves selection", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Selectable transcript content\n\nRead [example.ts](/tmp/example.ts) for details.",
                },
              ],
            },
          ],
          models: [
            {
              contextWindow: 1_000_000,
              id: "gpt-5.6-sol-openclaw",
              name: "openai/gpt-5.6-sol-openclaw",
              provider: "openai",
            },
            ...Array.from({ length: 24 }, (_value, index) => ({
              id: `scroll-model-${index + 1}`,
              name: `Scroll Model ${index + 1}`,
              provider: "openai",
            })),
          ],
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const transcript = page.getByText("Selectable transcript content", { exact: true });
        await transcript.waitFor();
        await page.locator('[data-chat-model-select="true"]').click();
        const modelOptions = page.locator(".chat-controls__model-options");
        await expect.poll(() => modelOptions.isVisible()).toBe(true);
        const chatStyles = await page.evaluate(() => {
          const sidebar = document.querySelector<HTMLElement>(".sidebar");
          const sessions = document.querySelector<HTMLElement>(".sidebar-sessions__scroll");
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const modelPicker = document.querySelector<HTMLElement>(".chat-controls__model-options");
          if (!sidebar || !sessions || !thread || !modelPicker) {
            throw new Error("Missing chat interaction surface");
          }
          return {
            chatSelection: getComputedStyle(thread).userSelect,
            chatScrollbar: getComputedStyle(thread, "::-webkit-scrollbar").width,
            sidebarSelection: getComputedStyle(sidebar).userSelect,
            hiddenSidebarScrollbar: getComputedStyle(sessions, "::-webkit-scrollbar").width,
            modelPickerScrollbar: getComputedStyle(modelPicker, "::-webkit-scrollbar").width,
            modelPickerOverflowX: getComputedStyle(modelPicker).overflowX,
            modelPickerHorizontalOverflow: modelPicker.scrollWidth - modelPicker.clientWidth,
          };
        });
        // Canonical scrollbars stay visible elsewhere; the session well hides
        // its platform scrollbar and uses its own draggable rail instead.
        expect(chatStyles).toEqual({
          chatSelection: "text",
          chatScrollbar: "12px",
          sidebarSelection: "none",
          hiddenSidebarScrollbar: "0px",
          modelPickerScrollbar: "12px",
          modelPickerOverflowX: "hidden",
          modelPickerHorizontalOverflow: 0,
        });
        await page.keyboard.press("Escape");
        expect(await dragAcross(page, transcript)).toContain("Selectable transcript");
        const fileLink = page.getByRole("button", { name: "example.ts", exact: true });
        expect(await fileLink.evaluate((element) => getComputedStyle(element).userSelect)).toBe(
          "text",
        );
        const thread = page.locator(".chat-thread");
        expect(await readFocusOutline(thread)).toMatchObject({
          focusVisible: false,
          outlineStyle: "none",
        });
        await captureUiProof(page, "01-chat-selectable-transcript.png");

        await thread.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => thread.evaluate((element) => element !== document.activeElement))
          .toBe(true);
        await page.keyboard.press("Shift+Tab");
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element === document.activeElement && element.matches(":focus-visible"),
            ),
          )
          .toBe(true);
        const focusedOutline = await readFocusOutline(thread);
        expect(focusedOutline).toMatchObject({
          focusVisible: true,
          outlineStyle: "none",
        });
        await captureUiProof(page, "02-chat-thread-keyboard-focus.png");

        await page.setViewportSize({ height: 650, width: 1440 });
        // Appearance renders schema-independent theme/UI sections that overflow
        // 650px even against the mock gateway's tiny config fixture; General
        // became short enough to fit once the host panel moved to Gateway.
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        const { search: settingsSearch, sidebar: settingsSidebar } =
          await waitForControlUiSettingsTakeover(page);
        const settingsTitle = settingsSidebar.locator(".settings-sidebar__title");
        const content = page.locator(".content");
        await expect
          .poll(() => content.evaluate((element) => element.scrollHeight))
          .toBeGreaterThan(await content.evaluate((element) => element.clientHeight));

        const settingsStyles = await page.evaluate(() => {
          const contentNode = document.querySelector<HTMLElement>(".content");
          const nav = document.querySelector<HTMLElement>(".settings-sidebar__nav");
          const search = document.querySelector<HTMLElement>(".settings-sidebar__search-input");
          const sidebar = document.querySelector<HTMLElement>(".settings-sidebar");
          if (!contentNode || !nav || !search || !sidebar) {
            throw new Error("Missing settings interaction surface");
          }
          return {
            contentScrollbar: getComputedStyle(contentNode, "::-webkit-scrollbar").width,
            contentSelection: getComputedStyle(contentNode).userSelect,
            inputSelection: getComputedStyle(search).userSelect,
            sidebarScrollbar: getComputedStyle(nav, "::-webkit-scrollbar").width,
            sidebarSelection: getComputedStyle(sidebar).userSelect,
          };
        });
        expect(settingsStyles).toEqual({
          contentScrollbar: "12px",
          contentSelection: "auto",
          inputSelection: "text",
          sidebarScrollbar: "12px",
          sidebarSelection: "none",
        });

        await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
        expect(await dragAcross(page, settingsTitle)).toBe("");
        const sectionTitle = page.locator(".settings-section__heading").first();
        expect(await dragAcross(page, sectionTitle)).not.toBe("");
        const toggleRow = page.locator(".settings-row--toggle").first();
        await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
        expect(await dragAcross(page, toggleRow.locator(".settings-row__title"))).toBe("");
        await settingsSearch.selectText();
        expect(
          await settingsSearch.evaluate(
            (element) =>
              element instanceof HTMLInputElement &&
              element.selectionStart === 0 &&
              element.selectionEnd === element.value.length,
          ),
        ).toBe(true);
        await content.evaluate((element) => {
          element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
        });
        await captureUiProof(page, "03-settings-contextual-scrollbars.png");

        const usageError = "Unknown system error -122, write";
        await gateway.setMethodResponse("sessions.usage", {
          __mockError: { code: "UNAVAILABLE", message: usageError },
        });
        await gateway.setMethodResponse("usage.cost", {
          updatedAt: Date.now(),
          days: 1,
          daily: [],
          totals: {},
        });
        await gateway.setMethodResponse("usage.status", {
          updatedAt: Date.now(),
          providers: [],
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        const usageErrorCallout = page.locator(".usage-callout.callout.danger");
        await usageErrorCallout.waitFor();
        expect(await usageErrorCallout.textContent()).toContain(usageError);
        expect(
          await usageErrorCallout.evaluate((element) => getComputedStyle(element).userSelect),
        ).toBe("text");
        await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
        expect(await dragAcross(page, usageErrorCallout)).toContain(usageError);
        await captureUiProof(page, "04-usage-selectable-error.png");
      },
    );
  });

  it("resolves the scrollbar thumb from theme tokens and captures dark/light proof", async () => {
    const thumbColorByScheme: Record<"dark" | "light", string> = { dark: "", light: "" };
    for (const colorScheme of ["dark", "light"] as const) {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Selectable transcript content" }],
              },
            ],
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
              ...Array.from({ length: 24 }, (_value, index) => ({
                id: `scroll-model-${index + 1}`,
                name: `Scroll Model ${index + 1}`,
                provider: "openai",
              })),
            ],
          });

          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          await page.getByText("Selectable transcript content", { exact: true }).waitFor();
          thumbColorByScheme[colorScheme] = await page.evaluate(
            () => getComputedStyle(document.body, "::-webkit-scrollbar-thumb").backgroundColor,
          );
          // Chat transcript + session sidebar together, before opening anything.
          await captureUiProof(page, `chat-transcript-sidebar-${colorScheme}.png`);

          // The headline complaint surface: the light-DOM chat model picker.
          await page.locator('[data-chat-model-select="true"]').click();
          const modelOptions = page.locator(".chat-controls__model-options");
          await expect.poll(() => modelOptions.isVisible()).toBe(true);
          await captureUiProof(page, `model-picker-${colorScheme}.png`);
          await page.keyboard.press("Escape");

          // The shadow-DOM lane: a Web Awesome ::part() menu picks up the same
          // profile through the grouped rule in base.css.
          const composer = page.locator(".agent-chat__input");
          await composer.getByRole("button", { name: "Add attachment" }).click();
          const capabilityMenu = composer.locator("wa-dropdown.agent-chat__capability-menu");
          await expect
            .poll(() =>
              capabilityMenu.evaluate((node) => (node as HTMLElement & { open: boolean }).open),
            )
            .toBe(true);
          // Regression guard: base.css's ::-webkit-scrollbar* rules do not cross
          // a shadow boundary on their own. Only the grouped ::part() rule gives
          // this menu's shadow-root scrollbar the canonical width and a real
          // thumb color instead of silently falling back to the UA default.
          const shadowScrollbar = await capabilityMenu.evaluate((node) => {
            const part = (node as HTMLElement).shadowRoot?.querySelector('[part~="menu"]');
            if (!part) {
              return null;
            }
            return {
              width: getComputedStyle(part, "::-webkit-scrollbar").width,
              thumbBackground: getComputedStyle(part, "::-webkit-scrollbar-thumb").backgroundColor,
            };
          });
          expect(shadowScrollbar).toEqual({ width: "12px", thumbBackground: expect.any(String) });
          expect(shadowScrollbar?.thumbBackground).not.toBe("rgba(0, 0, 0, 0)");
          await captureUiProof(page, `capability-menu-shadow-dom-${colorScheme}.png`);

          // Genericity guard, not a second sample of the menu above: base.css
          // reaches these parts through bare wa-dropdown/wa-select/wa-popover
          // selectors, so every Web Awesome scroll part rendered on this page
          // must report the canonical width -- including the ones no stylesheet
          // names. A class allowlist would leave some at the platform default.
          const shadowScrollbarWidths = await page.evaluate(() => {
            // One part per host tag, matching the base.css rule exactly: sampling
            // whichever part came first would read a part that rule never targets.
            const partSelectorByTag: Record<string, string> = {
              "WA-DROPDOWN": '[part~="menu"]',
              "WA-POPOVER": '[part~="body"]',
              "WA-SELECT": '[part~="listbox"]',
            };
            const hosts = document.querySelectorAll("wa-dropdown, wa-select, wa-popover");
            return Array.from(hosts, (host) => {
              const partSelector = partSelectorByTag[host.tagName];
              const part = partSelector ? host.shadowRoot?.querySelector(partSelector) : null;
              return part ? getComputedStyle(part, "::-webkit-scrollbar").width : null;
            }).filter((width): width is string => width !== null);
          });
          expect(shadowScrollbarWidths.length).toBeGreaterThan(1);
          expect([...new Set(shadowScrollbarWidths)]).toEqual(["12px"]);
        },
      );
    }
    // Same source (--muted), different value per mode: the token derivation
    // covers dark and light without a hand-written color pair.
    expect(thumbColorByScheme.dark).not.toBe(thumbColorByScheme.light);
    expect(thumbColorByScheme.dark).not.toBe("");
    expect(thumbColorByScheme.light).not.toBe("");
  });
});
