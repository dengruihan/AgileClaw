import path from "node:path";
import { expect, it } from "vitest";
import {
  PICKED,
  WORKSPACE,
  captureNewSessionComposerUiProof,
  captureProjectUiProof,
  captureUiProofEnabled,
  checkoutBaseRefInput,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps the pre-submit draft on the composer and creates exactly one session", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "new-session-slash-menu"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.list": createdSessionListResult("agent:main:existing"),
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      const message = page.locator(".new-session-page__message");
      await message.waitFor();
      await message.fill("/");
      const slashMenu = page.locator("#chat-new-session-slash-menu-listbox");
      await pollLocatorText(slashMenu).toContain("/status");
      expect(await slashMenu.textContent()).not.toContain("/clear");
      await captureNewSessionComposerUiProof(suite, page, "slash-menu-open.png", {
        surface: slashMenu,
        content: [slashMenu.getByRole("option").first()],
      });
      if (captureUiProofEnabled) {
        await page.waitForTimeout(750);
      }
      await message.fill("fix the flaky draft test");

      // Owner boundary: the New Session page (new-session-page.ts:228) keeps
      // the draft message on DraftSubmissionFlow until the composer submits,
      // so the route, the typed text, and the sidebar's canonical
      // sessions.list row must all stay put with zero sessions.create
      // requests before that happens.
      expect(new URL(page.url()).pathname).toBe("/new");
      expect(new URL(page.url()).search).toBe("?agent=main");
      expect(await message.inputValue()).toBe("fix the flaky draft test");
      expect(
        await page
          .locator('.sidebar-recent-session[data-session-key="agent:main:existing"]')
          .count(),
      ).toBe(1);
      expect(await page.locator(".sidebar-recent-session").count()).toBe(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await page.getByRole("button", { name: "Start session" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky draft test",
      });

      // Wait for the same canonical settle signal the neighboring submission
      // test uses (navigation to the created session route) before counting
      // requests: the exactly-once assert must observe the submission flow
      // after it has fully resolved, not mid-flight, or a late duplicate
      // sessions.create could land after a premature pass.
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:draft-e2e"));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("selects a registered project and submits its id at write scope", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "project-registry"),
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "projects.list",
        "environments.list",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": {
          projects: [
            {
              id: "workspace:main",
              displayName: "openclaw",
              repoRoot: WORKSPACE,
              source: "workspace",
              agentId: "main",
            },
            {
              id: "recorded-openclaw",
              displayName: "Recorded AgileClaw",
              repoRoot: "/recorded/openclaw",
              source: "registered",
            },
          ],
        },
        "environments.list": {
          environments: [],
          profiles: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:project-e2e" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Recorded AgileClaw", exact: true }).click();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        "Recorded AgileClaw",
      );
      expect(await trigger.getAttribute("data-project-id")).toBe("recorded-openclaw");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: "/recorded/openclaw", includeRepositoryStatus: true });

      await page.locator("#new-session-checkout-trigger").click();
      await page
        .locator("wa-popover.new-session-page__checkout-popover")
        .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
        .click();
      const checkout = page.locator("wa-popover.new-session-page__checkout-popover");
      await captureProjectUiProof(suite, page, "project-selected.png", {
        surface: checkout.locator('wa-popup [part="popup"]'),
        content: [checkoutBaseRefInput(checkout)],
      });
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("inspect the project");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "inspect the project",
        projectId: "recorded-openclaw",
        worktree: true,
      });
      expect(create.params).not.toHaveProperty("worktreeBaseRef");
      expect(create.params).not.toHaveProperty("cwd");
      expect(create.params).not.toHaveProperty("execNode");
    } finally {
      await context.close();
    }
  });

  it("filters folders live without reloading and opens the highlighted match", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                home: WORKSPACE,
                entries: [
                  { name: "packages", path: PICKED },
                  { name: "tools", path: `${WORKSPACE}/tools` },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: { path: PICKED, parent: WORKSPACE, home: WORKSPACE, entries: [] },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await page.locator("#new-session-project-trigger").click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      const input = place.locator("input.new-session-page__browser-path");
      await expect.poll(() => input.inputValue()).toBe(WORKSPACE);
      // The draft path is set before the request finishes; filter only after its listing arrives.
      await place.locator(".new-session-page__browser-entry", { hasText: "packages" }).waitFor();
      const requestsBefore = await gateway.getRequests("fs.listDir");
      await input.fill(`${WORKSPACE}/pa`);
      await expect
        .poll(() => place.locator(".new-session-page__browser-entry").allTextContents())
        .toEqual([expect.stringMatching(/^\s*packages\s*$/)]);
      await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-prefix.png") });
      expect(await gateway.getRequests("fs.listDir")).toHaveLength(requestsBefore.length);
      await input.press("Enter");
      await gateway.waitForRequest("fs.listDir", { match: { path: PICKED } });
      await expect.poll(() => input.inputValue()).toBe(PICKED);
      await input.fill(`${WORKSPACE}/zzz`);
      await place.getByText("No matching folders", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(suite.artifactDir, "folder-live-no-matches.png") });
    } finally {
      await context.close();
    }
  });

  it("returns from the browse root to the place menu", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          path: WORKSPACE,
          home: WORKSPACE,
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      await place.getByRole("button", { name: "Parent folder" }).click();
      await place.getByRole("button", { name: "Browse folders" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").press("Escape");
      await place.getByRole("button", { name: "Browse folders" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
