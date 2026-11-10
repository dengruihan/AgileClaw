import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw, resolveConfigMutation } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models settings layout and discovery" });
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

suite.define(() => {
  it("discards a late API-key response after switching providers", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const config = {
        models: {
          providers: {
            alpha: { baseUrl: "https://alpha.example.test/v1", models: [] },
            beta: { baseUrl: "https://beta.example.test/v1", models: [] },
          },
        },
      };
      const gateway = await installMockGateway(page, {
        deferredMethods: ["models.authInspectApiKey"],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash: "key-scope",
            valid: true,
            issues: [],
          },
          "models.authInspectApiKey": {
            provider: "beta",
            agentId: "main",
            baseHash: "key-scope",
            configured: true,
            source: "profile",
            key: "synthetic-beta-credential",
          },
          "models.list": { models: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      expect((await gateway.waitForRequest("models.authInspectApiKey")).params).toEqual(
        expect.objectContaining({ provider: "alpha" }),
      );
      await page.locator('[data-provider-select="beta"]').click();
      const key = page.locator('.provider-manager--inline [name="apiKey"]');
      await expect.poll(() => key.inputValue()).toBe("synthetic-beta-credential");
      await key.fill("synthetic-beta-edited");
      await gateway.resolveDeferred("models.authInspectApiKey", {
        provider: "alpha",
        agentId: "main",
        baseHash: "key-scope",
        configured: true,
        source: "profile",
        key: "synthetic-alpha-credential",
      });
      // The next render must keep the selected provider's local edit.
      await page.getByRole("button", { name: "Show API key", exact: true }).click();
      expect(await key.inputValue()).toBe("synthetic-beta-edited");
      expect(await key.getAttribute("type")).toBe("text");
      expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(0);
    });
  });

  it("edits a masked saved key and tests each exact model independently", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1100 } },
      async ({ page }) => {
        const savedKey = ["synthetic", "saved", "credential"].join("-");
        const replacement = ["synthetic", "replacement", "credential"].join("-");
        const models = ["vendor/one", "vendor/two"].map((id) => ({
          id,
          name: id,
          provider: "studio",
          available: true,
        }));
        const connection = {
          baseUrl: "https://studio.example.test/v1",
          api: "openai-completions",
          models,
        };
        const config = { models: { providers: { studio: connection } } };
        const inspection = (key: string, baseHash: string) => ({
          provider: "studio",
          agentId: "main",
          baseHash,
          configured: true,
          source: "profile",
          key,
        });
        const gateway = await installMockGateway(page, {
          models,
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              raw: JSON.stringify(config),
              hash: "saved-key",
              valid: true,
              issues: [],
            },
            "models.authInspectApiKey": inspection(savedKey, "saved-key"),
            "models.authStatus": {
              ts: 1,
              providers: [{ provider: "studio", status: "static", profiles: [] }],
              providerCapabilities: [],
            },
            "models.list": { models },
            "models.probe": { provider: "studio", status: "ok", latencyMs: 12, results: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator('[data-provider-select="studio"]').click();
        const editor = page.locator(".provider-manager--inline");
        const input = editor.locator('[name="apiKey"]');
        const footerStatus = editor.locator(".provider-manager__footer [role='status']");
        await expect.poll(() => input.inputValue()).toBe(savedKey);
        expect(await input.getAttribute("type")).toBe("password");
        await expect.poll(() => footerStatus.textContent()).toBe("");
        await editor.getByRole("button", { name: "Show API key", exact: true }).click();
        expect(await input.getAttribute("type")).toBe("text");
        await editor.getByRole("button", { name: "Hide API key", exact: true }).click();
        expect(await input.getAttribute("type")).toBe("password");
        expect((await footerStatus.textContent()) ?? "").toBe("");
        expect(await page.getByText("Accounts & usage", { exact: true }).count()).toBe(0);
        const one = editor.locator('[data-model-id="vendor/one"]');
        const two = editor.locator('[data-model-id="vendor/two"]');
        const testOne = one.getByRole("button", { name: "Test model vendor/one", exact: true });
        const testTwo = two.getByRole("button", { name: "Test model vendor/two", exact: true });
        await gateway.deferNext("models.probe");
        await testOne.click();
        expect((await gateway.waitForRequest("models.probe")).params).toEqual({
          provider: "studio",
          agentId: "main",
          modelId: "vendor/one",
        });
        await expect.poll(() => testOne.isDisabled()).toBe(true);
        expect(await testTwo.isEnabled()).toBe(true);
        await testTwo.click();
        expect((await gateway.waitForRequest("models.probe", { after: 1 })).params).toEqual({
          provider: "studio",
          agentId: "main",
          modelId: "vendor/two",
        });
        await expect.poll(() => two.locator('[role="status"]').textContent()).toContain("12 ms");
        await gateway.resolveDeferred("models.probe", {
          provider: "studio",
          status: "auth",
          error: "Model access denied",
          results: [],
        });
        await expect
          .poll(() => one.locator('[role="alert"]').textContent())
          .toContain("Model access denied");
        expect(await two.locator('[role="status"]').textContent()).toContain("Connected");
        await gateway.deferNext("models.authSetApiKey");
        await input.fill(replacement);
        await expect.poll(() => testOne.isDisabled()).toBe(true);
        const write = await gateway.waitForRequest("models.authSetApiKey");
        expect(write.params).toEqual(
          expect.objectContaining({ provider: "studio", apiKey: replacement }),
        );
        await gateway.setMethodResponse(
          "models.authInspectApiKey",
          inspection(replacement, "key-replaced"),
        );
        await resolveConfigMutation(gateway, config, "key-replaced", "studio");
        await expect.poll(() => footerStatus.textContent()).toBe("");
        expect(await input.inputValue()).toBe(replacement);
        expect(await input.getAttribute("type")).toBe("password");
        await expect.poll(() => one.locator('[role="alert"]').count()).toBe(0);
        await gateway.deferNext("config.patch");
        await editor.locator('[name="baseUrl"]').fill("https://changed.example.test/v1");
        await gateway.waitForRequest("config.patch");
        await gateway.setMethodResponse(
          "models.authInspectApiKey",
          inspection(replacement, "endpoint-changed"),
        );
        await resolveConfigMutation(
          gateway,
          {
            models: {
              providers: { studio: { ...connection, baseUrl: "https://changed.example.test/v1" } },
            },
          },
          "endpoint-changed",
        );
        await expect.poll(() => footerStatus.textContent()).toBe("");
        expect(await gateway.getRequests("models.authSetApiKey")).toHaveLength(1);
        for (const method of ["usage.status", "sessions.usage", "codex.accountUsage"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });

  it("reloads saved keys after auth-only changes and retries failed inspections", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const config = {
        models: {
          providers: {
            studio: {
              baseUrl: "https://studio.example.test/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      };
      const inspection = (key: string) => ({
        provider: "studio",
        agentId: "main",
        baseHash: "saved-key",
        configured: true,
        source: "profile",
        key,
      });
      const authStatus = (ts: number) => ({
        ts,
        providers: [{ provider: "studio", status: "static", profiles: [] }],
        providerCapabilities: [],
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash: "saved-key",
            valid: true,
            issues: [],
          },
          "models.authInspectApiKey": inspection("synthetic-key-one"),
          "models.authStatus": authStatus(1),
          "models.list": { models: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await page.locator('[data-provider-select="studio"]').click();
      const editor = page.locator(".provider-manager--inline");
      const input = editor.locator('[name="apiKey"]');
      await expect.poll(() => input.inputValue()).toBe("synthetic-key-one");

      await gateway.setMethodResponse("models.authInspectApiKey", inspection("synthetic-key-two"));
      await gateway.setMethodResponse("models.authStatus", authStatus(2));
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => input.inputValue()).toBe("synthetic-key-two");

      await gateway.setMethodResponse("models.authInspectApiKey", {
        __mockError: { code: "UNAVAILABLE", message: "Inspection unavailable" },
      });
      await gateway.setMethodResponse("models.authStatus", authStatus(3));
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect
        .poll(() => editor.locator('[role="alert"]').textContent())
        .toContain("Inspection unavailable");

      await gateway.setMethodResponse(
        "models.authInspectApiKey",
        inspection("synthetic-key-three"),
      );
      await gateway.setMethodResponse("models.authStatus", authStatus(4));
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => input.inputValue()).toBe("synthetic-key-three");
      await expect.poll(() => editor.locator('[role="alert"]').count()).toBe(0);
    });
  });

  it("keeps API-key inspection and edits unavailable in explicit OAuth mode", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const config = {
        models: {
          providers: {
            studio: {
              baseUrl: "https://studio.example.test/v1",
              api: "openai-completions",
              auth: "oauth",
              apiKey: "synthetic-configured-key",
              models: [],
            },
          },
        },
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
            hash: "oauth-mode",
            valid: true,
            issues: [],
          },
          "models.authStatus": {
            ts: 1,
            providers: [{ provider: "studio", status: "ok", profiles: [] }],
            providerCapabilities: [],
          },
          "models.list": { models: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await page.locator('[data-provider-select="studio"]').click();
      const editor = page.locator(".provider-manager--inline");
      await expect
        .poll(() => editor.textContent())
        .toContain('API key changes are unavailable while auth mode is "oauth".');
      expect(await editor.locator('[name="apiKey"]').count()).toBe(0);
      expect(await editor.getByRole("button", { name: "Remove key", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("models.authInspectApiKey")).toHaveLength(0);
    });
  });

  it("auto-saves connection edits and switches providers without pending changes", async () => {
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
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
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
        // Connection edits save themselves once typing settles.
        await gateway.deferNext("config.patch");
        await baseUrl.fill("https://draft.example/v1");
        expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
          models: { providers: { alpha: { baseUrl: "https://draft.example/v1" } } },
        });
        await resolveConfigMutation(
          gateway,
          {
            models: {
              providers: {
                alpha: { ...config.models.providers.alpha, baseUrl: "https://draft.example/v1" },
                beta: config.models.providers.beta,
              },
            },
          },
          "workspace-drafts-saved",
        );
        const search = page.getByRole("searchbox", { name: "Search providers…" });
        await search.fill("beta");
        expect(await alpha.count()).toBe(0);
        expect(await baseUrl.inputValue()).toBe("https://draft.example/v1");
        // Nothing is pending after the auto-save, so switching needs no decision.
        await beta.click();
        expect(
          await page.locator('openclaw-modal-dialog[label="Discard unsaved changes?"]').count(),
        ).toBe(0);
        await expect.poll(() => beta.getAttribute("aria-pressed")).toBe("true");
        await expect.poll(() => baseUrl.inputValue()).toBe("https://beta.example/v1");
        await search.fill("");
        await alpha.click();
        await expect.poll(() => baseUrl.inputValue()).toBe("https://draft.example/v1");
        expect(await gateway.getRequests("config.patch")).toHaveLength(1);
      },
    );
  });

  it("creates a custom provider through auto-save and persists model dialog edits", async () => {
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
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await page.locator(".model-providers__navigation [data-custom-provider]").click();
        const editor = page.locator(".provider-manager--inline");
        // The create form asks for a readable name only; the config key is generated.
        await expect.poll(() => editor.locator('[name="providerId"]').count()).toBe(0);
        // The create form auto-saves once its required fields are filled.
        await gateway.deferNext("config.patch");
        await editor.locator('[name="displayName"]').fill("Workspace Custom");
        await editor.locator('[name="baseUrl"]').fill("https://custom.example/v1");
        await editor.locator('[name="api"]').selectOption("anthropic-messages");
        const connection = {
          baseUrl: "https://custom.example/v1",
          api: "anthropic-messages",
          displayName: "Workspace Custom",
          models: [],
        };
        expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
          models: { providers: { "custom-custom-example": connection } },
        });
        await resolveConfigMutation(
          gateway,
          { models: { providers: { "custom-custom-example": connection } } },
          "workspace-created",
        );
        const selected = page.locator('[data-provider-select="custom-custom-example"]');
        await selected.waitFor();
        expect(
          await page.locator(".model-providers__navigation [data-custom-provider]").count(),
        ).toBe(0);
        await expect.poll(() => selected.getAttribute("aria-pressed")).toBe("true");
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
          models: { providers: { "custom-custom-example": { models: [model] } } },
        });
        const saved = {
          models: { providers: { "custom-custom-example": { ...connection, models: [model] } } },
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
          models: { providers: { "custom-custom-example": { models: [edited] } } },
        });
        await resolveConfigMutation(
          gateway,
          {
            models: {
              providers: { "custom-custom-example": { ...connection, models: [edited] } },
            },
          },
          "workspace-model-edited",
        );
        await dialog.locator("form").waitFor({ state: "hidden" });
        await expect.poll(() => row.textContent()).toContain("Renamed model");
        expect(await gateway.getRequests("config.patch")).toHaveLength(3);
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
  it("holds provider creation until the plugin reservation list loads", async () => {
    const relayUrl = "https://relay.example.test/v1";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config: { models: { providers: {} } },
              sourceConfig: { models: { providers: {} } },
              hash: "reservations-initial",
              raw: '{"models":{"providers":{}}}',
              valid: true,
              issues: [],
            },
            "models.list": { models: [] },
            "models.authStatus": {
              __mockError: { code: "UNAVAILABLE", message: "Provider list unavailable." },
            },
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const headerAdd = page.locator(".settings-section__actions [data-custom-provider]");
        const emptyAdd = page.locator(".model-providers__navigation [data-custom-provider]");
        await expect.poll(() => headerAdd.isDisabled()).toBe(true);
        await expect.poll(() => emptyAdd.isDisabled()).toBe(true);
        await expect
          .poll(() => page.locator("[data-provider-creation-blocked]").textContent())
          .toContain("Refresh and try again");
        // The guarded intent cannot open the create editor from either entry point.
        await headerAdd.dispatchEvent("click");
        await emptyAdd.dispatchEvent("click");
        expect(await page.locator(".provider-manager--inline").count()).toBe(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-creation-waiting-for-list.png"),
          });
        }

        // With the reservation list restored, creation reserves the plugin id.
        await gateway.setMethodResponse("models.authStatus", {
          ts: 1,
          providers: [],
          providerCapabilities: [
            {
              provider: "custom-relay-example-test",
              apiKeySupported: true,
              quickApiKeySetup: true,
            },
          ],
        });
        await page.locator(".model-providers__refresh-button").click();
        await expect.poll(() => headerAdd.isEnabled()).toBe(true);
        await expect.poll(() => page.locator("[data-provider-creation-blocked]").count()).toBe(0);
        // A fresh load of the restored list also starts clean (no stale refusal copy).
        await page.reload();
        await expect.poll(() => headerAdd.isEnabled()).toBe(true);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-creation-restored.png"),
          });
        }
        await headerAdd.click();
        const editor = page.locator(".provider-manager--inline");
        await editor.locator('[name="displayName"]').waitFor();
        await gateway.deferNext("config.patch");
        await editor.locator('[name="displayName"]').fill("Relay Example");
        await editor.locator('[name="baseUrl"]').fill(relayUrl);
        // The plugin-declared id stays reserved; the new provider claims the next key.
        const connection = {
          baseUrl: relayUrl,
          api: "openai-completions",
          displayName: "Relay Example",
          models: [],
        };
        expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
          models: { providers: { "custom-relay-example-test-2": connection } },
        });
        await resolveConfigMutation(
          gateway,
          { models: { providers: { "custom-relay-example-test-2": connection } } },
          "reservations-created",
        );
        await expect
          .poll(() => page.locator('[data-provider-select="custom-relay-example-test-2"]').count())
          .toBe(1);
        expect(
          await page.locator('[data-provider-select="custom-relay-example-test"]').count(),
        ).toBe(0);
      },
    );
  });

  it("generates keys for name-only creation and renames without moving the key", async () => {
    const relayUrl = "https://relay.example.test/v1";
    const firstKey = "custom-relay-example-test";
    const chineseName = "我的中转站";
    const renamed = "公司内部模型";
    const named = (displayName: string) => ({
      baseUrl: relayUrl,
      api: "openai-completions",
      displayName,
      models: [],
    });
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              config: {},
              sourceConfig: {},
              hash: "names-initial",
              raw: "{}",
              valid: true,
              issues: [],
            },
            "models.list": { models: [] },
            "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
            "usage.status": { updatedAt: 1, providers: [] },
            "sessions.usage": { aggregates: { byProvider: [] } },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const editor = page.locator(".provider-manager--inline");
        await page.locator(".model-providers__navigation [data-custom-provider]").click();
        await gateway.deferNext("config.patch");
        await editor.locator('[name="displayName"]').fill(chineseName);
        await editor.locator('[name="baseUrl"]').fill(relayUrl);
        // The persisted snapshot carries the exact CJK name under an endpoint-derived key.
        expect(requestRaw(await gateway.waitForRequest("config.patch"))).toEqual({
          models: { providers: { [firstKey]: named(chineseName) } },
        });
        await resolveConfigMutation(
          gateway,
          { models: { providers: { [firstKey]: named(chineseName) } } },
          "names-first-created",
        );
        await expect
          .poll(() => page.locator(`[data-provider-select="${firstKey}"]`).textContent())
          .toContain(chineseName);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-created-with-chinese-name.png"),
          });
        }

        // A second provider with the same readable name and endpoint claims its own key.
        await page.locator(".settings-section__actions [data-custom-provider]").click();
        await gateway.deferNext("config.patch");
        await editor.locator('[name="displayName"]').fill(chineseName);
        await editor.locator('[name="baseUrl"]').fill(relayUrl);
        expect(requestRaw(await gateway.waitForRequest("config.patch", { after: 1 }))).toEqual({
          models: { providers: { [`${firstKey}-2`]: named(chineseName) } },
        });
        await resolveConfigMutation(
          gateway,
          {
            models: {
              providers: {
                [firstKey]: named(chineseName),
                [`${firstKey}-2`]: named(chineseName),
              },
            },
          },
          "names-duplicate-created",
        );
        await expect.poll(() => page.locator("[data-provider-select]").count()).toBe(2);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-duplicate-names.png"),
          });
        }

        // Renaming writes only the display leaf: the config key, its nav identity,
        // and its models stay put.
        await page.locator(`[data-provider-select="${firstKey}"]`).click();
        await gateway.deferNext("config.patch");
        // A real browser confirms the field on blur; the name commits there, not per keystroke.
        await editor.locator('[name="displayName"]').fill(renamed);
        await editor.locator('[name="displayName"]').blur();
        expect(requestRaw(await gateway.waitForRequest("config.patch", { after: 2 }))).toEqual({
          models: { providers: { [firstKey]: { displayName: renamed } } },
        });
        await resolveConfigMutation(
          gateway,
          {
            models: {
              providers: {
                [firstKey]: named(renamed),
                [`${firstKey}-2`]: named(chineseName),
              },
            },
          },
          "names-renamed",
        );
        await expect
          .poll(() => page.locator(`[data-provider-select="${firstKey}"]`).textContent())
          .toContain(renamed);
        // The visible label changed; the navigation identity did not.
        await expect
          .poll(() => page.locator(`[data-provider-select="${renamed}"]`).count())
          .toBe(0);
        await expect
          .poll(() => page.locator(`[data-provider-select="${firstKey}"]`).count())
          .toBe(1);
        if (recordVisuals) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-renamed-keeps-key.png"),
          });
        }
      },
    );
  });

  it.each([1440, 390])(
    "captures the name-only create form and renamed card label at %ipx",
    async (width) => {
      const relayUrl = "https://relay.example.test/v1";
      const firstKey = "custom-relay-example-test";
      const chineseName = "我的中转站";
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 1000 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "config.get": {
                config: {},
                sourceConfig: {},
                hash: `viewport-${width}-initial`,
                raw: "{}",
                valid: true,
                issues: [],
              },
              "models.list": { models: [] },
              "models.authStatus": { ts: 1, providers: [], providerCapabilities: [] },
              "usage.status": { updatedAt: 1, providers: [] },
              "sessions.usage": { aggregates: { byProvider: [] } },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          const editor = page.locator(".provider-manager--inline");
          await page.locator(".model-providers__navigation [data-custom-provider]").click();
          await editor.locator('[name="displayName"]').waitFor();
          if (recordVisuals) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `create-form-name-only-${width}.png`),
            });
          }
          await gateway.deferNext("config.patch");
          await editor.locator('[name="displayName"]').fill(chineseName);
          await editor.locator('[name="baseUrl"]').fill(relayUrl);
          await gateway.waitForRequest("config.patch");
          await resolveConfigMutation(
            gateway,
            {
              models: {
                providers: {
                  [firstKey]: {
                    baseUrl: relayUrl,
                    api: "openai-completions",
                    displayName: chineseName,
                    models: [],
                  },
                },
              },
            },
            `viewport-${width}-created`,
          );
          await expect
            .poll(() => page.locator(`[data-provider-select="${firstKey}"]`).textContent())
            .toContain(chineseName);
          if (recordVisuals) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `created-chinese-name-${width}.png`),
            });
          }
        },
      );
    },
  );

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
                providerCapabilities: [
                  { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
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
            .locator(
              ".settings-section__actions [data-custom-provider], .model-providers__refresh-button",
            )
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
