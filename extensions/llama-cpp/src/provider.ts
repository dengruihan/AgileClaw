import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { LLAMA_CPP_PROVIDER_ID, LLAMA_CPP_PROVIDER_LABEL } from "./defaults.js";
import { shouldUseLlamaServerSyntheticAuth } from "./external-server/auth.js";
import {
  LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  LLAMA_SERVER_DEFAULT_ORIGIN,
} from "./external-server/defaults.js";
import { normalizeLlamaServerProviderConfig } from "./external-server/endpoint.js";
import {
  discoverLlamaServerProvider,
  prepareLlamaServerDynamicModel,
} from "./external-server/provider.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./external-server/setup.js";
import { wrapLlamaServerStream } from "./external-server/stream.js";

/** Connects to an already-running llama-server over its HTTP API. */
export function registerLlamaCppProvider(api: OpenClawPluginApi): void {
  api.registerProvider({
    id: LLAMA_CPP_PROVIDER_ID,
    label: LLAMA_CPP_PROVIDER_LABEL,
    docsPath: "/plugins/llama-cpp",
    envVars: [LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR],
    auth: [
      {
        id: "existing-server",
        label: "Existing llama-server",
        hint: "Connect to an existing local, private, or remote llama.cpp server",
        kind: "custom",
        wizard: {
          choiceId: "llama-cpp-existing-server",
          choiceLabel: "Existing llama-server",
          choiceHint: "Connect to a llama.cpp server managed outside OpenClaw",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "llama.cpp server",
          groupHint: "Connect to an already-running llama-server HTTP API",
          methodId: "existing-server",
        },
        appGuidedSetup: {
          detect: detectLlamaServerSetup,
          prepare: prepareLlamaServerSetup,
        },
        run: runLlamaServerSetup,
        validateNonInteractive: validateLlamaServerNonInteractive,
        runNonInteractive: configureLlamaServerNonInteractive,
      },
    ],
    catalog: {
      order: "late",
      run: discoverLlamaServerProvider,
    },
    resolveSyntheticAuth: ({ providerConfig }) =>
      shouldUseLlamaServerSyntheticAuth(providerConfig)
        ? {
            apiKey: "llama-cpp-local",
            source: "llama-server HTTP endpoint",
            mode: "api-key" as const,
          }
        : undefined,
    shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
      resolvedApiKey?.trim() === "llama-cpp-local",
    normalizeConfig: ({ providerConfig }) => normalizeLlamaServerProviderConfig(providerConfig),
    prepareDynamicModel: prepareLlamaServerDynamicModel,
    wrapSimpleCompletionStreamFn: wrapLlamaServerStream,
    wrapStreamFn: wrapLlamaServerStream,
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    wizard: {
      modelPicker: {
        label: "llama.cpp",
        hint: `Connect to an already-running server at ${LLAMA_SERVER_DEFAULT_ORIGIN}`,
        methodId: "existing-server",
      },
    },
  });
}
