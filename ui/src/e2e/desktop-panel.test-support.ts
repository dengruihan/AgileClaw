import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";

export function sessionsList(placement: "local" | "active") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        label: "Main",
        placement: {
          state: placement,
          ...(placement === "active" ? { environmentId: "worker-desktop-1" } : {}),
        },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

export async function openDesktopPanelInPlace(page: import("playwright").Page) {
  await waitForControlUiGatewayReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("openclaw:desktop-toggle", { detail: { open: true } }));
  });
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator("section[aria-label='Desktop']").waitFor();
  return panel;
}

export async function openDesktopPanel(page: import("playwright").Page, baseUrl: string) {
  await page.goto(`${baseUrl}activity`);
  return openDesktopPanelInPlace(page);
}
