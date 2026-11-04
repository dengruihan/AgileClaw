// Real Control UI rendering and routing; provider/Gateway replies are controlled fixtures.
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSetupGateway, openModelSetup } from "./model-setup.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Explicit AI onboarding",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const detection = {
  candidates: [
    {
      kind: "codex-cli",
      label: "Codex",
      detail: "Available credentials",
      modelRef: "openai/gpt-5",
      credentials: true,
      recommended: true,
    },
    {
      kind: "anthropic-api-key",
      label: "Anthropic",
      detail: "Available credentials",
      modelRef: "anthropic/claude-sonnet-4-6",
      credentials: true,
      recommended: false,
    },
  ],
  manualProviders: [{ id: "openai", label: "OpenAI" }],
  authOptions: [
    { id: "meta-api-key", label: "Meta", kind: "install", featured: false },
    { id: "custom-api-key", label: "Custom compatible endpoint", kind: "custom", featured: false },
  ],
  nativeSessionCatalogs: [
    { pluginId: "anthropic", label: "Claude" },
    { pluginId: "codex", label: "Codex" },
  ],
  nativeSessionCatalogPreferenceRequired: true,
  setupComplete: false,
  workspace: "/tmp/onboarding-fixture",
};

suite.define(() => {
  it("waits for an explicit choice and preserves provider failure details", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1080, height: 850 },
        recordVideo: captureUiProof
          ? { dir: suite.artifactDir, size: { width: 1080, height: 850 } }
          : undefined,
      },
      async ({ page }) => {
        const gateway = await installSetupGateway(page, {
          featureMethods: [
            "openclaw.setup.detect",
            "openclaw.setup.activate.start",
            "openclaw.setup.auth.start",
            "wizard.next",
          ],
          methodResponses: {
            "openclaw.setup.detect": detection,
            "openclaw.setup.activate.start": {
              done: true,
              status: "error",
              error: "HTTP 401: review this provider credential and try again.",
              activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
            },
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
        const choices = page.locator("[data-candidate-kind]");
        expect(await choices.first().textContent()).toContain("Anthropic");
        expect(await page.getByLabel("Show existing native conversations").isChecked()).toBe(false);
        expect(await page.locator("openclaw-model-setup-page [data-selected]").count()).toBe(0);
        await page.getByRole("button", { name: "Check again", exact: true }).click();
        await gateway.waitForRequest("openclaw.setup.detect", { after: 1 });
        await page.getByRole("heading", { name: "Found on this Gateway" }).waitFor();
        for (const method of [
          "openclaw.setup.activate.start",
          "openclaw.setup.auth.start",
          "plugins.install",
          "openclaw.setup.verify",
          "config.set",
          "config.patch",
          "config.apply",
        ]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
        if (captureUiProof) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "settings-choices.png"),
          });
        }
        await page.locator('[data-candidate-kind="anthropic-api-key"] button').click();
        const activated = await gateway.waitForRequest("openclaw.setup.activate.start");
        expect(activated.params).toMatchObject({
          kind: "anthropic-api-key",
          nativeSessionCatalogsEnabled: false,
        });
        await page
          .getByText("HTTP 401: review this provider credential and try again.", { exact: false })
          .waitFor();
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(1);
        if (captureUiProof) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "settings-error.png"),
          });
        }
      },
    );
  });

  it("starts managed provider installation only after a click and waits at capability consent", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1080, height: 850 },
        recordVideo: captureUiProof
          ? { dir: suite.artifactDir, size: { width: 1080, height: 850 } }
          : undefined,
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "openclaw.setup.detect",
            "openclaw.setup.auth.start",
            "wizard.next",
            "wizard.cancel",
          ],
          methodResponses: {
            "openclaw.setup.detect": detection,
            "openclaw.setup.auth.start": { done: false, status: "running" },
            "wizard.next": {
              done: false,
              status: "running",
              step: {
                id: "capabilities",
                type: "confirm",
                message: "Allow this provider plugin to call its inference endpoint?",
                initialValue: false,
              },
            },
            "wizard.cancel": { status: "cancelled" },
          },
        });
        await openModelSetup(page, suite.server.baseUrl);
        const install = page
          .locator('[data-auth-choice="meta-api-key"]')
          .getByRole("button", { name: "Review & install" });
        await install.waitFor();
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        expect(
          await page
            .locator('[data-auth-choice="custom-api-key"]')
            .getByRole("button", { name: "Set up endpoint" })
            .isVisible(),
        ).toBe(true);
        await page.getByLabel("Show existing native conversations").check();
        await install.click();
        expect((await gateway.waitForRequest("openclaw.setup.auth.start")).params).toMatchObject({
          authChoice: "meta-api-key",
          nativeSessionCatalogsEnabled: true,
        });
        const dialog = page
          .locator("openclaw-modal-dialog")
          .filter({ hasText: "Allow this provider plugin to call its inference endpoint?" });
        await dialog.waitFor();
        const next = await gateway.getRequests("wizard.next");
        expect(next).toHaveLength(1);
        expect(next[0]!.params).not.toHaveProperty("answer");
        if (captureUiProof) {
          await page.screenshot({
            path: path.join(suite.artifactDir, "provider-capability-consent.png"),
          });
        }
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await gateway.waitForRequest("wizard.cancel");
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
      },
    );
  });

  it.each(["success", "failure", "cancel", "remote"] as const)(
    "keeps custom endpoint %s on the selected provider",
    async (outcome) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1080, height: 850 },
          recordVideo: captureUiProof
            ? { dir: suite.artifactDir, size: { width: 1080, height: 850 } }
            : undefined,
        },
        async ({ page }) => {
          const gateway = await installSetupGateway(page, {
            featureMethods: [
              "openclaw.setup.detect",
              "openclaw.setup.auth.start",
              "wizard.next",
              "wizard.cancel",
            ],
            methodResponses: {
              "openclaw.setup.detect": detection,
              "openclaw.setup.auth.start":
                outcome === "remote"
                  ? {
                      done: true,
                      status: "error",
                      error:
                        "Run openclaw onboard on the Gateway host to configure this custom endpoint.",
                      activationRejection: {
                        disposition: "rejected-before-promotion",
                        status: "unavailable",
                      },
                    }
                  : { done: false, status: "running" },
              "wizard.cancel": { status: "cancelled" },
              "wizard.next": {
                done: false,
                status: "running",
                step: {
                  id: "endpoint",
                  type: "text",
                  message: "API base URL",
                },
              },
            },
          });
          await openModelSetup(page, suite.server.baseUrl);
          await page.locator('[data-auth-choice="custom-api-key"] button').click();
          expect((await gateway.waitForRequest("openclaw.setup.auth.start")).params).toMatchObject({
            authChoice: "custom-api-key",
            agentId: "main",
          });
          const dialog = page.locator("openclaw-modal-dialog");
          if (outcome === "remote") {
            const alert = dialog.getByRole("alert");
            await alert.waitFor();
            expect((await alert.textContent())?.trim()).toBe(
              "Could not finish. Open Details to see what to do next.",
            );
            const details = dialog.locator("details");
            expect(await details.getAttribute("open")).toBeNull();
            const diagnostic = details.getByText(
              "Run openclaw onboard on the Gateway host to configure this custom endpoint.",
              { exact: true },
            );
            expect(await diagnostic.isVisible()).toBe(false);
            await details.getByText("Details", { exact: true }).click();
            await diagnostic.waitFor();
            expect(await gateway.getRequests("wizard.next")).toHaveLength(0);
            expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
            if (captureUiProof) {
              await page.screenshot({
                path: path.join(suite.artifactDir, "custom-remote-handoff.png"),
              });
            }
            return;
          }
          await dialog.getByLabel("API base URL", { exact: true }).fill("http://127.0.0.1:9876/v1");
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "custom-endpoint-input.png"),
            });
          }
          if (outcome === "cancel") {
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await gateway.waitForRequest("wizard.cancel");
            expect(await gateway.getRequests("wizard.next")).toHaveLength(1);
          } else {
            await gateway.setMethodResponse(
              "wizard.next",
              outcome === "success"
                ? {
                    done: true,
                    status: "done",
                    modelActivation: { modelRef: "custom/fixture-model" },
                  }
                : {
                    done: true,
                    status: "error",
                    error: "The selected endpoint could not be reached. Check its address.",
                    activationRejection: {
                      disposition: "rejected-before-promotion",
                      status: "unavailable",
                    },
                  },
            );
            await dialog.getByRole("button", { name: "Submit", exact: true }).click();
            if (outcome === "success") {
              await page.locator(".model-setup-success").waitFor();
            } else {
              const alert = dialog.getByRole("alert");
              await alert.waitFor();
              expect((await alert.textContent())?.trim()).toBe(
                "Could not finish. Open Details to see what to do next.",
              );
              const details = dialog.locator("details");
              expect(await details.getAttribute("open")).toBeNull();
              const diagnostic = details.getByText(
                "The selected endpoint could not be reached. Check its address.",
                { exact: true },
              );
              expect(await diagnostic.isVisible()).toBe(false);
              await details.getByText("Details", { exact: true }).click();
              await diagnostic.waitFor();
            }
          }
          expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(1);
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "custom-endpoint-outcome.png"),
            });
          }
        },
      );
    },
  );
});
