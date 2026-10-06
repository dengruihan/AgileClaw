import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildGoogleStaticCatalogProvider } from "./provider-catalog.js";
import { resolveGoogleVertexConfigApiKey } from "./vertex-adc-config.js";

const googleProviderDiscovery: ProviderPlugin = {
  id: "google",
  label: "Google AI Studio",
  docsPath: "/providers/models",
  auth: [],
  resolveConfigApiKey: ({ provider, env }) =>
    provider === "google-vertex" ? resolveGoogleVertexConfigApiKey(env) : undefined,
  staticCatalog: {
    order: "simple",
    run: async () => ({
      providers: {
        google: buildGoogleStaticCatalogProvider(),
      },
    }),
  },
};

export default googleProviderDiscovery;
