import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/**
 * Focus ownership across the side-conversation cutover: a command opens a real
 * child pane and focuses its composer, while a manually opened rail keeps its
 * own composer focus without stealing the main draft.
 */
const suite = createControlUiE2eSuite({ name: "side conversation focus" });

const PARENT_KEY = "agent:main:run";

async function enterSideCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(".agent-chat__composer-shell textarea").first();
  await input.fill(command);
  await page.locator(".chat-send-btn--send:enabled").first().waitFor({ state: "visible" });
  await input.press("Enter");
}

function scenario() {
  return {
    sessionKey: PARENT_KEY,
    sessions: [
      { key: PARENT_KEY, kind: "direct" as const, label: "Release review", updatedAt: 100 },
      { key: "agent:main:main", kind: "direct" as const, label: "Personal Home", updatedAt: 90 },
    ],
  };
}

function childPane(page: Page): Locator {
  return page.locator("openclaw-chat-pane").nth(1);
}

async function focusedIn(scope: Locator, selector: string): Promise<boolean> {
  return scope
    .locator(selector)
    .evaluate((element) => element.ownerDocument.activeElement === element);
}

suite.define(() => {
  it("opens a child pane from /side and focuses its composer", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      const mainInput = page.locator(".agent-chat__composer-shell textarea").first();

      await enterSideCommand(page, "/side");
      const create = await gateway.waitForRequest("sideConversations.create");
      expect(create.params).toMatchObject({ parentSessionKey: PARENT_KEY });
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
      expect(await mainInput.inputValue()).toBe("");
      // An empty command opens the child composer instead of sending anything.
      expect((await gateway.getRequests("chat.send")).length).toBe(0);
      await expect
        .poll(() => focusedIn(childPane(page), ".agent-chat__composer-shell textarea"))
        .toBe(true);

      await page.keyboard.type("What should I verify?");
      await page.keyboard.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      expect((send.params as { message?: unknown }).message).toBe("What should I verify?");
      expect((send.params as { sessionKey?: unknown }).sessionKey).toMatch(
        /^agent:main:dashboard:side-[0-9a-f]{32}$/,
      );
    });
  });

  it.each(["/btw", "/side"])(
    "routes %s to a child pane without touching the main queue",
    async (command) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
        const mainInput = page.locator(".agent-chat__composer-shell textarea").first();
        await enterSideCommand(page, `${command} summarize this`);
        const send = await gateway.waitForRequest("chat.send");
        expect((send.params as { message?: unknown }).message).toBe("summarize this");
        expect((send.params as { sessionKey?: unknown }).sessionKey).toMatch(
          /^agent:main:dashboard:side-[0-9a-f]{32}$/,
        );
        expect(await mainInput.inputValue()).toBe("");
      });
    },
  );

  it("focuses a manually opened side rail without stealing the main draft", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, scenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      const mainInput = page.locator(".agent-chat__composer-shell textarea").first();
      await mainInput.fill("Main draft stays");

      await page.keyboard.press("Control+Shift+S");
      const railInput = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await expect
        .poll(() =>
          railInput.evaluate((element) => element.ownerDocument.activeElement === element),
        )
        .toBe(true);
      await page.keyboard.type("Side question");
      expect(await railInput.inputValue()).toBe("Side question");
      expect(await mainInput.inputValue()).toBe("Main draft stays");

      await page.keyboard.press("Control+Shift+S");
      await expect(railInput).toBeHidden();
      await page.keyboard.press("Control+Shift+S");
      await expect
        .poll(() =>
          railInput.evaluate((element) => element.ownerDocument.activeElement === element),
        )
        .toBe(true);
      expect(await railInput.inputValue()).toBe("Side question");
    });
  });

  it("keeps the child pane usable at a narrow viewport", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      await enterSideCommand(page, "/side narrow check");
      const send = await gateway.waitForRequest("chat.send");
      const childKey = String((send.params as { sessionKey?: unknown }).sessionKey);
      await expect.poll(() => page.url()).toContain(childKey.split(":").slice(2).join("/"));
      const visible = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expect(visible).toHaveCount(1);
      await expect(visible.locator(".chat-side-conversation-status")).toContainText("Side chat 1");
    });
  });
});
