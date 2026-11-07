import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export function styleConfigResponse(mode: "dark" | "light") {
  const config = { ui: { prefs: { themeMode: mode } } };
  const hash = `style-typography-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

export function createStyledChatOpener(suite: ReturnType<typeof createControlUiE2eSuite>) {
  async function openStyledChat(
    mode: "dark" | "light",
    scenario: Pick<
      ControlUiMockGatewayScenario,
      "awaitInitialRoster" | "basePath" | "featureMethods" | "historyMessages" | "methodResponses"
    > = {},
  ) {
    const context = await suite.newBrowserContext({
      colorScheme: mode,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript(
      ({ gatewayUrl, initialMode }) => {
        if (sessionStorage.getItem("typography-seeded")) {
          return;
        }
        sessionStorage.setItem("typography-seeded", "1");
        localStorage.setItem(
          `openclaw.control.settings.v1:${gatewayUrl}`,
          JSON.stringify({ gatewayUrl, themeMode: initialMode }),
        );
      },
      {
        gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
        initialMode: mode,
      },
    );
    const page = await context.newPage();
    const fontRequests: string[] = [];
    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      if (pathname.endsWith(".css") && pathname.includes("/fonts/")) {
        fontRequests.push(`${pathname.split("/").pop()} ${response.status()}`);
      }
    });
    const gateway = await installMockGateway(page, {
      ...scenario,
      methodResponses: {
        ...scenario.methodResponses,
        "config.get": styleConfigResponse(mode),
      },
    });
    return { fontRequests, gateway, page };
  }

  return openStyledChat;
}
