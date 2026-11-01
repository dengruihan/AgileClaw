import { expect, it } from "vitest";
import {
  WORKSPACE,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps Local visible when the Gateway is the only place", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available" }],
          profiles: [],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      await page.locator('[data-value="gateway"]').waitFor();
    } finally {
      await context.close();
    }
  });

  it.each(["hover", "click"] as const)(
    "keeps cloud machines usable when the picker finishes opening after a profile %s",
    async (input) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn"],
                machines: [
                  { id: "standard", label: "Standard", default: true },
                  { id: "fast", label: "Fast" },
                ],
              },
            ],
          },
          "worktrees.branches": { branches: [], repositoryStatus: "git" },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        const picker = page.locator("wa-popover.new-session-page__where-popover");
        await picker.evaluate((element) =>
          (element as HTMLElement).style.setProperty("--show-duration", "60s"),
        );
        const where = page.locator("#new-session-where-trigger");
        await where.click();
        const popup = picker.locator('wa-popup [part="popup"]').first();
        await expect
          .poll(() => popup.evaluate((element) => element.getAnimations().length))
          .toBe(1);
        // Hold the actual opening animation until the user has opened cloud configuration.
        await popup.evaluate((element) => {
          const animation = element.getAnimations()[0]!;
          animation.pause();
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) - 1;
        });
        await expect
          .poll(() =>
            picker.getByRole("searchbox").evaluate((element) => element.matches(":focus")),
          )
          .toBe(true);
        const profile = picker.locator('[data-value="cloud:aws"]');
        await profile[input]();
        const fast = picker.locator('[data-value="machine:fast"]');
        await fast.waitFor();
        await popup.evaluate((element) =>
          Promise.all(
            element.getAnimations().map((animation) => {
              animation.finish();
              return animation.finished;
            }),
          ),
        );
        if (input === "click") {
          expect(await profile.evaluate((element) => element.matches(":focus"))).toBe(true);
        }
        await fast.click();
        await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("aws");
        await expect.poll(() => where.getAttribute("data-machine-class")).toBe("fast");
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    { name: "AgileClaw", runtime: "openclaw" },
    { name: "Codex", runtime: "codex" },
  ] as const)(
    "keeps the same multimode Crabbox profile selectable for $name",
    async ({ runtime }) => {
      const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.5",
        models: [
          {
            id: "gpt-5.5",
            name: "gpt-5.5",
            provider: "openai",
            agentRuntime: {
              id: runtime,
              cloudPlacementSupported: true,
              cloudPlacementExecutionMode: runtime === "codex" ? "remote-exec" : "worker-turn",
              source: "model",
            },
          },
        ],
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [
              {
                id: "aws",
                providerId: "crabbox",
                executionMode: "worker-turn",
                executionModes: ["worker-turn", "remote-exec"],
              },
            ],
          },
          "worktrees.branches": { branches: [], repositoryStatus: "git" },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("environments.list");
        await gateway.waitForRequest("models.list");
        await page.locator("#new-session-where-trigger").click();

        const profile = page.locator('[data-value="cloud:aws"]');
        await profile.waitFor();
        await expect.poll(() => profile.isEnabled()).toBe(true);
        await profile.click();
        await expect
          .poll(() => page.locator("#new-session-where-trigger").textContent())
          .toContain("aws");
      } finally {
        await context.close();
      }
    },
  );

  it("refreshes authoritative device capacity from Gateway topology events", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Build runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 2, available: 1 },
            },
          ],
          profiles: [],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const runner = page.locator('[data-value="device:runner"]');
      const details = runner
        .locator("xpath=ancestor::openclaw-tooltip[1]")
        .locator('[slot="content"]');
      await runner.waitFor();
      expect(await runner.isEnabled()).toBe(true);

      const requests = (await gateway.getRequests("environments.list")).length;
      await gateway.setMethodResponse("environments.list", {
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 2, available: 0 },
          },
        ],
        profiles: [],
      });
      await gateway.emitGatewayEvent("node.runnerInventory.changed", { nodeId: "runner" });
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(requests);
      await expect.poll(() => runner.isDisabled()).toBe(true);
      await runner.hover();
      await expect
        .poll(() => details.textContent())
        .toContain("No worker slots are available. Wait for a slot or pick another device.");
      expect(await runner.locator(".session-menu__description").count()).toBe(0);
      expect(await details.locator(".new-session-page__capacity-caption").count()).toBe(0);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
