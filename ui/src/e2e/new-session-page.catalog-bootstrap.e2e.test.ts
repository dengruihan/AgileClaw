import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps an ordinary catalog winner when its initial snapshot arrives later", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const current = { provider: "fixture", id: "current", name: "Current model", available: true };
    const older = { provider: "fixture", id: "older", name: "Older model", available: true };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "alpha",
      agentModel: "fixture/current",
      heldMethods: ["models.list"],
      models: [older],
      methodResponses: {
        "agents.list": {
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "alpha", name: "Alpha", model: { primary: "fixture/current" } }],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      await gateway.resolveDeferred("models.list", { models: [current] });
      const trigger = page.locator("[data-chat-model-select]");
      await trigger.click();
      const currentRow = page.locator('[data-chat-model-option="fixture/current"]');
      await revealChatModelOption(currentRow);
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      const count = (await gateway.getRequests("models.list")).length;
      await gateway.emitGatewayEvent("models.snapshot", {
        target: {},
        scope: { agentId: "alpha" },
        catalog: { models: [older] },
      });
      await trigger.click();
      await trigger.click();
      await revealChatModelOption(currentRow);
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(count);
    } finally {
      await context.close();
    }
  });
});
