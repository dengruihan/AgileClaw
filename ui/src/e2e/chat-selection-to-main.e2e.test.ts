import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/**
 * Selected transcript text has two destinations: the main composer attachment
 * list, or a fresh side-conversation child whose composer starts with the quote.
 */
const suite = createControlUiE2eSuite({ name: "Control UI selected text destinations" });

const PARENT_KEY = "agent:main:run";
const selectedText = "Review the deployment checklist.";

async function selectText(text: Locator) {
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
}

function scenario() {
  return {
    sessionKey: PARENT_KEY,
    sessions: [
      { key: PARENT_KEY, kind: "direct" as const, label: "Release review", updatedAt: 100 },
      { key: "agent:main:main", kind: "direct" as const, label: "Personal Home", updatedAt: 90 },
    ],
    historyMessages: [{ role: "assistant", content: [{ type: "text", text: selectedText }] }],
  };
}

async function askInSideChat(page: Page, comment: string) {
  await selectText(page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText }));
  await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Comment", exact: true });
  await editor.getByRole("textbox").fill(comment);
  await editor.getByRole("button", { name: "Save comment", exact: true }).click();
}

function childComposer(page: Page): Locator {
  return page.locator("openclaw-chat-pane").nth(1).locator(".agent-chat__composer-shell textarea");
}

suite.define(() => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    it(`opens a side-conversation child with the quoted passage at ${viewport.width}px`, async () => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
        await askInSideChat(page, "Check the rollback steps.");

        const create = await gateway.waitForRequest("sideConversations.create");
        expect(create.params).toMatchObject({ parentSessionKey: PARENT_KEY });
        await expect(childComposer(page)).toBeVisible();
        await expect
          .poll(() => childComposer(page).inputValue())
          .toContain("Check the rollback steps.");
        const draft = await childComposer(page).inputValue();
        expect(draft).toContain(selectedText);
        expect(draft).toContain(`Source session: ${PARENT_KEY}`);
        // Selection asks stage a child; the parent session is never sent to.
        expect(
          (await gateway.getRequests("chat.send")).filter(
            (request) => (request.params as { sessionKey?: string }).sessionKey === PARENT_KEY,
          ),
        ).toEqual([]);
      });
    });
  }

  it("keeps Add to chat attaching the passage to the main composer", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, scenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      await selectText(page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText }));
      await page.getByRole("button", { name: "Add to chat", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Comment", exact: true });
      await editor.getByRole("textbox").fill("Keep this for the next message.");
      await editor.getByRole("button", { name: "Save comment", exact: true }).click();

      const main = page.locator("openclaw-chat-pane").first();
      await expect(main.locator(".chat-selection-annotations__chip")).toHaveCount(1);
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(1);
      await expect(main.locator(".agent-chat__composer-shell textarea")).toBeEditable();
    });
  });

  it("keeps a main-composer draft while the selected passage opens side chat", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, scenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      const mainComposer = page.locator(".agent-chat__composer-shell textarea").first();
      await mainComposer.fill("Main draft stays");
      await askInSideChat(page, "Explain the rollback.");
      expect(await mainComposer.inputValue()).toBe("Main draft stays");
      await expect.poll(() => childComposer(page).inputValue()).toContain("Explain the rollback.");
    });
  });
});
