import type { CodexAppServerAuthProfileLookup } from "./auth-profile.js";
import type { CodexAppServerHomeScope } from "./config-contracts.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export const CODEX_NATIVE_PERSONALITY_NONE = "none";

export function resolveCodexBindingModelProviderFallback(params: {
  provider?: string;
  currentModel: string | undefined;
  bindingModel: string | undefined;
  bindingModelProvider: string | undefined;
}): string | undefined {
  const provider = params.provider?.trim().toLowerCase();
  if (provider && provider !== "codex") {
    return undefined;
  }
  const currentModel = params.currentModel?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (
    currentModel &&
    bindingModel &&
    currentModel === bindingModel &&
    params.bindingModelProvider
  ) {
    return params.bindingModelProvider;
  }
  return hasProviderQualifiedModelRef(currentModel) ? undefined : params.bindingModelProvider;
}

export function resolveCodexAppServerThreadModelSelection(
  params: CodexAppServerAuthProfileLookup & {
    provider: string;
    homeScope?: CodexAppServerHomeScope;
    model: string;
    requestModel?: string;
    inheritBindingAuthProfile?: boolean;
    binding?: Pick<
      CodexAppServerThreadBinding,
      "threadId" | "authProfileId" | "model" | "modelProvider"
    >;
  },
): { model: string; modelProvider?: string } {
  const authProfileId =
    params.inheritBindingAuthProfile === false
      ? params.authProfileId
      : (params.authProfileId ?? params.binding?.authProfileId);
  const explicitModelProvider = resolveCodexAppServerModelProvider({
    ...params,
    authProfileId,
  });
  const bindingModelProvider = params.binding?.threadId
    ? resolveCodexBindingModelProviderFallback({
        provider: params.provider,
        currentModel: params.model,
        bindingModel: params.binding.model,
        bindingModelProvider: params.binding.modelProvider,
      })
    : undefined;
  return resolveCodexAppServerRequestModelSelection({
    ...params,
    model: params.requestModel ?? params.model,
    modelProvider: explicitModelProvider ?? bindingModelProvider,
    authProfileId,
  });
}

export function resolveCodexAppServerRequestModelSelection(
  params: CodexAppServerAuthProfileLookup & {
    model: string;
    homeScope?: CodexAppServerHomeScope;
    modelProvider?: string | null;
  },
): { model: string; modelProvider?: string } {
  const model = params.model.trim();
  const modelProvider = params.modelProvider?.trim();
  if (modelProvider) {
    return { model, modelProvider };
  }
  // Codex app-server expects provider-qualified refs as separate fields. Keep
  // explicit providers intact so provider-owned slashy model ids are not split.
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return { model };
  }
  const inferredProvider = model.slice(0, slashIndex);
  const inferredModelProvider = resolveCodexAppServerModelProvider({
    ...params,
    provider: inferredProvider,
  });
  return {
    model: model.slice(slashIndex + 1).trim(),
    ...(inferredModelProvider ? { modelProvider: inferredModelProvider } : {}),
  };
}

function hasProviderQualifiedModelRef(model: string | undefined): boolean {
  const trimmed = model?.trim();
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && slashIndex < (trimmed?.length ?? 0) - 1;
}

export function resolveCodexAppServerModelProvider(
  params: CodexAppServerAuthProfileLookup & {
    provider: string;
    homeScope?: CodexAppServerHomeScope;
  },
): string | undefined {
  const normalized = params.provider.trim();
  const normalizedLower = normalized.toLowerCase();
  if (!normalized || normalizedLower === "codex") {
    return "openai";
  }
  return normalizedLower === "openai" ? "openai" : normalized;
}
