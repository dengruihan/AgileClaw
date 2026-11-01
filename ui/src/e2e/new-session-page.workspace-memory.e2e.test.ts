import path from "node:path";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  PICKED,
  SESSION_LIST_DEFAULTS,
  TARGET_REPO,
  WORKSPACE,
  captureProjectUiProof,
  captureUiProofEnabled,
  choosePackagesFolder,
  createNewSessionPageE2eSuite,
  installMockGateway,
  navigateInApp,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const MOBILE_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  hasTouch: true,
  viewport: { height: 740, width: 364 },
};
const GIT_BRANCHES = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const FOLDER_LISTINGS = {
  cases: [
    {
      match: { path: WORKSPACE },
      response: {
        path: WORKSPACE,
        parent: "/home/peter",
        home: "/home/peter",
        entries: [{ name: "packages", path: PICKED }],
      },
    },
    {
      match: { path: PICKED },
      response: { path: PICKED, parent: WORKSPACE, home: "/home/peter", entries: [] },
    },
  ],
};

function mainAgentList(workspace = WORKSPACE, workspaceGit = true) {
  return {
    agents: [
      {
        id: "main",
        identity: { name: "Main" },
        name: "Main",
        workspace,
        workspaceGit,
      },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

async function readMainPreference(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const key = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
    const value = key
      ? (JSON.parse(localStorage.getItem(key) ?? "null") as {
          agents?: Record<string, Record<string, unknown>>;
        } | null)
      : null;
    return value?.agents?.main ?? null;
  });
}

async function withNewSessionPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await suite.browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

function projectProofRecording(): BrowserContextOptions {
  return captureUiProofEnabled
    ? {
        recordVideo: {
          dir: path.join(suite.artifactDir, "project-registry"),
          size: { height: 900, width: 1280 },
        },
        viewport: { height: 900, width: 1280 },
      }
    : {};
}

suite.define(() => {
  it("keeps rail privacy visible and shows the mobile footer mode without hover", async () => {
    await withNewSessionPage(MOBILE_CONTEXT, async (page) => {
      await installMockGateway(page, {
        models: [
          {
            id: "gpt-5.6-luna",
            name: "GPT 5.6 Luna",
            provider: "openai",
            contextWindow: 400_000,
          },
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "anthropic",
            contextWindow: 200_000,
          },
        ],
        allowedSessionVisibilities: ["shared", "draft"],
        hasMultipleSessionSharingIdentities: true,
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const footer = page.locator(".new-session-page__composer .agent-chat__composer-footer");
      const attach = page.getByRole("button", { name: "Add attachment" });
      const takePhoto = page.getByRole("menuitem", { name: "Take photo" });
      const draft = page.locator('.new-session-page__draft-toggle[aria-label^="Draft:"]');
      const incognito = page.getByRole("switch", { name: "Incognito" });
      const model = page.locator(".new-session-page__composer .chat-composer-model-control");
      await Promise.all([
        footer.waitFor(),
        attach.waitFor(),
        draft.waitFor({ state: "attached" }),
        incognito.waitFor(),
        model.waitFor(),
      ]);

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(0, 0);
      await expect
        .poll(() => incognito.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await expect
        .poll(() => draft.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      expect(
        await incognito.evaluate(
          (element) => element.closest(".new-session-page__incognito-rail") != null,
        ),
      ).toBe(true);

      const [footerBox, attachBox, draftBox, modelBox] = await Promise.all([
        footer.boundingBox(),
        attach.boundingBox(),
        draft.boundingBox(),
        model.boundingBox(),
      ]);
      expect(footerBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(draftBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      // The row reads as the settings for the next turn, in the order the
      // operator decides them: attachments, draft visibility, then the model and
      // its reasoning. This viewport is narrow enough that
      // the row wraps, so the comparison is reading order — which line a control
      // is on first, then where it sits on that line.
      const followsInReadingOrder = (
        previous: { x: number; y: number; height: number } | null,
        next: { x: number; y: number; height: number } | null,
      ) => {
        if (!previous || !next) {
          return false;
        }
        const previousCenter = previous.y + previous.height / 2;
        const nextCenter = next.y + next.height / 2;
        const sameLine = Math.abs(nextCenter - previousCenter) <= previous.height / 2;
        return sameLine ? next.x > previous.x : nextCenter > previousCenter;
      };
      const sequence = [attachBox, modelBox];
      for (let index = 1; index < sequence.length; index += 1) {
        expect(followsInReadingOrder(sequence[index - 1] ?? null, sequence[index] ?? null)).toBe(
          true,
        );
      }
      for (const control of [attachBox, modelBox]) {
        expect(control?.x ?? 0).toBeGreaterThanOrEqual(footerBox?.x ?? 0);
        expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(
          (footerBox?.x ?? 0) + (footerBox?.width ?? 0),
        );
      }
      const controlsOverflow = await footer.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(controlsOverflow).toBe(0);

      await attach.click();
      await expect.poll(() => takePhoto.isVisible()).toBe(true);
      // The plus becomes a close mark while its menu is up: one glyph rotating,
      // so the button that opened the menu visibly is the one that dismisses it.
      // A CSS rotation matrix is [cos, sin, -sin, cos], so the sine term carries
      // the direction: negative is counter-clockwise, turning back against the
      // upward travel of the menu rather than with it.
      const attachGlyphSine = () =>
        attach.evaluate((element) => {
          const { transform } = getComputedStyle(element.querySelector("svg") as SVGElement);
          return transform === "none"
            ? 0
            : Number(transform.slice(transform.indexOf("(") + 1).split(",")[1]);
        });
      await expect.poll(attachGlyphSine).toBeCloseTo(-Math.SQRT1_2, 3);
      await page.keyboard.press("Escape");
      await expect.poll(attachGlyphSine).toBe(0);
      await incognito.click();
      await expect.poll(() => incognito.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("uses identity-scoped server recents without duplicating registered projects", async () => {
    const context = await suite.browser.newContext({
      ...BASE_CONTEXT,
      ...projectProofRecording(),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "projects.list",
        "sessions.create",
        "users.prefs.get",
        "users.prefs.set",
      ],
      methodResponses: {
        "projects.list": {
          projects: [{ id: "registered", displayName: "Registered", source: "registered" }],
          recents: [
            { kind: "project", projectId: "registered", displayName: "Registered" },
            {
              kind: "folder",
              folder: `${WORKSPACE}/scratch`,
              displayName: "scratch",
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:shared", kind: "direct", updatedAt: 99, execCwd: "/shared" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:identity-project" },
        "users.prefs.get": { status: "ok", entries: {} },
        "users.prefs.set": { status: "ok" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      expect(await page.locator('[data-value="recent:/shared"]').count()).toBe(0);
      expect(await page.locator('[data-value="recent-project:registered"]').count()).toBe(0);
      const project = page.locator('[data-value="project:registered"]');
      const recentFolder = page.locator(`[data-value="recent:${WORKSPACE}/scratch"]`);
      await project.waitFor();
      await recentFolder.waitFor();
      await captureProjectUiProof(suite, page, "identity-project-recents-after.png", {
        surface: page.locator('.new-session-page__project-popover wa-popup [part="popup"]'),
        content: [project, recentFolder],
      });
      await project.click();
      await page.locator(".new-session-page__message").fill("continue registered work");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        projectId: "registered",
        message: "continue registered work",
      });
    } finally {
      await context.close();
    }
  });

  it("falls back to the current workspace when the remembered folder is gone", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "fs.listDir",
          "sessions.create",
          "worktrees.branches",
        ],
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": FOLDER_LISTINGS,
          "sessions.create": { key: "agent:main:stale-folder-fallback", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await choosePackagesFolder(page);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      const validationRequests = (await gateway.getRequests("fs.listDir")).length;
      await gateway.deferNext("fs.listDir");
      await navigateInApp(page, "new-session");
      await expect
        .poll(async () => (await gateway.getRequests("fs.listDir")).length)
        .toBeGreaterThan(validationRequests);
      const message = page.locator(".new-session-page__message");
      await message.fill("use a safe folder");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);

      await gateway.rejectDeferred("fs.listDir", {
        code: "INVALID_REQUEST",
        message: `Error: ENOENT: no such file or directory, scandir '${PICKED}'`,
      });
      const placeTrigger = page.locator("#new-session-project-trigger");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      const pickedListRequests = (await gateway.getRequests("fs.listDir")).filter(
        (request) =>
          typeof request.params === "object" &&
          request.params != null &&
          "path" in request.params &&
          request.params.path === PICKED,
      ).length;
      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      await navigateInApp(page, "new-session");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );
      await expect
        .poll(() => page.locator("#new-session-checkout-trigger").getAttribute("data-worktree"))
        .toBe("false");
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("fs.listDir")).filter(
              (request) =>
                typeof request.params === "object" &&
                request.params != null &&
                "path" in request.params &&
                request.params.path === PICKED,
            ).length,
        )
        .toBe(pickedListRequests);

      await message.fill("use the repaired preference");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(false);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("cwd");
    });
  });

  it("keeps a newer folder choice when remembered-folder validation finishes late", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": GIT_BRANCHES,
          "fs.listDir": FOLDER_LISTINGS,
          "sessions.create": { key: "agent:main:newer-folder-wins", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await choosePackagesFolder(page);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      const validationRequests = (await gateway.getRequests("fs.listDir")).length;
      await gateway.deferNext("fs.listDir");
      await navigateInApp(page, "new-session");
      await expect
        .poll(async () => (await gateway.getRequests("fs.listDir")).length)
        .toBeGreaterThan(validationRequests);

      const placeTrigger = page.locator("#new-session-project-trigger");
      await placeTrigger.click();
      await page
        .locator('wa-popover.new-session-page__project-popover [data-value="workspace"]')
        .click();
      await gateway.resolveDeferred("fs.listDir", {
        path: PICKED,
        parent: WORKSPACE,
        home: "/home/peter",
        entries: [],
      });
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      await page.locator(".new-session-page__message").fill("keep the newer choice");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("cwd");
    });
  });

  it("keeps a folder chosen before the agent roster finishes loading submit-ready", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["agents.list"],
        workspaceGit: true,
        methodResponses: {
          "agents.list": mainAgentList(),
          "fs.listDir": { path: TARGET_REPO, home: "/home/peter", entries: [] },
          "worktrees.branches": GIT_BRANCHES,
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      const browserPath = page.locator("input.new-session-page__browser-path");
      // Resolve the browser listing without resolving the deferred agent roster;
      // otherwise its initial path update can race Playwright's folder input.
      await expect.poll(() => browserPath.inputValue()).toBe(TARGET_REPO);
      await browserPath.fill(TARGET_REPO);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await gateway.resolveDeferred("agents.list", mainAgentList());

      await page.locator(".new-session-page__message").fill("keep my early folder choice");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(false);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toContain(
        "target-repo",
      );
      const storedPreference = await readMainPreference(page);
      expect(storedPreference).toMatchObject({ folder: TARGET_REPO });
    });
  });
});
