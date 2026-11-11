// Real-browser proof that workspace Markdown files open rendered by default,
// share the attachment reader's sanitized document contract, and keep the
// Source editor lifecycle (drafts, line links) that plain text files already use.
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Markdown file preview" });

const markdownSource =
  [
    "# Release notes",
    "",
    "Rendered **bold** introduction.",
    "",
    "## Checklist",
    "",
    "- First item",
    "- Second item",
    "",
    "| Feature | State |",
    "| --- | --- |",
    "| Sidebar | Ready |",
    "",
    "```ts",
    `const longLine = "${"notes ".repeat(60)}";`,
    ...Array.from({ length: 12 }, (_, index) => `const line${index} = ${index};`),
    "const ready = true;",
    "```",
    "",
    '<script>window.__markdownPreviewScript = "executed";</script>',
    "",
    '<div id="raw-html-block">Raw block</div>',
    "",
    "![tracking](https://remote.example/tracking.png)",
    "",
    "[unsafe link](javascript:alert(1))",
    "",
  ].join("\n") + "\n";
const editedMarkdown = "# Edited draft\n\nUpdated **notes** from the editor.\n";
const plainTextSource = "Exact-head plain text preview proof.\n";

function markdownFileResponse(content: string) {
  return {
    root: "/workspace",
    sessionKey: "agent:main:main",
    file: {
      name: "notes.md",
      path: "notes.md",
      workspacePath: "notes.md",
      content,
      contentEncoding: "utf8",
      hash: "a".repeat(64),
      kind: "read",
      missing: false,
      previewKind: "text",
      mimeType: "text/markdown",
      size: Buffer.byteLength(content),
    },
  };
}

// Capture the settled default state before the strict rendered assertion so a
// failing baseline still retains the wrong-state screenshot.
async function settleFileView(panel: Locator) {
  await panel.locator(".sidebar-file-view").waitFor({ state: "visible" });
  await panel
    .locator(".sidebar-file-view .cm-editor, .sidebar-file-view article")
    .first()
    .waitFor();
}

async function expectRenderedMarkdown(panel: Locator) {
  const article = panel.locator("article.sidebar-markdown-reader");
  await article.waitFor({ state: "visible" });
  await expect.poll(() => article.locator("h1").textContent()).toBe("Release notes");
  expect(await article.locator("h2").textContent()).toBe("Checklist");
  expect(await article.locator("strong").textContent()).toBe("bold");
  expect(await article.locator("li").first().textContent()).toBe("First item");
  expect(await article.locator("td").first().textContent()).toBe("Sidebar");
  expect(await article.locator("pre code").textContent()).toContain("const ready = true;");
  expect(await panel.locator(".cm-editor").count()).toBe(0);
  const toggle = panel.getByRole("button", { name: "Source", exact: true });
  await toggle.waitFor({ state: "visible" });
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  expect(await panel.getByRole("button", { name: "View Raw Text", exact: true }).count()).toBe(0);
  return article;
}

suite.define(() => {
  it("renders a chat Markdown file link by default with Source toggle, inert markup, and draft survival", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
          let remoteImageRequests = 0;
          await page.route("**/tracking.png", (route) => {
            remoteImageRequests += 1;
            return route.fulfill({ status: 204, body: "" });
          });
          const gateway = await installMockGateway(page, {
            workspace: "/workspace",
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set"],
            historyMessages: [
              {
                role: "assistant",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Open [notes](notes.md)." }],
              },
            ],
            methodResponses: {
              "sessions.files.get": markdownFileResponse(markdownSource),
              "sessions.files.set": {
                sessionKey: "agent:main:main",
                file: { hash: "b".repeat(64), size: Buffer.byteLength(editedMarkdown) },
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          await gateway.waitForRequest("chat.startup");
          await page.locator('a.markdown-file-link[data-file-path="notes.md"]').click();
          const panel = page.locator("openclaw-chat-detail-panel:visible");
          await settleFileView(panel);
          await page.screenshot({
            path: path.join(suite.artifactDir, "file-link-default.png"),
          });
          const article = await expectRenderedMarkdown(panel);

          // The attachment document contract: embedded scripts never run, raw
          // HTML stays escaped text, and remote images become inert links.
          expect(
            await page.evaluate(() => Reflect.get(window, "__markdownPreviewScript")),
          ).toBeUndefined();
          expect(
            await panel.locator("article script, article iframe, article #raw-html-block").count(),
          ).toBe(0);
          expect(await article.locator("img").count()).toBe(0);
          expect(
            await article.locator('a[href="https://remote.example/tracking.png"]').count(),
          ).toBe(1);
          expect(await article.locator('a[href^="javascript:"]').count()).toBe(0);
          expect(remoteImageRequests).toBe(0);

          // Interactive code-block chrome works inside the file preview.
          const expand = article.locator(".code-block-expand").first();
          await expand.waitFor({ state: "visible" });
          await expand.click();
          expect(await expand.getAttribute("aria-expanded")).toBe("true");

          await panel.getByRole("button", { name: "Source", exact: true }).click();
          const editor = panel.locator(".cm-editor");
          await editor.waitFor({ state: "visible" });
          await expect
            .poll(() => panel.locator(".cm-content").textContent())
            .toContain("# Release notes");
          expect(await panel.locator(".cm-lineNumbers").count()).toBe(1);
          expect(await article.evaluate((element) => element.checkVisibility())).toBe(false);
          const previewToggle = panel.getByRole("button", { name: "Preview", exact: true });
          expect(await previewToggle.getAttribute("aria-pressed")).toBe("true");
          await page.screenshot({
            path: path.join(suite.artifactDir, "file-link-source.png"),
          });
          const editorHandle = await editor.elementHandle();
          await previewToggle.click();
          await expect
            .poll(() => article.evaluate((element) => element.checkVisibility()))
            .toBe(true);
          expect(await editorHandle!.evaluate((element) => element.isConnected)).toBe(true);

          // Editing routes through Source; the unsaved draft renders in Preview
          // and survives the round trip without a save.
          await panel.getByRole("button", { name: "Edit file", exact: true }).click();
          const editable = panel.locator('.cm-content[contenteditable="true"]');
          await editable.waitFor({ state: "visible" });
          await editable.fill(editedMarkdown);
          await panel.getByRole("button", { name: "Preview", exact: true }).click();
          await expect.poll(() => article.locator("h1").textContent()).toBe("Edited draft");
          expect(await gateway.getRequests("sessions.files.set")).toEqual([]);
          await page.screenshot({
            path: path.join(suite.artifactDir, "file-link-draft-preview.png"),
          });
          await panel.getByRole("button", { name: "Source", exact: true }).click();
          await expect
            .poll(() => panel.locator(".cm-content").textContent())
            .toContain("# Edited draft");
          const save = panel.getByRole("button", { name: "Save", exact: true });
          expect(await save.isEnabled()).toBe(true);
          await save.click();
          await expect.poll(() => save.isDisabled()).toBe(true);
          expect(await gateway.getRequests("sessions.files.set")).toMatchObject([
            { params: { content: editedMarkdown, expectedHash: "a".repeat(64) } },
          ]);
          await panel.getByRole("button", { name: "Preview", exact: true }).click();
          await expect.poll(() => article.locator("h1").textContent()).toBe("Edited draft");
          await page.screenshot({
            path: path.join(suite.artifactDir, "file-link-saved.png"),
          });
          expect(remoteImageRequests).toBe(0);
        });
      },
    });
  });

  it("opens rendered Markdown from the Files row and its Preview action alike", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
          const gateway = await installMockGateway(page, {
            workspace: "/workspace",
            historyMessages: [],
            methodResponses: {
              "sessions.files.get": markdownFileResponse(markdownSource),
              "sessions.files.list": {
                root: "/workspace",
                sessionKey: "agent:main:main",
                files: [],
                browser: {
                  path: "",
                  entries: [
                    {
                      kind: "file",
                      name: "notes.md",
                      path: "notes.md",
                      size: Buffer.byteLength(markdownSource),
                    },
                  ],
                },
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          await gateway.waitForRequest("chat.startup");
          await openChatSidePanelType(page, "Files");
          const row = page
            .locator(".chat-workspace-rail__list--browser .chat-workspace-rail__file")
            .filter({ hasText: "notes.md" });
          await row.waitFor({ state: "visible" });
          const panel = page.locator("openclaw-chat-detail-panel:visible");

          await row.locator(".chat-workspace-rail__file-open").click();
          await settleFileView(panel);
          await page.screenshot({
            path: path.join(suite.artifactDir, "files-row-default.png"),
          });
          await expectRenderedMarkdown(panel);
          await page.getByRole("button", { name: "Close tab: notes.md", exact: true }).click();
          await page.locator("openclaw-chat-detail-panel").waitFor({ state: "detached" });

          await row.getByRole("button", { name: "Preview", exact: true }).click();
          await settleFileView(panel);
          await page.screenshot({
            path: path.join(suite.artifactDir, "files-preview-action-default.png"),
          });
          await expectRenderedMarkdown(panel);
          expect(
            await page
              .locator(".side-panel__header wa-tab")
              .filter({ hasText: "notes.md" })
              .count(),
          ).toBe(1);
        });
      },
    });
  });

  it("keeps plain text in CodeMirror and sends Markdown line links straight to Source", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage({ viewport: { width: 1440, height: 1000 } }, async ({ page }) => {
          const gateway = await installMockGateway(page, {
            workspace: "/workspace",
            historyMessages: [
              {
                role: "assistant",
                timestamp: Date.now(),
                content: [
                  {
                    type: "text",
                    text: "Open [plain](notes.txt) or jump to [line two](notes.md:2).",
                  },
                ],
              },
            ],
            methodResponses: {
              "sessions.files.get": {
                cases: [
                  {
                    match: { path: "notes.txt" },
                    response: {
                      root: "/workspace",
                      sessionKey: "agent:main:main",
                      file: {
                        name: "notes.txt",
                        path: "notes.txt",
                        workspacePath: "notes.txt",
                        content: plainTextSource,
                        contentEncoding: "utf8",
                        hash: "c".repeat(64),
                        kind: "read",
                        missing: false,
                        previewKind: "text",
                        mimeType: "text/plain",
                        size: Buffer.byteLength(plainTextSource),
                      },
                    },
                  },
                  { match: { path: "notes.md" }, response: markdownFileResponse(markdownSource) },
                ],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
          await gateway.waitForRequest("chat.startup");
          await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
          const panel = page.locator("openclaw-chat-detail-panel:visible");
          await panel.locator(".cm-editor").waitFor({ state: "visible" });
          await expect
            .poll(() => panel.locator(".cm-content").textContent())
            .toContain("Exact-head plain text preview proof.");
          expect(await panel.locator("article").count()).toBe(0);
          const rawButton = panel.getByRole("button", { name: "View Raw Text", exact: true });
          await rawButton.waitFor({ state: "visible" });
          await page.screenshot({
            path: path.join(suite.artifactDir, "plain-text-code.png"),
          });
          await rawButton.click();
          const rawReader = panel.locator(".sidebar-markdown-reader");
          await rawReader.waitFor({ state: "visible" });
          // The literal raw view keeps the source verbatim; the code-block
          // renderer contributes one final newline.
          expect(await rawReader.locator("pre code").textContent()).toBe(`${plainTextSource}\n`);
          expect(await panel.locator(".sidebar-file-view").count()).toBe(0);
          await page.screenshot({
            path: path.join(suite.artifactDir, "plain-text-raw.png"),
          });

          await page.locator('a.markdown-file-link[data-file-path="notes.md"]').click();
          await panel.locator(".cm-editor:visible").waitFor();
          await expect
            .poll(() => panel.locator(".file-view__line--target").getAttribute("data-line"))
            .toBe("2");
          // A line link opens Source first: no rendered article is mounted yet.
          expect(await panel.locator("article.sidebar-markdown-reader").count()).toBe(0);
          const previewToggle = panel.getByRole("button", { name: "Preview", exact: true });
          expect(await previewToggle.getAttribute("aria-pressed")).toBe("true");
          await page.screenshot({
            path: path.join(suite.artifactDir, "markdown-line-source.png"),
          });
          await previewToggle.click();
          const article = panel.locator("article.sidebar-markdown-reader");
          await expect
            .poll(() => article.evaluate((element) => element.checkVisibility()))
            .toBe(true);
          await expect.poll(() => article.locator("h1").textContent()).toBe("Release notes");
          await page.screenshot({
            path: path.join(suite.artifactDir, "markdown-line-preview.png"),
          });
        });
      },
    });
  });
});
