import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "model-picker-refresh"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(path.join(suite.artifactDir, "model-picker-refresh"), name),
  });
}

suite.define(() => {
  it("opens the chat picker from a partial snapshot while catalog revalidation is pending", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const prepared = {
      id: "prepared",
      name: "Prepared model",
      provider: "fixture",
      available: true,
    };
    const added = { ...prepared, id: "added", name: "Added model" };
    const gateway = await installMockGateway(page, {
      sessionKey,
      models: [],
      heldMethods: ["models.list"],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("models.list");
      await gateway.emitGatewayEvent("models.snapshot", {
        target: { agentId: "main", sessionKey },
        scope: { agentId: "main", sessionKey },
        catalog: { models: [prepared], refreshFailed: true },
      });
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await picker.locator("[data-chat-model-select]").click();
      const preparedRow = picker.locator('[data-chat-model-option="fixture/prepared"]');
      await revealChatModelOption(preparedRow);
      await expect.poll(() => preparedRow.isVisible()).toBe(true);
      expect(await preparedRow.isEnabled()).toBe(true);

      await gateway.resolveDeferred("models.list", { models: [prepared, added] });
      await expect
        .poll(() => picker.locator('[data-chat-model-option="fixture/added"]').isVisible())
        .toBe(true);
      expect(await picker.getAttribute("open")).not.toBeNull();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the configured model order and catalog across selections", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "model-picker-refresh"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const modelIds = ["alpha", "bravo", "charlie", "delta", "echo"];
    // The mocked Gateway hands the renderer this array directly; the real
    // configured projection's authored order is covered by
    // src/gateway/server-methods/models-list-result.picker-order.test.ts.
    const models = modelIds.map((id) => ({
      id,
      name: `Model ${id[0]!.toUpperCase()}${id.slice(1)}`,
      provider: "fixture",
      available: true,
    }));
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-order-proof",
      model: "echo",
      modelProvider: "fixture",
      modelOverrideSource: "user",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      agentModel: "fixture/charlie",
      models,
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            contextTokens: null,
            model: "charlie",
            modelProvider: "fixture",
            modelSelectionTarget: "session",
          },
        },
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      await gateway.waitForRequest("models.list");
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      const trigger = picker.locator('[data-chat-model-select="true"]');
      await trigger.click();
      const options = picker.locator("button[data-chat-model-option]");
      await expect.poll(() => options.count()).toBe(modelIds.length);
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await expect
        .poll(() => picker.locator('[data-chat-model-option="fixture/echo"]').isVisible())
        .toBe(true);
      const configuredOrder = modelIds.map((id) => `fixture/${id}`);
      const renderedOrder = () =>
        options.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-chat-model-option")),
        );
      // The catalog owner (model settings) authored this order; the selected
      // last row and the mid-list default row must not be promoted.
      await screenshot(page, "11-configured-order-before-selection.png");
      expect(await renderedOrder()).toEqual(configuredOrder);
      expect(
        await picker
          .locator('[data-chat-model-default="true"]')
          .getAttribute("data-chat-model-option"),
      ).toBe("fixture/charlie");
      expect(
        await picker
          .locator('[data-chat-model-option="fixture/echo"]')
          .getAttribute("aria-selected"),
      ).toBe("true");
      const modelsListReads = (await gateway.getRequests("models.list")).length;

      const selectConfiguredModel = async (id: string) => {
        const patches = (await gateway.getRequests("sessions.patch")).length;
        await picker.locator(`[data-chat-model-option="fixture/${id}"]`).click();
        const request = await gateway.waitForRequest("sessions.patch", { after: patches });
        expect(request.params).toMatchObject({ key: session.key, model: `fixture/${id}` });
        await expect
          .poll(() => trigger.getAttribute("data-chat-select-value"))
          .toBe(`fixture/${id}`);
        await expect
          .poll(() =>
            picker
              .locator(`[data-chat-model-option="fixture/${id}"]`)
              .getAttribute("aria-selected"),
          )
          .toBe("true");
        // Selection updates state only: no catalog refetch, loading flash, row
        // movement, or dropdown close.
        expect(await renderedOrder()).toEqual(configuredOrder);
        expect(await gateway.getRequests("models.list")).toHaveLength(modelsListReads);
        expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
        expect(await picker.locator(".chat-controls__model-trigger-skeleton").count()).toBe(0);
        expect(await options.count()).toBe(modelIds.length);
        expect(await picker.getAttribute("open")).not.toBeNull();
        expect(
          await page.evaluate(
            () =>
              (document.activeElement as HTMLElement | null)?.getAttribute(
                "data-chat-model-option",
              ) ?? null,
          ),
        ).toBe(`fixture/${id}`);
      };

      await selectConfiguredModel("delta");
      await screenshot(page, "12-configured-order-after-delta.png");
      await selectConfiguredModel("bravo");
      await screenshot(page, "13-configured-order-after-bravo.png");

      await page.setViewportSize({ height: 844, width: 390 });
      await expect.poll(() => options.count()).toBe(modelIds.length);
      expect(await renderedOrder()).toEqual(configuredOrder);
      await screenshot(page, "14-configured-order-narrow.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("preserves the Gateway-resolved target without exposing it in the picker", async () => {
    const context = await suite.newBrowserContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "model-picker-refresh"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-target-proof",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            contextTokens: null,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            modelSelectionTarget: "global",
          },
        },
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      let picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await picker.locator('[data-chat-model-select="true"]').tap();
      await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).waitFor();
      await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
      await screenshot(page, "05-picker-before-touch-selection.png");

      await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).tap();
      const request = await gateway.waitForRequest("sessions.patch");
      expect(request.params).toMatchObject({
        key: "agent:main:main",
        model: "openai/gpt-5.6-terra",
      });
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("openai/gpt-5.6-terra");
      await screenshot(page, "06-picker-after-touch-selection.png");

      await gateway.setSessionsListResponse({
        ts: 2,
        path: "",
        count: 1,
        sessions: [
          {
            ...session,
            model: "gpt-5.6-terra",
            modelOverrideSource: "user",
            updatedAt: 2,
          },
        ],
        defaults: {
          contextTokens: null,
          model: "gpt-5.6-terra",
          modelProvider: "openai",
          modelSelectionTarget: "global",
        },
      });

      await page.reload();
      picker = page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker');
      await picker.locator('[data-chat-model-select="true"]').tap();
      await picker.locator('[data-chat-model-default="true"]').waitFor();
      await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("openai/gpt-5.6-terra");
      await screenshot(page, "07-picker-after-reload.png");
      await page.setViewportSize({ height: 900, width: 400 });
      const defaultRow = picker.locator('[data-chat-model-default="true"]');
      await expect
        .poll(async () => {
          const bounds = await defaultRow.boundingBox();
          return Boolean(
            bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= 401,
          );
        })
        .toBe(true);
      await screenshot(page, "08-default-row-mobile.png");
      const configureModels = picker
        .getByRole("button", { name: "Configure models", exact: true })
        .first();
      await expect
        .poll(() =>
          configureModels.evaluate((button) => {
            const heading = button.closest<HTMLElement>("[data-chat-model-provider]");
            if (!heading) {
              return Number.POSITIVE_INFINITY;
            }
            return heading.getBoundingClientRect().right - button.getBoundingClientRect().right;
          }),
        )
        .toBeLessThanOrEqual(11);
      await expect
        .poll(() =>
          configureModels.locator("svg").evaluate((icon) => icon.getBoundingClientRect().width),
        )
        .toBeLessThanOrEqual(12);
      await configureModels.hover();
      await page.waitForTimeout(800);
      const configureModelsTooltip = page.locator("wa-tooltip[open]").filter({
        hasText: "Configure models",
      });
      await expect.poll(() => configureModelsTooltip.count()).toBe(0);
      await screenshot(page, "09-configure-models-no-tooltip.png");
      await configureModels.tap();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).searchParams.get("provider")).toBe("openai");
      expect(new URL(page.url()).searchParams.has("connect")).toBe(false);
      await page.locator('[data-provider-id="openai"]').waitFor({ state: "visible" });
      await screenshot(page, "10-provider-settings-navigation.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clears a persisted pin matching the default through the default model row", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "model-picker-refresh"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-pin-proof",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelOverrideSource: "user",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessionInfo: session,
      models: [{ id: "gpt-5.5", name: "Proof Model", provider: "openai" }],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
        },
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await picker.locator('[data-chat-model-select="true"]').click();
      await revealChatModelOption(picker.locator('[data-chat-model-default="true"]'));
      await screenshot(page, "03-pin-matching-default.png");
      await picker.getByRole("option", { name: "Proof Model", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.patch");
      expect(request.params).toMatchObject({ key: "agent:main:main", model: null });
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("");
      await picker.locator('[data-chat-model-select="true"]').click();
      await screenshot(page, "04-pin-cleared.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
