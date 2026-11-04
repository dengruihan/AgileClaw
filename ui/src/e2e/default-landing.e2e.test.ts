import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI default landing mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

// The draft composer needs the same place facts the direct /new entry uses.
const draftGatewayResponses = {
  "environments.list": { environments: [], profiles: [] },
  "projects.list": { projects: [] },
  "worktrees.branches": { branches: [], repositoryStatus: "git" },
  "sessions.create": { key: "agent:main:landing-proof", runStarted: true },
};

const draftFeatureMethods = [
  "chat.metadata",
  "chat.startup",
  "projects.list",
  "sessions.create",
  "sessions.dispatch",
];

suite.define(() => {
  it("opens the bare root without a model as an unsent draft that offers the current Models entry", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: null,
        featureMethods: [
          ...draftFeatureMethods,
          "openclaw.setup.detect",
          "openclaw.setup.prepare.start",
        ],
        methodResponses: draftGatewayResponses,
      });
      await page.goto(suite.server.baseUrl);
      await page.waitForURL((url) => url.pathname === "/new");
      await page.getByText("No AI provider configured", { exact: false }).first().waitFor();
      await page.getByRole("button", { name: "Connect an AI provider" }).waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(0);
      expect(new URL(page.url()).pathname).not.toContain("model-setup");
    });
  });

  it("restores the same draft after reload and creates the session only on send", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: draftFeatureMethods,
        methodResponses: draftGatewayResponses,
      });
      await page.goto(suite.server.baseUrl);
      await page.waitForURL((url) => url.pathname === "/new");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Landing draft keeps this text across reload");
      await page.reload();
      await page.waitForURL((url) => url.pathname === "/new");
      await expect
        .poll(() => composer.inputValue())
        .toBe("Landing draft keeps this text across reload");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await composer.press("Enter");
      await gateway.waitForRequest("sessions.create");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });

  it("keeps explicit session deep links on their session", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:landing-deep-link-proof";
      const session = {
        key: sessionKey,
        sessionId: "landing-deep-link-proof-session",
        kind: "direct" as const,
        label: "Deep link target",
        updatedAt: Date.now() - 1_000,
      };
      const history = {
        messages: [
          {
            role: "user",
            content: "Existing conversation stays reachable",
            timestamp: Date.now() - 2_000,
          },
        ],
        pendingInputs: { items: [], total: 0 },
        sessionId: session.sessionId,
        sessionInfo: session,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [session],
        methodResponses: {
          "chat.startup": history,
          "chat.history": history,
          "sessions.list": chatSessionListResponse([session]),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Existing conversation stays reachable").waitFor();
      expect(new URL(page.url()).pathname).not.toBe("/new");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("lands read-only connections on the session list", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: null,
        featureMethods: draftFeatureMethods,
        operatorScopes: ["operator.read"],
        sessions: [
          {
            key: "agent:main:read-only-visible",
            sessionId: "read-only-visible-session",
            kind: "direct" as const,
            label: "Readable session",
            updatedAt: Date.now() - 1_000,
          },
        ],
      });
      await page.goto(suite.server.baseUrl);
      await page.waitForURL((url) => url.pathname === "/sessions");
      await page.getByText("Readable session").first().waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("names the draft with the resolved default agent in multi-agent rosters", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: draftFeatureMethods,
        methodResponses: draftGatewayResponses,
        defaultAgentId: "research",
      });
      await page.goto(suite.server.baseUrl);
      await page.waitForURL((url) => url.pathname === "/new");
      await page.waitForURL((url) => url.searchParams.get("agent") === "research");
      expect(new URL(page.url()).pathname).toBe("/new");
    });
  });
});
