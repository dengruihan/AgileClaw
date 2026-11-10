// Control UI E2E tests cover the redesigned chat composer.
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectComposerSurface } from "./theme-background.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer redesign",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
suite.define(() => {
  it("does not repeat an auth failure below the composer when the run error is visible", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const message =
        "Your refresh token has already been used to generate a new access token. Please try signing in again.";
      const gateway = await installMockGateway(page, {
        inFlightRun: { runId: "auth-failed-run", text: "" },
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            available: false,
            unavailableReason: "auth-failed",
          },
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await gateway.waitForRequest("chat.startup");
      await gateway.emitGatewayEvent("chat", {
        errorDetail: {
          provider: "openai",
          failoverReason: "refresh_token_reused",
          providerRuntimeFailureKind: "auth_refresh",
          providerErrorType: "invalid_request_error",
          httpStatus: 401,
        },
        errorMessage: `⚠️ ${message}`,
        runId: "auth-failed-run",
        sessionKey: "main",
        state: "error",
      });
      await expect.poll(() => page.locator(".chat-error").textContent()).toContain(message);
      await expect.poll(() => page.locator(".agent-chat__composer-status-band").count()).toBe(0);
      const textarea = page.locator(".agent-chat__input textarea");
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      await textarea.fill("Try the message again.");
      await expect
        .poll(() => page.getByRole("button", { name: "Send message", exact: true }).isDisabled())
        .toBe(true);
      expect(await textarea.inputValue()).toBe("Try the message again.");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps the loading model picker beside the microphone", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-composer-redesign", artifactRoot)
      : undefined;
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.startup", "models.list"],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const model = composer.locator('[data-chat-model-select="true"]');
      const voice = page.getByRole("button", { name: "Start voice input" });
      await expect.poll(() => model.getAttribute("aria-busy")).toBe("true");
      await expect.poll(() => voice.isVisible()).toBe(true);
      if (artifactDir) {
        await composer.screenshot({
          animations: "disabled",
          path: `${artifactDir}/loading-model-picker-spacing.png`,
        });
      }

      const measureGap = async () => {
        const [modelBox, voiceBox] = await Promise.all([model.boundingBox(), voice.boundingBox()]);
        return modelBox && voiceBox ? voiceBox.x - (modelBox.x + modelBox.width) : null;
      };
      await expect.poll(measureGap).toBeGreaterThanOrEqual(0);
      await expect.poll(measureGap).toBeLessThanOrEqual(16);
    });
  });

  it("carves the composer surface into a recessed well on chat and new-session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      });

      const parseShadowLayers = (value: string) =>
        value.split(/, (?=color\(|rgba?\()/).map((segment) => {
          const match = segment.match(
            /^(rgba?\([^)]*\)|color\(srgb[^)]*\)) (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px(?: )?(inset)?$/,
          );
          if (!match) {
            throw new Error(`unparsed shadow layer: ${segment}`);
          }
          const numbers = match[1]!.match(/[\d.]+/g)!.map(Number);
          const scale = match[1]!.startsWith("color(srgb") ? 255 : 1;
          return {
            alpha: numbers[3] ?? 1,
            inset: match[6] === "inset",
            rgb: numbers.slice(0, 3).map((channel) => channel * scale),
            spread: Number(match[5]),
            x: Number(match[2]),
            y: Number(match[3]),
          };
        });

      for (const [route, url] of [
        ["chat", controlUiSessionUrl(suite.server.baseUrl, "agent:main:main")],
        ["new", `${suite.server.baseUrl}new`],
      ] as const) {
        await page.goto(url);
        const composer = page.locator(
          route === "chat"
            ? ".chat-footer .agent-chat__input"
            : ".new-session-page__composer .agent-chat__input",
        );
        await composer.waitFor({ state: "visible" });
        for (const theme of ["dark", "light"] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
            .toBe(theme);
          const material = await composer.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
            const style = getComputedStyle(element);
            return {
              borderColor: style.borderColor,
              borderWidth: style.borderWidth,
              boxShadow: style.boxShadow,
            };
          });
          await expectComposerSurface(composer);

          const layers = parseShadowLayers(material.boxShadow);
          expect(
            layers.every((layer) => layer.inset),
            `${route} (${theme}): every shadow layer is inset — a recess, not a raised plate`,
          ).toBe(true);
          expect(
            layers.some((layer) => layer.alpha > 0.08 && (layer.x > 0 || layer.y > 0)),
            `${route} (${theme}): the top/left wall casts shade into the well`,
          ).toBe(true);
          expect(
            layers.some((layer) => layer.alpha > 0 && (layer.x < 0 || layer.y < 0)),
            `${route} (${theme}): the bottom/right lip catches a highlight`,
          ).toBe(true);
          // The well has no outer frame; the 1px border stays for geometry only.
          expect(material.borderWidth, `${route} (${theme}): border keeps its width`).toBe("1px");
          expect(
            material.borderColor.replace(/\s/g, ""),
            `${route} (${theme}): border carries no visible frame`,
          ).toMatch(/^(?:rgba\(0,0,0,0\)|transparent)$/);
        }
      }
    });
  });
});
