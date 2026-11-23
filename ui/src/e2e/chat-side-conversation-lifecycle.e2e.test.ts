import path from "node:path";
import { expect, type Locator, type Page } from "playwright/test";
import { it } from "vitest";
import type { SideConversationSummary } from "../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/**
 * Side-conversation lifecycle in the Control UI: selection opens a child draft,
 * close/reopen drive the parent handoff chip, and merge/abandon stay manual
 * Gateway transitions with visible outcomes.
 */
const suite = createControlUiE2eSuite({ name: "side conversation lifecycle" });

const PARENT_KEY = "agent:main:run";
const CHILD_KEY = "agent:main:dashboard:side-11111111111111111111111111111111";
const OTHER_CHILD_KEY = "agent:main:dashboard:side-22222222222222222222222222222222";

function conversation(overrides: Partial<SideConversationSummary> = {}): SideConversationSummary {
  return {
    sessionKey: CHILD_KEY,
    sessionId: `session:${CHILD_KEY}`,
    parentSessionKey: PARENT_KEY,
    intentId: "intent-1",
    ordinal: 1,
    state: "open",
    createdAt: 100,
    updatedAt: 100,
    isolation: { filesystem: "worktree", externalState: "shared" },
    worktree: { id: "wt-1", branch: "side/intent-1", path: "/mock/wt-1", baseRef: "abc123" },
    ...overrides,
  };
}

function parentRow(extra: Record<string, unknown> = {}) {
  return {
    key: PARENT_KEY,
    kind: "direct" as const,
    label: "Release review",
    updatedAt: 100,
    model: "gpt-5.5",
    modelProvider: "openai",
    ...extra,
  };
}

function scenario(children: SideConversationSummary[], extra: Record<string, unknown> = {}) {
  return {
    sessionKey: PARENT_KEY,
    sideConversations: children,
    sessions: [parentRow({ sideConversationCount: children.length, ...extra })],
    models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
  };
}

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

async function openSideRail(page: Page): Promise<Locator> {
  await openChatSidePanelType(page, "Side chat");
  return page.locator("openclaw-chat-session-rail");
}

suite.define(() => {
  it("Ask in side chat opens a child pane with the quoted passage as its draft", async () => {
    const artifactDir = createControlUiE2eArtifactDir("side-conversation-selection");
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const passage = "Review the deployment checklist.";
      const gateway = await installMockGateway(page, {
        ...scenario([]),
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: passage }] }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));

      await selectText(page.locator(".chat-bubble .chat-text p").filter({ hasText: passage }));
      await page.getByRole("button", { name: "Ask in side chat", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Comment", exact: true });
      await editor.getByRole("textbox").fill("Check the rollback steps.");
      await editor.getByRole("button", { name: "Save comment", exact: true }).click();

      const create = await gateway.waitForRequest("sideConversations.create");
      expect(create.params).toMatchObject({ parentSessionKey: PARENT_KEY });
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
      const childComposer = page
        .locator("openclaw-chat-pane")
        .nth(1)
        .locator(".agent-chat__composer-shell textarea");
      await expect(childComposer).toBeVisible();
      // The route draft lands on a pane commit; retry until it is applied.
      await expect(childComposer).toHaveValue(/Review the deployment checklist/);
      await expect(childComposer).toHaveValue(/Check the rollback steps\./);
      // Selection only stages a draft; nothing is sent to any session.
      expect((await gateway.getRequests("chat.send")).length).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "selection-child-draft.png") });
    });
  });

  it("closes a child from its status strip and reopens it from the rail", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario([conversation()]));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, CHILD_KEY));

      const status = page.locator(".chat-side-conversation-status");
      await expect(status).toContainText("Side chat 1");
      await expect(status).toContainText("Worktree side/intent-1");
      await status.getByRole("button", { name: "Close side chat", exact: true }).click();
      const close = await gateway.waitForRequest("sideConversations.close");
      expect(close.params).toMatchObject({ parentSessionKey: PARENT_KEY, sessionKey: CHILD_KEY });
      await expect(status).toHaveAttribute("data-side-conversation-state", "closed");
      await expect(status).toContainText("Closed");

      const rail = await openSideRail(page);
      const row = rail.locator(".chat-session-rail__conversation").first();
      await expect(row).toContainText("Closed");
      await row.getByRole("button", { name: "Reopen", exact: true }).click();
      const reopen = await gateway.waitForRequest("sideConversations.reopen");
      expect(reopen.params).toMatchObject({ sessionKey: CHILD_KEY });
      await expect(status).toHaveAttribute("data-side-conversation-state", "open");
    });
  });

  it("shows the parent handoff chip and reopens the closed child when cancelled", async () => {
    const closed = conversation({ state: "closed", closedAt: 200, updatedAt: 200 });
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...scenario([closed], { handoffCount: 1 }),
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));

      const chip = page.locator(".chat-side-conversation-handoff");
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute("data-side-conversation-handoff-count", "1");
      await expect(chip).toContainText("closed side chat summary");
      await chip.getByRole("button", { name: "Cancel", exact: true }).click();

      const reopen = await gateway.waitForRequest("sideConversations.reopen");
      expect(reopen.params).toMatchObject({ parentSessionKey: PARENT_KEY, sessionKey: CHILD_KEY });

      // The Gateway clears the parent's pending count; the chip disappears.
      await gateway.setSessionsListResponse({
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [parentRow({ sideConversationCount: 1 })],
        path: "",
        ts: Date.now(),
      });
      await page.reload();
      await expect(page.locator(".chat-side-conversation-handoff")).toHaveCount(0);
    });
  });

  it("shows a shared checkout instead of claiming Git isolation", async () => {
    const notGit = conversation({ worktree: undefined, worktreeSkipped: "not-git" });
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, scenario([notGit]));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, CHILD_KEY));
      const status = page.locator(".chat-side-conversation-status");
      await expect(status).toContainText("Not a Git workspace · shares the parent checkout");
      await expect(
        status.getByRole("button", { name: "Merge into parent", exact: true }),
      ).toHaveCount(0);
    });
  });

  it("merges manually after confirmation and reports the outcome on the row", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario([conversation()]));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, CHILD_KEY));
      const status = page.locator(".chat-side-conversation-status");
      await status.getByRole("button", { name: "Merge into parent", exact: true }).click();
      const confirm = await waitForConfirmModal(page);
      await expect(confirm.textContent()).resolves.toContain(
        "Merge side/intent-1 into the parent workspace?",
      );
      await confirm.getByRole("button", { name: "Merge into parent", exact: true }).click();
      const merge = await gateway.waitForRequest("sideConversations.merge");
      expect(merge.params).toMatchObject({ sessionKey: CHILD_KEY });
      await expect(status).toHaveAttribute("data-side-conversation-state", "merged");
      await expect(status).toContainText("Merged");
      // A merged child keeps its branch facts visible.
      await expect(status).toContainText("Worktree side/intent-1");
    });
  });

  it("abandons manually after confirmation and reports the state", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario([conversation()]));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, CHILD_KEY));
      const status = page.locator(".chat-side-conversation-status");
      await status.getByRole("button", { name: "Abandon side chat", exact: true }).click();
      const confirm = await waitForConfirmModal(page);
      await expect(confirm.textContent()).resolves.toContain(
        "Abandon this side chat? Its branch and checkout are kept.",
      );
      await confirm.getByRole("button", { name: "Abandon side chat", exact: true }).click();
      const abandon = await gateway.waitForRequest("sideConversations.abandon");
      expect(abandon.params).toMatchObject({ sessionKey: CHILD_KEY });
      await expect(status).toHaveAttribute("data-side-conversation-state", "abandoned");
      await expect(status).toContainText("Abandoned");
    });
  });

  it("lists several children for one parent in the rail", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(
        page,
        scenario([
          conversation(),
          conversation({
            sessionKey: OTHER_CHILD_KEY,
            intentId: "intent-2",
            ordinal: 2,
            state: "closed",
            title: "Release notes",
            worktree: undefined,
            worktreeSkipped: "not-git",
          }),
        ]),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      const rail = await openSideRail(page);
      const rows = rail.locator(".chat-session-rail__conversation");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("Open");
      await expect(rows.nth(0)).toContainText("side/intent-1");
      await expect(rows.nth(1)).toContainText("Release notes");
      await expect(rows.nth(1)).toContainText("Closed");
      await expect(rows.nth(1)).toContainText("Not a Git workspace");
    });
  });

  it("shows a merge failure in the child status strip while the rail is closed", async () => {
    const artifactDir = createControlUiE2eArtifactDir("side-conversation-merge-error");
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...scenario([conversation()]),
        methodResponses: {
          "sideConversations.merge": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "Merge conflict in app.ts; nothing was merged.",
            },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, CHILD_KEY));
      const status = page.locator(".chat-side-conversation-status");
      await expect(status).toHaveAttribute("data-side-conversation-state", "open");
      // The rail is closed, so the strip is the only feedback surface.
      await expect(page.locator("openclaw-chat-session-rail")).toHaveCount(0);

      await status.getByRole("button", { name: "Merge into parent", exact: true }).click();
      const confirm = await waitForConfirmModal(page);
      await confirm.getByRole("button", { name: "Merge into parent", exact: true }).click();
      const merge = await gateway.waitForRequest("sideConversations.merge");
      expect(merge.params).toMatchObject({ parentSessionKey: PARENT_KEY, sessionKey: CHILD_KEY });

      const notice = status.getByRole("alert");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("Merge conflict in app.ts; nothing was merged.");
      await expect(status).toHaveAttribute("data-side-conversation-state", "open");
      await expect(
        status.getByRole("button", { name: "Merge into parent", exact: true }),
      ).toBeEnabled();
      await page.screenshot({ path: path.join(artifactDir, "merge-error-strip.png") });
    });
  });

  it("keeps the parent rail and child status strips in sync across panes", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(
        page,
        scenario(
          [
            conversation(),
            conversation({
              sessionKey: OTHER_CHILD_KEY,
              intentId: "intent-2",
              ordinal: 2,
              state: "closed",
              closedAt: 200,
              updatedAt: 200,
              title: "Release notes",
              worktree: undefined,
              worktreeSkipped: "not-git",
            }),
          ],
          { handoffCount: 1 },
        ),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      const parentPane = page.locator("openclaw-chat-pane").first();
      const parentComposer = parentPane.locator(".agent-chat__composer-shell textarea");
      const rail = await openSideRail(page);
      await rail.locator(".chat-session-rail__conversation").first().waitFor();
      const rowFor = (title: string) =>
        rail.locator(".chat-session-rail__conversation").filter({ hasText: title });
      const stripFor = (ordinal: number) =>
        page.locator(".chat-side-conversation-status").filter({ hasText: `Side chat ${ordinal}` });

      // Open both child panes from the parent rail.
      await rowFor("Side chat 1").locator(".chat-session-rail__conversation-main").click();
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
      await rowFor("Release notes").locator(".chat-session-rail__conversation-main").click();
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(3);
      await expect(stripFor(1)).toHaveAttribute("data-side-conversation-state", "open");
      await expect(stripFor(2)).toHaveAttribute("data-side-conversation-state", "closed");

      // Chip reopen in the parent updates the other pane's strip and the rail row.
      await parentComposer.click();
      const reopens = (await gateway.getRequests("sideConversations.reopen")).length;
      await page
        .locator(".chat-side-conversation-handoff")
        .first()
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await gateway.waitForRequest("sideConversations.reopen", { after: reopens });
      await expect(stripFor(2)).toHaveAttribute("data-side-conversation-state", "open");
      await expect(rowFor("Release notes").locator(".chat-session-rail__state")).toHaveText("Open");

      // Parent rail close reaches the closed child's strip.
      await rowFor("Release notes").getByRole("button", { name: "Close", exact: true }).click();
      await gateway.waitForRequest("sideConversations.close");
      await expect(stripFor(2)).toHaveAttribute("data-side-conversation-state", "closed");

      // The child strip transitions, and the parent rail row follows.
      const reopensAfterClose = (await gateway.getRequests("sideConversations.reopen")).length;
      await stripFor(2).getByRole("button", { name: "Reopen side chat", exact: true }).click();
      await gateway.waitForRequest("sideConversations.reopen", { after: reopensAfterClose });
      await expect(rowFor("Release notes").locator(".chat-session-rail__state")).toHaveText("Open");

      // Parent rail merge reaches the merged child's strip.
      await parentComposer.click();
      await rowFor("Side chat 1").getByRole("button", { name: "Merge", exact: true }).click();
      const mergeConfirm = await waitForConfirmModal(page);
      await mergeConfirm.getByRole("button", { name: "Merge into parent", exact: true }).click();
      await gateway.waitForRequest("sideConversations.merge");
      await expect(stripFor(1)).toHaveAttribute("data-side-conversation-state", "merged");

      // Parent rail abandon reaches the abandoned child's strip.
      await rowFor("Release notes").getByRole("button", { name: "Abandon", exact: true }).click();
      const abandonConfirm = await waitForConfirmModal(page);
      await abandonConfirm.getByRole("button", { name: "Abandon side chat", exact: true }).click();
      await gateway.waitForRequest("sideConversations.abandon");
      await expect(stripFor(2)).toHaveAttribute("data-side-conversation-state", "abandoned");
    });
  });

  it("creates one child when the rail submit fires again during creation", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario([conversation()]));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, PARENT_KEY));
      await openChatSidePanelType(page, "Side chat");
      const rail = page.locator("openclaw-chat-session-rail");
      const input = rail.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await input.fill("Only once?");
      const creates = (await gateway.getRequests("sideConversations.create")).length;
      await gateway.deferNext("sideConversations.create");

      await input.press("Enter");
      await gateway.waitForRequest("sideConversations.create", { after: creates });
      // Creation owns a worktree and stays pending; a second Enter and the Ask
      // button must not start another child or send the question twice.
      await input.press("Enter");
      await rail.getByRole("button", { name: "Ask", exact: true }).click({ force: true });
      expect((await gateway.getRequests("sideConversations.create")).length).toBe(creates + 1);
      await expect(rail.locator(".chat-send-btn")).toBeDisabled();

      await gateway.resolveDeferred("sideConversations.create", {
        ok: true,
        created: true,
        conversation: conversation(),
      });
      const send = await gateway.waitForRequest("chat.send");
      expect((send.params as { message?: unknown }).message).toBe("Only once?");
      expect((await gateway.getRequests("chat.send")).length).toBe(1);
      await expect(page.locator("openclaw-chat-pane")).toHaveCount(2);
    });
  });
});
