import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

const noopAuth = async () => ({ profiles: [] });
type MiniMaxRegion = "cn" | "global";

export function minimaxAuthMethodMetadata(region: MiniMaxRegion): Omit<ProviderAuthMethod, "run"> {
  const isCn = region === "cn";
  const label = `MiniMax API key (${isCn ? "CN" : "Global"})`;
  const hint = isCn ? "CN endpoint - api.minimaxi.com" : "Global endpoint - api.minimax.io";
  return {
    id: isCn ? "api-cn" : "api-global",
    kind: "api_key",
    label,
    hint,
    wizard: {
      choiceId: `minimax-${isCn ? "cn" : "global"}-api`,
      choiceLabel: label,
      choiceHint: hint,
      groupId: "minimax",
      groupLabel: "MiniMax",
      groupHint: "M3 (recommended)",
    },
  };
}

function createMinimaxProviderContract(portal: boolean): ProviderPlugin {
  return {
    id: portal ? "minimax-portal" : "minimax",
    label: "MiniMax",
    hookAliases: [portal ? "minimax-portal-cn" : "minimax-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_API_KEY"],
    resolveThinkingProfile: ({ modelId }) => resolveMinimaxThinkingProfile(modelId),
    auth: portal
      ? []
      : (["global", "cn"] as const).map((region) =>
          Object.assign(minimaxAuthMethodMetadata(region), { run: noopAuth }),
        ),
  };
}

export function createMinimaxProvider(): ProviderPlugin {
  return createMinimaxProviderContract(false);
}

export function createMinimaxPortalProvider(): ProviderPlugin {
  return createMinimaxProviderContract(true);
}
