import type { Page } from "playwright";

/** Opens the explicit conversation dock through the same owner plugin pages use. */
export async function openAssistantDock(
  page: Page,
  params: { sessionKey: string; agentId: string; label: string },
): Promise<void> {
  await page.evaluate((next) => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          assistantDock: {
            openSession: (
              params: { sessionKey: string; agentId: string; label: string },
              activation: object,
            ) => void;
          };
        };
      };
    };
    if (!app?.runtime) {
      throw new Error("Application runtime is not ready");
    }
    app.runtime.context.assistantDock.openSession(next, {});
  }, params);
}
