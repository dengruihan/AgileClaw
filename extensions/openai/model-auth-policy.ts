import type {
  ProviderModelAuthPolicyContext,
  ProviderModelAuthPolicy,
} from "openclaw/plugin-sdk/provider-model-types";
import { classifyOpenAIBaseUrl } from "./base-url.js";

/** Credential storage mode and the endpoint it authorizes are independent. */
export function resolveModelAuthPolicy(
  ctx: ProviderModelAuthPolicyContext,
): ProviderModelAuthPolicy | undefined {
  if (ctx.provider.trim().toLowerCase() !== "openai") {
    return undefined;
  }
  const api = ctx.api?.trim().toLowerCase();
  if (ctx.mode !== undefined && ctx.mode !== "api-key" && ctx.mode !== "api_key") {
    return {
      authRequirement: null,
      compatible: false,
      incompatibilityReason: "model inference only accepts API-key credentials",
    };
  }
  const apiKey = ctx.mode === "api-key" || ctx.mode === "api_key";
  const codex = api === "openai-chatgpt-responses";
  const requiresApiKey =
    (ctx.capability === "embedding" || codex) && classifyOpenAIBaseUrl(ctx.baseUrl) !== "custom";
  return {
    authRequirement: apiKey ? "api-key" : null,
    compatible: (!requiresApiKey || apiKey) && (api === undefined || (!codex && apiKey)),
    incompatibilityReason: "requires an OpenAI API key profile",
  };
}
