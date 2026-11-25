// Control UI provider template picker E2E: the Add provider entries list the
// curated endpoint templates, a template prefills the create editor, and an
// endpoint that already has a config entry reports "Added" instead of creating a
// second provider. Assertions target the real page against a mocked Gateway.

import {
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
} from "@openclaw/model-catalog-core/provider-templates";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { applyMergePatch } from "../../../src/config/merge-patch.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw, resolveConfigMutation } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Provider template picker" });

const zhipuCoding = providerTemplate("zhipu-coding-cn");
const zhipuCodingKey = "custom-open-bigmodel-cn-coding";

function providerTemplate(id: string): ProviderTemplate {
  const template = PROVIDER_TEMPLATES.find((row) => row.id === id);
  if (!template) {
    throw new Error(`Expected curated provider template ${id}`);
  }
  return template;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asNullableRecord(value);
  if (!record) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return record;
}

function configSnapshot(config: unknown, hash: string) {
  return {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function settingsMocks(config: unknown, hash: string) {
  return {
    "config.get": configSnapshot(config, hash),
    "models.list": { models: [] },
    "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
    "usage.status": { updatedAt: 1, providers: [] },
    "sessions.usage": { aggregates: { byProvider: [] } },
  };
}

async function openModelsSettings(page: Page): Promise<void> {
  await page.goto(`${suite.server.baseUrl}settings/model-providers`);
  await page.locator(".model-providers__workspace").waitFor();
}

suite.define(() => {
  it("lists the template groups in curated order behind both add entries and keeps the custom entry blank", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: settingsMocks({}, "templates-empty"),
      });
      await openModelsSettings(page);
      const emptyAdd = page.locator(".model-providers__add-empty[data-custom-provider]");
      await expect.poll(() => emptyAdd.count()).toBe(1);
      expect(await page.locator(".settings-section__actions [data-custom-provider]").count()).toBe(
        1,
      );
      await emptyAdd.click();

      const panel = page.locator("[data-provider-template-picker]");
      await panel.waitFor();
      // Opening the entry lists templates; no editor opens behind the panel.
      expect(await page.locator("openclaw-provider-manager").count()).toBe(0);
      expect(
        await panel
          .locator("section[data-template-group]")
          .evaluateAll((sections) =>
            sections.map((section) => section.getAttribute("data-template-group")),
          ),
      ).toEqual(["zhipu", "other"]);
      expect(
        await panel
          .locator("[data-template-group] h3")
          .evaluateAll((headings) => headings.map((heading) => heading.textContent?.trim())),
      ).toEqual(["Zhipu", "Other"]);
      expect(
        await panel
          .locator("[data-template-group] [data-template-id]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-template-id"))),
      ).toEqual([
        "zhipu-coding-cn",
        "zai-coding",
        "zhipu-api-cn",
        "zai-api",
        "kimi",
        "kimi-cn",
        "kimi-code",
        "minimax",
        "minimax-cn",
        "deepseek",
        "bailian-cn",
        "bailian-intl",
        "bailian-coding-cn",
        "qwen-token-plan-cn",
      ]);
      // The blank custom form is the first choice in the picker body.
      expect(
        await panel.locator("[data-template-custom]").evaluate((custom) => {
          return custom.parentElement?.firstElementChild === custom;
        }),
      ).toBe(true);
      expect(await panel.locator("[data-template-added]").count()).toBe(0);

      await panel.locator("[data-template-custom]").click();
      const editor = page.locator(".provider-manager--inline");
      await editor.locator('[name="displayName"]').waitFor();
      expect(await panel.count()).toBe(0);
      expect(await editor.locator('[name="displayName"]').inputValue()).toBe("");
      expect(await editor.locator('[name="baseUrl"]').inputValue()).toBe("");
      expect(await editor.locator('select[name="api"]').inputValue()).toBe("openai-completions");
      // The blank flow has no curated models and no explicit create action.
      expect(await editor.locator("[data-model-id]").count()).toBe(0);
      expect(
        await editor.getByRole("button", { name: "Create provider", exact: true }).count(),
      ).toBe(0);
      expect(
        (await editor.locator(".provider-manager__identity .muted").textContent())?.trim(),
      ).toBe("");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });

  it("prefills the editor from a template, creates its endpoint key with models and icon, then reports it added", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: settingsMocks({}, "templates-create"),
      });
      await openModelsSettings(page);
      await page.locator(".settings-section__actions [data-custom-provider]").click();
      await page.locator('[data-template-id="zhipu-coding-cn"]').click();
      const editor = page.locator(".provider-manager--inline");
      await editor.locator('[name="displayName"]').waitFor();
      expect(await editor.locator('[name="displayName"]').inputValue()).toBe(
        "BigModel Coding Plan",
      );
      expect(await editor.locator('[name="baseUrl"]').inputValue()).toBe(
        zhipuCoding.provider.baseUrl,
      );
      expect(await editor.locator('select[name="api"]').inputValue()).toBe(
        zhipuCoding.provider.api,
      );
      expect(
        (await editor.locator(".provider-manager__identity .muted").textContent())?.trim(),
      ).toBe("");
      const create = editor.getByRole("button", { name: "Create provider", exact: true });
      await expect.poll(() => create.count()).toBe(1);

      await gateway.deferNext("config.patch");
      await create.click();
      const raw = requestRaw(await gateway.waitForRequest("config.patch"));
      // The template id never reaches config; its endpoint facts and curated models do.
      const entry = structuredClone({
        displayName: "BigModel Coding Plan",
        icon: "zai",
        baseUrl: zhipuCoding.provider.baseUrl,
        api: zhipuCoding.provider.api,
        models: zhipuCoding.provider.models,
      });
      expect(raw).toEqual({ models: { providers: { [zhipuCodingKey]: entry } } });
      const saved = requireRecord(applyMergePatch({}, raw), "merged provider config");
      await resolveConfigMutation(gateway, saved, "templates-created");

      const card = page.locator(`[data-provider-select="${zhipuCodingKey}"]`);
      await card.waitFor();
      expect((await card.textContent())?.trim()).toContain("BigModel Coding Plan");
      await expect
        .poll(() => card.locator(".provider-brand-icon").first().getAttribute("data-provider-icon"))
        .toBe("zai");
      // The saved entry lists the curated models and shows its claimed key.
      await expect
        .poll(() => editor.locator("[data-model-id]").count())
        .toBe(zhipuCoding.provider.models.length);
      expect(await editor.locator('[data-model-id="glm-5.3"]').count()).toBe(1);
      await expect
        .poll(async () =>
          (await editor.locator(".provider-manager__identity .muted").textContent())?.trim(),
        )
        .toBe(zhipuCodingKey);

      // A second visit to the same endpoint reports Added, opens that entry, and writes nothing.
      await page.locator(".settings-section__actions [data-custom-provider]").click();
      const row = page.locator('[data-template-id="zhipu-coding-cn"]');
      await expect.poll(() => row.getAttribute("data-template-added")).toBe("true");
      expect((await row.textContent())?.trim()).toContain("Added");
      await row.click();
      await expect.poll(() => page.locator("[data-provider-template-picker]").count()).toBe(0);
      await expect.poll(() => card.getAttribute("aria-pressed")).toBe("true");
      expect(await gateway.getRequests("config.patch")).toHaveLength(1);
    });
  });
});
