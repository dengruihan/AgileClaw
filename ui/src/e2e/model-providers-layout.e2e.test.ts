import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw, resolveConfigMutation } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models settings layout and discovery" });
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

suite.define(() => {
  it("keeps connection drafts while searching and requires an explicit decision before switching providers", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const config = {
          models: {
            providers: {
              alpha: { baseUrl: "https://alpha.example/v1", api: "openai-completions", models: [] },
              beta: { baseUrl: "https://beta.example/v1", api: "anthropic-messages", models: [] },
            },
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "workspace-drafts",
              raw: JSON.stringify(config),
              valid: true,
              issues: [],
            },
            "models.list": { models: [] },
            "models.authStatus": { ts: 1, providers: [] },
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const alpha = page.locator('[data-provider-select="alpha"]');
        const beta = page.locator('[data-provider-select="beta"]');
        await alpha.click();
        const editor = page.locator(".provider-manager--inline");
        const baseUrl = editor.locator('[name="baseUrl"]');
        await expect.poll(() => baseUrl.isEnabled()).toBe(true);
        await baseUrl.fill("https://draft.example/v1");
        const search = page.getByRole("searchbox", { name: "Search providers…" });
        await search.fill("beta");
        expect(await alpha.count()).toBe(0);
        expect(await baseUrl.inputValue()).toBe("https://draft.example/v1");
        await beta.click();
        const confirmation = page.locator(
          'openclaw-modal-dialog[label="Discard unsaved changes?"]',
        );
        await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await baseUrl.inputValue()).toBe("https://draft.example/v1");
        expect(await beta.getAttribute("aria-pressed")).toBe("false");
        await beta.click();
        await confirmation.getByRole("button", { name: "Discard changes", exact: true }).click();
        await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => baseUrl.inputValue()).toBe("https://beta.example/v1");
        await search.fill("");
        await alpha.click();
        await expect.poll(() => baseUrl.inputValue()).toBe("https://alpha.example/v1");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      },
    );
  });

  it("creates a custom provider and persists model dialog edits without submitting the connection form", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config: {},
              sourceConfig: {},
              hash: "workspace-create",
              raw: "{}",
              valid: true,
              issues: [],
            },
            "models.list": { models: [] },
            "models.authStatus": { ts: 1, providers: [] },
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator("[data-custom-provider]").click();
        const editor = page.locator(".provider-manager--inline");
        await editor.locator('[name="providerId"]').fill("workspace-custom");
        await editor.locator('[name="baseUrl"]').fill("https://custom.example/v1");
        await editor.locator('[name="api"]').selectOption("anthropic-messages");
        await gateway.deferNext("config.patch");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        const connection = {
          baseUrl: "https://custom.example/v1",
          api: "anthropic-messages",
          models: [],
        };
        expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
          models: { providers: { "workspace-custom": connection } },
        });
        await resolveConfigMutation(
          gateway,
          { models: { providers: { "workspace-custom": connection } } },
          "workspace-created",
        );
        const selected = page.locator('[data-provider-select="workspace-custom"]');
        await expect.poll(() => selected.getAttribute("aria-pressed")).toBe("true");
        await editor.locator('[name="baseUrl"]').fill("https://unsaved.example/v1");
        await editor.getByRole("button", { name: "Add model", exact: true }).click();
        const dialog = page.locator('openclaw-modal-dialog[label="Edit model"]');
        await dialog.locator('[name="id"]').fill("custom-model");
        await dialog.locator('[name="name"]').fill("Custom model");
        await dialog.locator('[name="contextWindow"]').fill("128000");
        await dialog.locator('[name="maxTokens"]').fill("8192");
        await gateway.deferNext("config.patch");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        const model = {
          id: "custom-model",
          name: "Custom model",
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
          metadataSource: "models-add",
        };
        const patch = await gateway.waitForRequest("config.patch", { after: 1 });
        expect(requestRaw(patch)).toEqual({
          models: { providers: { "workspace-custom": { models: [model] } } },
        });
        const saved = {
          models: { providers: { "workspace-custom": { ...connection, models: [model] } } },
        };
        await resolveConfigMutation(gateway, saved, "workspace-model-created");
        await dialog.locator("form").waitFor({ state: "hidden" });
        const row = editor.locator('[data-model-id="custom-model"]');
        await row.getByRole("button", { name: "Edit model", exact: true }).click();
        expect(await dialog.locator('[name="contextWindow"]').inputValue()).toBe("128000");
        await dialog.locator('[name="name"]').fill("Renamed model");
        await dialog.locator('[name="maxTokens"]').fill("16384");
        await gateway.deferNext("config.patch");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        const edited = { ...model, name: "Renamed model", maxTokens: 16384 };
        expect(requestRaw(await gateway.waitForRequest("config.patch", { after: 2 }))).toEqual({
          models: { providers: { "workspace-custom": { models: [edited] } } },
        });
        await resolveConfigMutation(
          gateway,
          { models: { providers: { "workspace-custom": { ...connection, models: [edited] } } } },
          "workspace-model-edited",
        );
        await dialog.locator("form").waitFor({ state: "hidden" });
        await expect.poll(() => row.textContent()).toContain("Renamed model");
        expect(await gateway.getRequests("config.patch")).toHaveLength(3);
        expect(await editor.locator('[name="baseUrl"]').inputValue()).toBe(
          "https://unsaved.example/v1",
        );
        await page.reload();
        await selected.click();
        await row.getByRole("button", { name: "Edit model", exact: true }).click();
        expect(await dialog.locator('[name="name"]').inputValue()).toBe("Renamed model");
        expect(await dialog.locator('[name="maxTokens"]').inputValue()).toBe("16384");
        expect(await editor.locator('[name="baseUrl"]').inputValue()).toBe(
          "https://custom.example/v1",
        );
        expect(await editor.locator('[name="api"]').inputValue()).toBe("anthropic-messages");
      },
    );
  });
  it.each([1440, 1100, 768, 640, 390])(
    "Models page keeps controls separate and publishes discovery into a passive picker at %ipx",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 1000 } },
        async ({ page }) => {
          const models = [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
            { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai", available: true },
          ];
          const config = {
            agents: { defaults: { model: "openai/gpt-5.5", decisionModel: "typesafe/jev-latest" } },
          };
          const catalog = {
            models,
            decisionModels: [
              { provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" },
            ],
            defaultModels: { automaticUtilityModel: "openai/gpt-5-mini" },
          };
          const gateway = await installMockGateway(page, {
            models,
            methodResponses: {
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: [
                  {
                    id: "main",
                    name: "Research and engineering assistant",
                    identity: { emoji: "🦞" },
                  },
                  { id: "work", name: "Work" },
                ],
              },
              "config.get": {
                config,
                sourceConfig: config,
                hash: "models-layout",
                raw: JSON.stringify(config),
                valid: true,
                issues: [],
              },
              "models.list": catalog,
              "models.authStatus": {
                ts: Date.now(),
                providers: [
                  {
                    provider: "openai",
                    displayName: "OpenAI",
                    status: "ok",
                    profiles: [
                      {
                        profileId: "openai:alex",
                        type: "oauth",
                        status: "ok",
                        email: "alex@example.com",
                      },
                    ],
                  },
                ],
              },
              "usage.status": { updatedAt: Date.now(), providers: [] },
              "sessions.usage": { aggregates: { byProvider: [] } },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          const primary = page.getByRole("button", { name: /^Model: GPT-5.5/ });
          await primary.waitFor();
          await expect.poll(() => primary.textContent()).toContain("alex@example.com");
          const utility = page.getByRole("button", { name: /^Utility Model: Auto/ });
          await expect.poll(() => utility.textContent()).toContain("GPT-5 mini");
          await expect.poll(() => utility.textContent()).toContain("alex@example.com");
          const decision = page.locator(
            "openclaw-select-picker:has(#model-providers-decision-model)",
          );
          await expect
            .poll(() => decision.locator(".picker-select__trigger").textContent())
            .toContain("Jev");
          expect(
            await decision.locator('[role="option"][data-value="typesafe/jev-latest"]').count(),
          ).toBe(1);
          const rows = await page
            .locator(".model-providers__defaults .settings-row")
            .evaluateAll((elements) =>
              elements.map((row) => {
                const label = row.querySelector(".settings-row__text")!.getBoundingClientRect();
                const control = row
                  .querySelector(".settings-row__control")!
                  .getBoundingClientRect();
                return {
                  role: (
                    row.querySelector(".model-providers__label-with-help > span:first-child") ??
                    row.querySelector(".settings-row__title")
                  )?.textContent?.trim(),
                  sideBySide: label.right <= control.left && label.bottom > control.top,
                  stacked: label.bottom <= control.top,
                };
              }),
            );
          expect(rows.map((row) => row.role)).toEqual([
            "Model",
            "Utility Model",
            "Decision Model",
            "Fallback Model",
            "Thinking",
            "Fast Mode",
          ]);
          expect(rows.every((row) => (width > 640 ? row.sideBySide : row.stacked))).toBe(true);
          await page
            .locator(".settings-sidebar openclaw-agent-select")
            .waitFor({ state: "attached" });
          expect(await page.locator(".content openclaw-agent-select").count()).toBe(0);
          expect(await page.locator(".settings-sidebar openclaw-agent-select").count()).toBe(1);
          const bounds = await page
            .locator("[data-models-connect], .model-providers__refresh-button")
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const { x, y, width: buttonWidth, height } = button.getBoundingClientRect();
                return { x, y, width: buttonWidth, height };
              }),
            );
          expect(bounds).toHaveLength(2);
          for (const [index, box] of bounds.entries()) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            for (const other of bounds.slice(index + 1)) {
              const overlaps =
                box.x < other.x + other.width &&
                other.x < box.x + box.width &&
                box.y < other.y + other.height &&
                other.y < box.y + box.height;
              expect(overlaps).toBe(false);
            }
          }
          if (recordVisuals) {
            await page.screenshot({ path: path.join(suite.artifactDir, `models-${width}.png`) });
          }
          await primary.scrollIntoViewIfNeeded();
          const beforeDiscovery = await primary.boundingBox();
          const requestsBeforeOpen = await gateway.getRequests("models.list");
          await primary.click();
          await page.locator('.model-providers__defaults [role="listbox"]').first().waitFor();
          expect(await gateway.getRequests("models.list")).toEqual(requestsBeforeOpen);
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            pendingProviders: ["openai"],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          const progress = page.locator('.model-providers__catalog-progress[role="status"]');
          await progress.waitFor();
          expect(await primary.boundingBox()).toEqual(beforeDiscovery);
          expect(await progress.locator('[aria-hidden="true"]').count()).toBe(1);
          if (recordVisuals) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `discovering-${width}.png`),
            });
          }
          await gateway.setMethodResponse("models.list", {
            ...catalog,
            models: [
              ...models,
              { id: "account-new", name: "New account model", provider: "openai", available: true },
            ],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await expect.poll(() => progress.count()).toBe(0);
          await page
            .locator('.model-providers__defaults [role="option"][data-value="openai/account-new"]')
            .first()
            .waitFor({ state: "visible" });
          expect(await primary.getAttribute("aria-expanded")).toBe("true");
          expect(await primary.textContent()).toContain("GPT-5.5");
          expect(
            await decision.locator('[role="option"][data-value="openai/account-new"]').count(),
          ).toBe(0);
          expect(await decision.locator(".picker-select__trigger").textContent()).toContain("Jev");
        },
      );
    },
  );
});
