/** Synchronous auth-profile selection and native provider identity. */
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { createCodexAuthProfileSelection } from "./auth-profile-selection.js";
export { CODEX_APP_SERVER_AUTH_PROVIDER } from "./auth-profile-selection.js";

type ProviderAuthAliasConfig = Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];

export const {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore,
} = createCodexAuthProfileSelection({ ensureAuthProfileStore, resolveAuthProfileOrder });

export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

export type CodexAppServerAuthRuntimeContext = CodexAppServerAuthProfileLookup & {
  authMode?: "prepared-api-key" | "profile";
  onAuthRefreshFailure?: () => void;
};

/** Normalizes saved model-provider attribution on Codex bindings. */
export function normalizeCodexAppServerBindingModelProvider(
  params: CodexAppServerAuthProfileLookup & { modelProvider?: string },
): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  return modelProvider.toLowerCase() === "codex" ? undefined : modelProvider.toLowerCase();
}
