import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import partialConfig from "../../../test/fixtures/config-corpus/provider-partially-unavailable.json" with { type: "json" };
import type { ModelCatalogResult } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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

type EffortAvailability = "usable" | "disabled" | "absent";

function readControls(page: Page) {
  return page
    .locator(".agent-chat__input")
    .first()
    .evaluate((composer) => {
      const trigger = composer.querySelector<HTMLElement>("[data-chat-model-select]");
      const slider = composer.querySelector<HTMLInputElement>("[data-chat-thinking-slider]");
      return {
        notice: composer.querySelector("[data-chat-model-catalog-state]")?.textContent,
        // The merged control keeps one trigger for model selection plus the
        // effort section that appears inside its menu.
        trigger: {
          disabled: trigger?.getAttribute("aria-disabled") ?? null,
          thinkingDisabled: trigger?.getAttribute("data-chat-thinking-disabled") ?? null,
        },
        panel: composer.querySelector(".chat-controls__reasoning-panel") !== null,
        sliderDisabled: slider?.disabled ?? null,
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

function effortControls(controls: Awaited<ReturnType<typeof readControls>>) {
  return {
    trigger: {
      disabled: controls.trigger.disabled,
      thinkingDisabled: controls.trigger.thinkingDisabled,
    },
    panel: controls.panel,
    sliderDisabled: controls.sliderDisabled,
  };
}

function expectedEffortControls(effort: EffortAvailability) {
  const trigger = { disabled: "false" };
  if (effort === "absent") {
    return {
      trigger: { ...trigger, thinkingDisabled: "true" },
      panel: false,
      sliderDisabled: null,
    };
  }
  return {
    trigger: { ...trigger, thinkingDisabled: effort === "disabled" ? "true" : "false" },
    panel: true,
    sliderDisabled: effort === "disabled",
  };
}

suite.define(() => {
  it.each([
    // A loaded catalog snapshot is what gates effort, not the model's presence:
    // the session row owns its thinking profile, so effort stays usable while a
    // snapshot exists even when that model is missing or marked unavailable.
    { condition: "empty", effort: "usable" },
    { condition: "rejected", effort: "disabled" },
    // A failed refresh retains the previous snapshot, so effort stays usable.
    { condition: "retained rejection", effort: "usable" },
    { condition: "selected unavailable", effort: "usable" },
    { condition: "non-reasoning", effort: "absent" },
  ] as const)(
    "gates the merged effort control by the catalog snapshot for $condition",
    async ({ condition, effort }) => {
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
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const model = page.locator("[data-chat-model-select]");
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        if (condition === "retained rejection") {
          await expect.poll(async () => (await readControls(page)).panel).toBe(true);
          await gateway.setMethodResponse("models.list", failure);
        }
        await model.click();
        const notice = page.locator("[data-chat-model-catalog-state]");
        if (["empty", "rejected", "retained rejection"].includes(condition)) {
          await expect.poll(() => notice.isVisible()).toBe(true);
        } else {
          expect(await notice.count()).toBe(0);
        }
        // The merged trigger always serves model selection, so catalog state
        // must never disable it; only the effort section reflects usability.
        const expected = expectedEffortControls(effort);
        await expect.poll(async () => effortControls(await readControls(page))).toEqual(expected);
        await captureControls(page, `${condition}-open`);
        await model.click();
        await expect.poll(async () => effortControls(await readControls(page))).toEqual(expected);
        await captureControls(page, `${condition}-closed`);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      });
    },
  );
});
