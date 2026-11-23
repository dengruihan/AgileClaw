import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/**
 * The Control UI cutover: /side and /btw open a real hidden child session as a
 * split pane, and the first question is admitted to the child, never the parent.
 */
const suite = createControlUiE2eSuite({ name: "side conversation panes" });

const PARENT_KEY = "agent:main:run";
const SIDE_KEY_RE = /^agent:main:dashboard:side-[0-9a-f]{32}$/;

async function enterSideCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(".agent-chat__composer-shell textarea").first();
  await input.fill(command);
  await page.locator(".chat-send-btn--send:enabled").first().waitFor({ state: "visible" });
  await input.press("Enter");
}

function parentScenario() {
  return {
    sessionKey: PARENT_KEY,
    sessions: [
      {
        key: PARENT_KEY,
        kind: "direct" as const,
        label: "Release review",
        updatedAt: 100,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      {
        key: "agent:main:main",
        kind: "direct" as const,
        label: "Personal Home",
        updatedAt: 90,
      },
    ],
    models: [
      { id: "gpt-5.5", name: "gpt-5.5", provider: "openai" },
      { id: "gpt-5.5-mini", name: "gpt-5.5-mini", provider: "openai" },
    ],
  };
}

suite.define(() => {
  it("/side creates a hidden child pane and sends the first question to the child", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, parentScenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));

      await enterSideCommand(page, "/side what changed?");

      const create = await gateway.waitForRequest("sideConversations.create");
      expect(create.params).toMatchObject({ parentSessionKey: PARENT_KEY });

      const send = await gateway.waitForRequest("chat.send");
      const childKey = String((send.params as { sessionKey?: unknown }).sessionKey);
      expect(childKey).toMatch(SIDE_KEY_RE);
      expect((send.params as { message?: unknown }).message).toBe("what changed?");
      // Nothing was admitted to the parent queue.
      expect(
        (await gateway.getRequests("chat.send")).filter(
          (request) => (request.params as { sessionKey?: string }).sessionKey === PARENT_KEY,
        ),
      ).toEqual([]);

      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
      await expect(page.locator(".chat-side-conversation-status")).toBeVisible();
      await expect(page.locator(".chat-side-conversation-status")).toContainText("Side chat 1");
      await expect(page.locator(".chat-side-conversation-status")).toContainText("Worktree");
      await expect(page.locator("openclaw-chat-pane").nth(1)).toContainText("what changed?");
      // The hidden child never becomes a sidebar session row.
      await expect(
        page.locator(`.sidebar-recent-session[data-session-key="${childKey}"]`),
      ).toHaveCount(0);
      await expect.poll(() => page.url()).toContain(childKey.split(":").slice(2).join("/"));
    });
  });

  it("/btw opens a second child pane under the same parent", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, parentScenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));

      await enterSideCommand(page, "/side first?");
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);

      await enterSideCommand(page, "/btw second?");
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(3);

      const sends = (await gateway.getRequests("chat.send")).map(
        (request) => (request.params as { sessionKey?: string }).sessionKey,
      );
      expect(sends).toHaveLength(2);
      expect(new Set(sends).size).toBe(2);
      for (const key of sends) {
        expect(key).toMatch(SIDE_KEY_RE);
      }
      const titles = await page.locator(".chat-side-conversation-status__title").allTextContents();
      expect(titles.map((title) => title.trim())).toEqual(
        expect.arrayContaining(["Side chat 1", "Side chat 2"]),
      );
    });
  });

  it("keeps each child's model independent of the parent", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, parentScenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));

      await enterSideCommand(page, "/side explain the diff");
      const send = await gateway.waitForRequest("chat.send");
      const childKey = String((send.params as { sessionKey?: unknown }).sessionKey);
      await expect(page.locator(".chat-side-conversation-status")).toContainText(
        "Model inherited from the parent",
      );

      const before = (await gateway.getRequests("sessions.patch")).length;
      const childPane = page.locator("openclaw-chat-pane").nth(1);
      const picker = childPane
        .locator(".agent-chat__composer-shell .chat-controls__model-picker")
        .first();
      await picker.locator('[data-chat-model-select="true"]').click();
      const option = picker.locator('[data-chat-model-option="openai/gpt-5.5-mini"]').first();
      await expect(option).toBeVisible();
      await option.click();

      const patch = await gateway.waitForRequest("sessions.patch", { after: before });
      expect((patch.params as { key?: unknown }).key).toBe(childKey);
      expect((patch.params as { model?: unknown }).model).toContain("gpt-5.5-mini");
      // The parent row never took the child's model change.
      expect(
        (await gateway.getRequests("sessions.patch")).some(
          (request) => (request.params as { key?: string }).key === PARENT_KEY,
        ),
      ).toBe(false);
    });
  });

  it("restores the parent and child panes after a refresh", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, parentScenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      await enterSideCommand(page, "/side survives refresh");
      const send = await gateway.waitForRequest("chat.send");
      const childKey = String((send.params as { sessionKey?: unknown }).sessionKey);
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);

      await page.reload();
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
      await expect.poll(() => page.url()).toContain(childKey.split(":").slice(2).join("/"));
      await expect(page.locator(".chat-side-conversation-status")).toContainText("Side chat 1");
      console.log(
        "REFRESH DIAG:",
        JSON.stringify(
          await page.evaluate(() =>
            [...document.querySelectorAll("openclaw-chat-pane")].map((pane) => ({
              key: (pane as unknown as { sessionKey?: string }).sessionKey,
              active: (pane as unknown as { active?: boolean }).active,
              presented: (pane as unknown as { presented?: boolean }).presented,
              currentSessionId: (pane as unknown as { state?: { currentSessionId?: string } }).state
                ?.currentSessionId,
              loading: (pane as unknown as { state?: { chatLoading?: boolean } }).state
                ?.chatLoading,
              htmlLen: pane.innerHTML.length,
              text: (pane.textContent ?? "").replace(/\s+/g, " ").slice(0, 160),
            })),
          ),
        ),
      );
      await expect(
        page.locator("openclaw-chat-pane").nth(0).locator(".agent-chat__composer-shell textarea"),
      ).toBeVisible();
      await expect(page.locator(".chat-side-conversation-status")).toContainText("Side chat 1");
    });
  });
});
