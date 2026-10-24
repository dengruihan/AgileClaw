import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { MockGatewayControls, MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

export function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.patch params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

export async function resolveConfigMutation(
  gateway: MockGatewayControls,
  config: Record<string, unknown>,
  hash: string,
  apiKeyProvider?: string,
) {
  await gateway.setMethodResponse("config.get", {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  });
  await gateway.resolveDeferred(
    apiKeyProvider ? "models.authSetApiKey" : "config.patch",
    apiKeyProvider
      ? { provider: apiKeyProvider, profileId: `${apiKeyProvider}:manual-api-key` }
      : { ok: true, config, hash },
  );
}

export function providerConfig(value: string): { apiKey: string } {
  return Object.fromEntries([["apiKey", value]]) as { apiKey: string };
}

export async function selectProviderAccounts(page: Page, id: string): Promise<Locator> {
  await page.locator(`[data-provider-select="${id}"]`).click();
  const details = page.locator(`[data-provider-details="${id}"]`);
  await details.waitFor();
  const disclosure = details.locator(".model-providers__card-details");
  if ((await disclosure.getAttribute("open")) === null) {
    await disclosure.locator(":scope > summary").click();
  }
  return details;
}

export async function expectPassiveProviderReads(gateway: MockGatewayControls): Promise<void> {
  for (const request of await gateway.getRequests("models.list")) {
    const params = request.params as { view?: string; preparedOnly?: boolean } | undefined;
    if (params?.view === "all") {
      expect(params).toEqual(expect.objectContaining({ preparedOnly: true }));
    }
  }
}

export function createProviderProofCapture(getArtifactDir: () => string) {
  return async (fileName: string, content: Locator): Promise<void> => {
    const page = content.page();
    await writeFile(
      path.join(getArtifactDir(), fileName),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
    );
  };
}

export async function providerHeaderMetrics(providerSection: Locator) {
  return providerSection.evaluate((section) => {
    const heading = section.querySelector<HTMLElement>(".settings-section__heading");
    const actions = section.querySelector<HTMLElement>(".settings-section__actions");
    const updated = section.querySelector<HTMLElement>(".model-providers__updated");
    const refresh = section.querySelector<HTMLButtonElement>(".model-providers__refresh-button");
    const icon = refresh?.querySelector<SVGElement>("svg");
    if (!heading || !actions || !updated || !refresh || !icon) {
      throw new Error("expected configured-provider header controls");
    }
    const updatedBounds = updated.getBoundingClientRect();
    const refreshBounds = refresh.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return {
      centerOffset: Math.abs(
        updatedBounds.top +
          updatedBounds.height / 2 -
          (refreshBounds.top + refreshBounds.height / 2),
      ),
      iconWidth: iconBounds.width,
      textSize: Number.parseFloat(getComputedStyle(updated).fontSize),
      refreshHeight: refresh.getBoundingClientRect().height,
    };
  });
}
