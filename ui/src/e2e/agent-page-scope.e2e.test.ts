// Control UI E2E tests cover chip-selected page scope and the all-agents escape.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  type MockGatewayControls,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent page scope",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-page-scope");
  }
});

function requestParams(request: { params?: unknown }): Record<string, unknown> {
  return request.params && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {};
}

async function waitForRequest(
  gateway: MockGatewayControls,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests(method)).some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

function selectedAgentId(page: Page) {
  return page.locator("openclaw-app").evaluate((element) => {
    const app = element as HTMLElement & {
      runtime: { context: { agentSelection: { state: { selectedId: string } } } };
    };
    return app.runtime.context.agentSelection.state.selectedId;
  });
}

const multiAgentRoster = [
  { id: "main", identity: { name: "Main" }, name: "Main" },
  { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
  { id: "writer", identity: { name: "Writer" }, name: "Writer" },
];

suite.define(() => {
  it("preserves an in-flight canonical roster refresh while chat startup is delayed", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          deferredMethods: ["chat.startup"],
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("agents.list");
        await gateway.deferNext("agents.list");
        await gateway.emitGatewayEvent("config.changed", { path: "agents.entries" });
        await gateway.waitForRequest("agents.list", { after: 1 });
        await gateway.resolveDeferred("chat.startup", {
          messages: [],
          metadata: { models: [] },
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        });
        await gateway.resolveDeferred("agents.list", {
          defaultId: "research",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "research", name: "Research" }],
        });

        await expect.poll(() => selectedAgentId(page)).toBe("research");
      },
    );
  });

  it("keeps a refreshed canonical roster while chat startup remains delayed", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          deferredMethods: ["chat.startup"],
          methodResponses: {
            "agents.list": {
              defaultId: "research",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "research", name: "Research" },
                { id: "writer", name: "Writer" },
              ],
            },
          },
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("agents.list");
        await gateway.emitGatewayEvent("config.changed", { path: "agents.entries" });
        await gateway.waitForRequest("agents.list", { after: 1 });

        await expect.poll(() => selectedAgentId(page)).toBe("research");

        await gateway.resolveDeferred("chat.startup", {
          messages: [],
          metadata: { models: [] },
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        });

        await expect.poll(() => selectedAgentId(page)).toBe("research");
        await expect
          .poll(() =>
            page.locator("openclaw-chat-pane").evaluate((pane) => {
              const state = (
                pane as HTMLElement & {
                  state?: {
                    agentsList?: { agents?: Array<{ id?: string }>; defaultId?: string };
                    agentsSelectedId?: string;
                  };
                }
              ).state;
              return {
                defaultId: state?.agentsList?.defaultId,
                ids: state?.agentsList?.agents?.map((agent) => agent.id),
                selectedId: state?.agentsSelectedId,
              };
            }),
          )
          .toEqual({
            defaultId: "research",
            ids: ["research", "writer"],
            selectedId: "research",
          });
      },
    );
  });

  it("updates the compact session scope label and exposes All agents", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: multiAgentRoster,
            },
            "sessions.list": {
              count: 0,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions: [],
              ts: Date.now(),
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}sessions`);
        await gateway.waitForRequest("agents.list");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("main");

        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Writer" })
          .click();

        await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await expect
          .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
          .toBe("Writer");
        await screenshot(page, "05-first-session-scope-switch.png");

        const sessionRequestsBeforeAll = (await gateway.getRequests("sessions.list")).length;
        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "All agents" })
          .evaluate((item) => (item as HTMLElement).click());
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests("sessions.list");
            return requests
              .slice(sessionRequestsBeforeAll)
              .some((request) => !Object.hasOwn(requestParams(request), "agentId"));
          })
          .toBe(true);
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("");
        await expect
          .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
          .toBe("All agents");
        await screenshot(page, "06-all-agents-session-scope.png");
      },
    );
  });
});
