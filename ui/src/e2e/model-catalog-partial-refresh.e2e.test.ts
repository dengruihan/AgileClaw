import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import partialConfig from "../../../test/fixtures/config-corpus/provider-partially-unavailable.json" with { type: "json" };
import type { ModelCatalogResult } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Partial provider refresh controls" });
const levels = ["off", "low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({
  id,
  label: id,
}));
const catalog: ModelCatalogResult = {
  models: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      available: true,
      reasoning: true,
      supportsFastMode: true,
      thinkingLevels: levels,
      thinkingDefault: "high",
    },
    {
      id: "unavailable-model",
      name: "Unavailable Copilot model",
      provider: "github-copilot",
      available: false,
      unavailableReason: "missing-auth",
      thinkingLevels: [],
    },
  ],
  refreshFailed: true,
  providerOutcomes: [
    { provider: "openai", status: "ready" },
    { provider: "github-copilot", status: "unavailable" },
  ],
};

function readControls(page: Page) {
  return page
    .locator(".agent-chat__input")
    .first()
    .evaluate((composer) => {
      const effort = composer.querySelector<HTMLElement>("[data-chat-thinking-select]");
      return {
        text: composer.textContent,
        notice: composer.querySelector("[data-chat-model-catalog-state]")?.textContent,
        effort: effort
          ? {
              label: effort.getAttribute("aria-label"),
              visible: effort.checkVisibility({ visibilityProperty: true }),
              disabled: effort.getAttribute("aria-disabled"),
              reserved: effort.closest("details")?.getAttribute("aria-hidden"),
              value: effort.getAttribute("data-chat-thinking-value"),
              fast: effort.getAttribute("data-chat-fast-mode"),
            }
          : null,
      };
    });
}

async function captureControls(page: Page, stage: string) {
  const controls = await readControls(page);
  await writeFile(path.join(suite.artifactDir, `${stage}.json`), JSON.stringify(controls, null, 2));
  await page.screenshot({
    path: path.join(suite.artifactDir, `${stage}.png`),
    animations: "disabled",
  });
}

suite.define(() => {
  it.each(["empty", "rejected", "retained rejection", "selected unavailable", "non-reasoning"])(
    "does not expose usable effort for %s",
    async (condition) => {
      await suite.withPage({ locale: "en-US" }, async ({ page }) => {
        const selected = {
          ...catalog.models[0]!,
          available: condition !== "selected unavailable",
          supportsFastMode: condition !== "non-reasoning",
          reasoning: condition !== "non-reasoning",
          thinkingLevels: condition === "non-reasoning" ? [] : levels,
        };
        const models =
          condition === "empty"
            ? []
            : [selected, { id: "other", name: "Other", provider: "example", available: true }];
        const failure = { __mockError: { code: "UNAVAILABLE", message: "Catalog request failed" } };
        const gateway = await installMockGateway(page, {
          agentModel: partialConfig.agents.defaults.model,
          models,
          sessionInfo: {
            model: selected.id,
            modelProvider: selected.provider,
            thinkingLevels: selected.thinkingLevels,
          },
          methodResponses: {
            "models.list": condition === "rejected" ? failure : { ...catalog, models },
            "sessions.list": {
              ts: 1,
              path: "",
              count: 1,
              defaults: {
                model: selected.id,
                modelProvider: selected.provider,
                thinkingLevels: selected.thinkingLevels,
                thinkingDefault: condition === "non-reasoning" ? "off" : "high",
              },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  model: selected.id,
                  modelProvider: selected.provider,
                  thinkingLevels: selected.thinkingLevels,
                  thinkingDefault: condition === "non-reasoning" ? "off" : "high",
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const model = page.locator("[data-chat-model-select]");
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        if (condition === "retained rejection") {
          await expect
            .poll(() => page.locator("[data-chat-thinking-select]").isVisible())
            .toBe(true);
          await gateway.setMethodResponse("models.list", failure);
        }
        await model.click();
        const notice = page.locator("[data-chat-model-catalog-state]");
        if (["empty", "rejected", "retained rejection"].includes(condition)) {
          await expect.poll(() => notice.isVisible()).toBe(true);
        } else {
          expect(await notice.count()).toBe(0);
        }
        await expect
          .poll(async () => {
            const { effort } = await readControls(page);
            return !effort || effort.reserved === "true" || effort.disabled === "true";
          })
          .toBe(true);
        await captureControls(page, `${condition}-open`);
        await model.click();
        await expect
          .poll(async () => {
            const { effort } = await readControls(page);
            return !effort || effort.disabled === "true";
          })
          .toBe(true);
        await captureControls(page, `${condition}-closed`);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      });
    },
  );
});
