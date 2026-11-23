import type { Plugin } from "vite";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../../src/gateway/control-ui-contract.js";

// Mirror the Gateway's depth-insensitive asset resolution
// (src/gateway/control-ui.ts): any "/assets/" segment serves the bundled
// asset. The built index.html uses portable relative asset URLs, so a
// document reloaded on a deep link like /chat/research requests
// /chat/assets/*.js; without this contract Vite's SPA fallback answers with
// index.html and the module never executes, bricking the page.
export function controlUiE2eGatewayAssetPathPlugin(): Plugin {
  return {
    name: "control-ui-e2e-gateway-asset-paths",
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const assetsIndex = url.indexOf("/assets/");
        if (assetsIndex > 0) {
          req.url = url.slice(assetsIndex);
        }
        next();
      });
    },
  };
}

export function controlUiE2ePreviewConfigPlugin(
  bootstrapConfig: Record<string, unknown> = {
    basePath: "/",
    assistantName: "",
    assistantAvatar: "",
  },
): Plugin {
  return {
    name: "control-ui-e2e-preview-config",
    configurePreviewServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(bootstrapConfig));
      });
    },
  };
}
