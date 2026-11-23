import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { expect } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { holdModuleResponse } from "./control-ui-e2e-suite.test-support.ts";
import { RETAINED_DESKTOP_SESSION_KEY } from "./desktop-retention.test-support.ts";

type ControlUiE2eSuite = ReturnType<typeof createControlUiE2eSuite>;

export const HIDDEN_BOARD_SESSION_KEY = "agent:main:hidden-board-slot";

export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
  "base64",
);

export type ColdOpenOutcome = {
  outcome: "loading" | "content" | "generic-empty";
  emptyStateOffersAction: boolean;
};

export const offeredSlotLabels = [
  "Subagents",
  "Processes",
  "Review",
  "Terminal",
  "Browser",
  "Files",
  "Side chat",
  "Desktop",
  "Discussion",
] as const;

export type OfferedSlotLabel = (typeof offeredSlotLabels)[number];

export const actionlessEmptyStateAllowlist = new Set<OfferedSlotLabel>([
  // Discussion: no external URL, nothing to open.
  "Discussion",
]);

export function coldOpenScenario(): ControlUiMockGatewayScenario {
  return {
    featureMethods: [
      "browser.request",
      "chat.metadata",
      "chat.startup",
      "desktop.observe",
      "environments.list",
      "environments.status",
      "session.discussion.info",
      "session.discussion.open",
      "sideConversations.list",
      "sessions.diff",
      "sessions.files.list",
      "terminal.open",
    ],
    methodResponses: {
      "sessions.processes.list": { sessionId: "main-session", processes: [], truncated: false },
      "browser.request": {
        cases: [
          { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
        ],
      },
      "environments.list": { environments: [] },
      "session.discussion.info": {
        state: "open",
      },
      "sessions.files.list": {
        browser: { entries: [], path: "" },
        files: [],
        gitCheckout: false,
        root: "/tmp/plain-workspace",
        sessionKey: "main",
      },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/plain-workspace",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    terminalEnabled: true,
    workspace: "/tmp/plain-workspace",
    workspaceGit: false,
  };
}

export function populatedColdOpenScenario(): ControlUiMockGatewayScenario {
  const sparse = coldOpenScenario();
  return {
    ...sparse,
    sessions: [
      { key: "agent:main:main", kind: "direct", label: "Main", updatedAt: 1 },
      {
        key: "agent:main:subagent:panel-content",
        kind: "direct",
        label: "Check panel content",
        spawnedBy: "agent:main:main",
        status: "done",
        updatedAt: 2,
      },
    ],
    methodResponses: {
      ...sparse.methodResponses,
      "sessions.processes.list": {
        sessionId: "main-session",
        truncated: false,
        processes: [
          {
            processId: "process-1",
            instanceId: "incarnation-1",
            name: "Build application",
            status: "running",
            startedAt: 1,
            tail: "Compiling",
            truncated: false,
            canStop: false,
          },
        ],
      },
      "browser.request": {
        cases: [
          {
            match: { method: "GET", path: "/tabs" },
            response: {
              running: true,
              tabs: [
                {
                  targetId: "target-1",
                  tabId: "tab-1",
                  title: "AgileClaw",
                  url: "https://example.test/",
                },
              ],
            },
          },
          {
            match: { method: "POST", path: "/screenshot" },
            response: {
              path: "/proof/browser.png",
              targetId: "target-1",
              url: "https://example.test/",
            },
          },
        ],
      },
      "environments.list": {
        environments: [
          { id: "worker-desktop-1", type: "worker", status: "available", desktop: true },
        ],
      },
      "session.discussion.info": {
        embedUrl: "https://discussion.example/embed/thread/session",
        openUrl: "https://discussion.example/session",
        state: "open",
      },
      "sideConversations.list": {
        ok: true,
        parentSessionKey: "agent:main:main",
        sideConversations: [
          {
            sessionKey: "agent:main:dashboard:side-cccccccccccccccccccccccccccccccc",
            parentSessionKey: "agent:main:main",
            intentId: "intent-cold-open",
            ordinal: 1,
            state: "open",
            createdAt: 1_000,
            updatedAt: 1_000,
            title: "Every offered panel now opens with useful content.",
            isolation: { filesystem: "worktree", externalState: "shared" },
            worktree: {
              id: "wt-cold-open",
              branch: "side/intent-cold-open",
              path: "/mock/wt-cold-open",
            },
          },
        ],
      },
      "sessions.diff": {
        additions: 1,
        baseRef: "main",
        branch: "feature/sidebar-invariant",
        deletions: 0,
        files: [
          {
            additions: 1,
            deletions: 0,
            patch: [
              "diff --git a/README.md b/README.md",
              "--- a/README.md",
              "+++ b/README.md",
              "@@ -1 +1,2 @@",
              " AgileClaw",
              "+Cold-open invariant",
              "",
            ].join("\n"),
            path: "README.md",
            status: "modified",
          },
        ],
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "sessions.files.list": {
        browser: {
          entries: [{ kind: "file", name: "README.md", path: "README.md" }],
          path: "",
        },
        files: [
          {
            kind: "modified",
            missing: false,
            name: "README.md",
            path: "/tmp/checkout/README.md",
            size: 128,
          },
        ],
        gitCheckout: true,
        root: "/tmp/checkout",
        sessionKey: "main",
      },
      "terminal.open": {
        agentId: "main",
        confined: false,
        cwd: "/tmp/checkout",
        sessionId: "cold-open-terminal",
        shell: "/bin/zsh",
      },
    },
    workspace: "/tmp/checkout",
    workspaceGit: true,
  };
}

export async function clickSidebarTab(page: Page, label: string): Promise<void> {
  await page.locator(".side-panel__header .tabstrip-tab").filter({ hasText: label }).click();
}

export async function readColdOpenOutcome(page: Page): Promise<ColdOpenOutcome> {
  const activePanel = page.locator(".side-panel__panel:not([hidden])");
  await activePanel.waitFor();
  await activePanel.locator(":scope > *").first().waitFor();
  if ((await activePanel.locator("openclaw-panel-loading-skeleton").count()) > 0) {
    return { outcome: "loading", emptyStateOffersAction: false };
  }
  const emptyState = activePanel.locator("openclaw-panel-empty-state").first();
  const genericEmptyState = (await emptyState.count()) > 0;
  return {
    outcome: genericEmptyState ? "generic-empty" : "content",
    emptyStateOffersAction:
      genericEmptyState &&
      (await activePanel.locator('[slot="action"], a[href], button:not([disabled])').count()) > 0,
  };
}

/** Helpers that need the suite's server URL and browser-context bookkeeping. */
export function createChatSidebarPanelContractHelpers(suite: ControlUiE2eSuite) {
  async function openColdSidebar(page: Page, scenario = coldOpenScenario()) {
    await page.route("**/__openclaw__/assistant-media?*", (route) =>
      route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png" }),
    );
    const gateway = await installMockGateway(page, scenario);
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
    await waitForControlUiGatewayReady(page);
    await gateway.waitForRequest("session.discussion.info");
    // The rail reads its registry only once it is opened; an idle chat stays quiet.
    expect(await gateway.getRequests("sideConversations.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    await page.getByRole("button", { name: "Side panel", exact: true }).first().click();
    const choices = page.locator(".side-panel-empty__type");
    await choices.first().waitFor();
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    return choices;
  }

  async function seedHiddenBoardSlot(page: Page) {
    const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
    await page.addInitScript(
      ({ key, sessionKey }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            sessionKey,
            sidebarSessionLayouts: {
              [sessionKey]: {
                columns: [
                  {
                    id: "side-panel-column",
                    side: "right",
                    panels: [{ id: "dashboard", slot: "dashboard" }],
                    activePanelId: "dashboard",
                    height: 360,
                    width: 480,
                  },
                ],
                dock: "right",
                open: true,
                expanded: false,
              },
            },
          }),
        );
      },
      { key: settingsKey, sessionKey: HIDDEN_BOARD_SESSION_KEY },
    );
  }

  async function seedRetainedDesktopSlot(
    page: Page,
    activePanel: "workspace" | "conversation" = "workspace",
  ) {
    const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
    await page.addInitScript(
      ({ key, sessionKey, activePanel: seededActivePanel }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            sessionKey,
            sidebarSessionLayouts: {
              [sessionKey]: {
                columns: [
                  {
                    id: "side-panel-column",
                    side: "right",
                    panels: [
                      { id: "workspace", slot: "workspace" },
                      ...(seededActivePanel === "conversation"
                        ? [{ id: "conversation", slot: "conversation" }]
                        : []),
                      { id: "desktop", slot: "desktop" },
                    ],
                    activePanelId: seededActivePanel,
                    height: 360,
                    width: 480,
                  },
                ],
                ...(seededActivePanel === "conversation" ? { mainPanelId: "workspace" } : {}),
                dock: "right",
                open: true,
                expanded: false,
              },
            },
          }),
        );
        localStorage.setItem(
          "openclaw.desktopPanel",
          JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
        );
      },
      { key: settingsKey, sessionKey: RETAINED_DESKTOP_SESSION_KEY, activePanel },
    );
  }

  async function openMotionChat(page: Page) {
    const gateway = await installMockGateway(page, coldOpenScenario());
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
    await waitForControlUiGatewayReady(page);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    return gateway;
  }

  async function seedOpenProcessesSlot(page: Page) {
    const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
    await page.addInitScript(
      ({ key, sessionKey }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            sessionKey,
            sidebarSessionLayouts: {
              [sessionKey]: {
                columns: [
                  {
                    id: "side-panel-column",
                    side: "right",
                    panels: [{ id: "processes", slot: "processes" }],
                    activePanelId: "processes",
                    height: 360,
                    width: 480,
                  },
                ],
                dock: "right",
                open: true,
                expanded: false,
              },
            },
          }),
        );
      },
      { key: settingsKey, sessionKey: "agent:main:main" },
    );
  }

  async function readSlotColdOpenOutcome(
    label: OfferedSlotLabel,
    scenario: ControlUiMockGatewayScenario,
    expectedOutcome?: ColdOpenOutcome["outcome"],
  ): Promise<ColdOpenOutcome> {
    const context = await suite.newBrowserContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const choices = await openColdSidebar(page, scenario);
      expect(
        await choices.locator(".side-panel-type-option__label").allTextContents(),
        `${label} cold-open offered slots`,
      ).toEqual(offeredSlotLabels);
      const held =
        label === "Discussion"
          ? await holdModuleResponse(
              page,
              controlUiE2eBuiltModuleRequest(
                "ui/src/pages/chat/components/session-discussion-panel.ts",
              ),
            )
          : null;
      try {
        await choices.filter({ hasText: label }).click();
        if (held) {
          await held.request;
          expect(await readColdOpenOutcome(page)).toEqual({
            outcome: "loading",
            emptyStateOffersAction: false,
          });
        }
      } finally {
        held?.release();
      }
      if (label === "Processes") {
        const processes = page.locator("openclaw-chat-processes-panel");
        await processes
          .getByText(
            expectedOutcome === "content"
              ? "Build application"
              : "No background processes in this conversation.",
            { exact: true },
          )
          .waitFor();
      }
      if (label === "Subagents") {
        const subagents = page.locator("openclaw-chat-subagents-panel");
        if (expectedOutcome === "content") {
          await subagents
            .getByRole("button", { name: "Check panel content", exact: true })
            .waitFor();
        } else {
          await subagents
            .getByText("No subagents in this conversation.", { exact: true })
            .waitFor();
        }
      }
      if (expectedOutcome) {
        await expect
          .poll(() => readColdOpenOutcome(page), { message: `${label} cold-open outcome` })
          .toMatchObject({ outcome: expectedOutcome });
      } else {
        await expect
          .poll(() => readColdOpenOutcome(page), { message: `${label} finished cold-open` })
          .not.toMatchObject({ outcome: "loading" });
      }
      return await readColdOpenOutcome(page);
    } finally {
      await suite.closeBrowserContext(context);
    }
  }

  return {
    openColdSidebar,
    seedHiddenBoardSlot,
    seedRetainedDesktopSlot,
    openMotionChat,
    seedOpenProcessesSlot,
    readSlotColdOpenOutcome,
  };
}
