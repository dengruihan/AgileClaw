/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentHarnessPreflightError,
  resolveDefaultAgentDir,
} from "openclaw/plugin-sdk/agent-harness-registration";
import { resolveApiKeyForProfile, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { fingerprintApiKeyAuthProfileCacheKey } from "./auth-cache-key.js";
import {
  CodexAppServerAuthProfileUnavailableError,
  formatCodexAuthProfileUnavailableMessage,
} from "./auth-profile-recovery.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  CODEX_APP_SERVER_AUTH_PROVIDER,
  type CodexAppServerAuthProfileLookup,
} from "./auth-profile.js";
import {
  resolveCodexAppServerLocalHomeDir,
  withClearedEnvironmentVariables,
  withEphemeralCodexAuthStore,
} from "./auth-start-options.js";
import type {
  CodexAppServerPreparedAuth,
  CodexAppServerPreparedAuthProfileSnapshot,
  CodexAppServerResolvedPreparedAuth,
} from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import {
  ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource,
} from "./computer-use-marketplace.js";
import { ensureOwnedCodexHome } from "./computer-use-service-path.js";
import {
  ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath,
} from "./computer-use-service.js";
import { reconcileManagedCodexComputerUseCache } from "./computer-use-unified.js";
import type { CodexAppServerHomeScope, CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import type { CodexLoginAccountParams } from "./protocol.js";
import { codexPrewriteRejectionCause } from "./rpc-error.js";

const CODEX_HOME_ENV_VAR = "CODEX_HOME";
const HOME_ENV_VAR = "HOME";
const CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN",
];
const CODEX_APP_SERVER_HOME_ENV_VARS = [CODEX_HOME_ENV_VAR, HOME_ENV_VAR];
const MAX_COMPUTER_USE_ARTIFACT_OWNERS = 128;
const activeComputerUseArtifactReconciliations = new Map<
  string,
  { latestEpoch?: number; appliedCacheBinding?: string; active: number; tail: Promise<void> }
>();
type AuthProfileOrderConfig = Parameters<typeof resolveCodexAppServerAuthProfileId>[0]["config"];

// Runtime consumes canonical auth state; doctor owns retired profile-id migration.
function isCodexAppServerAuthProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === CODEX_APP_SERVER_AUTH_PROVIDER;
}

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  preparedAuth?: CodexAppServerPreparedAuth;
}): Promise<CodexAppServerStartOptions> {
  if (params.startOptions.transport !== "stdio") {
    return params.startOptions;
  }
  const scoped = await withCodexHomeEnvironment(
    withEphemeralCodexAuthStore(params),
    params.agentDir,
  );
  return withClearedEnvironmentVariables(scoped, CODEX_APP_SERVER_PREPARED_AUTH_ENV_VARS);
}

function resolveCodexAppServerAuthProfile(params: CodexAppServerAuthProfileLookup) {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {});
  const store = resolveCodexAppServerAuthProfileStore({ ...params, agentDir });
  const profileId = resolveCodexAppServerAuthProfileId({ ...params, store });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential || !isCodexAppServerAuthProvider(credential.provider)) {
    return undefined;
  }
  return { agentDir, store, profileId, credential };
}

/** Resolves prepared profile login material once so cache identity and RPC login cannot drift. */
export async function resolveCodexAppServerPreparedAuthProfileSnapshot(
  params: CodexAppServerAuthProfileLookup,
): Promise<CodexAppServerPreparedAuthProfileSnapshot | undefined> {
  const profile = resolveCodexAppServerAuthProfile(params);
  if (!profile || profile.credential.type !== "api_key") {
    return undefined;
  }
  const loginParams = await resolveCodexAppServerAuthProfileLoginParamsInternal({
    agentDir: profile.agentDir,
    authProfileId: profile.profileId,
    authProfileStore: profile.store,
    config: params.config,
  });
  if (!loginParams) {
    return undefined;
  }
  return {
    loginParams,
    secretFreeCacheKey: `${profile.profileId}:${fingerprintApiKeyAuthProfileCacheKey(loginParams.apiKey)}`,
  };
}

/** Model runs use an explicitly prepared OpenAI API key in an isolated CODEX_HOME. */
export async function resolveCodexAppServerPreparedAuthHandoff(params: {
  resolvedApiKey?: string;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  agentDir?: string;
  homeScope: CodexAppServerHomeScope;
  requirePreparedAuth?: boolean;
  config?: AuthProfileOrderConfig;
}) {
  const authProfileId = params.authProfileId?.trim() || undefined;
  if (authProfileId && !params.authProfileStore.profiles[authProfileId]) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(authProfileId),
    );
  }
  const profile = authProfileId ? params.authProfileStore.profiles[authProfileId] : undefined;
  const storedKey =
    authProfileId && profile?.type === "api_key"
      ? await resolveApiKeyForProfile({
          cfg: params.config,
          store: params.authProfileStore,
          profileId: authProfileId,
          agentDir: params.agentDir,
        })
      : undefined;
  const apiKey = params.resolvedApiKey?.trim() || storedKey?.apiKey?.trim();
  if (!apiKey) {
    throw createCodexAppServerAuthError(
      "Codex model execution requires a prepared API-key profile. Configure an API key in Models settings; native Codex login is not used.",
    );
  }
  return {
    authProfileId,
    nativeAuthProfile: false,
    preparedAuth: { kind: "api-key" as const, apiKey },
  };
}

export async function resolveCodexAppServerAuthAccountCacheKey(
  params: CodexAppServerAuthProfileLookup,
): Promise<string | undefined> {
  const profile = resolveCodexAppServerAuthProfile(params);
  if (!profile || profile.credential.type !== "api_key") {
    return undefined;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store: profile.store,
    profileId: profile.profileId,
    agentDir: profile.agentDir,
  });
  const value = resolved?.apiKey?.trim();
  return value
    ? `${profile.profileId}:${fingerprintApiKeyAuthProfileCacheKey(value)}`
    : profile.profileId;
}

export { resolveCodexAppServerHomeDir } from "./auth-start-options.js";

async function withCodexHomeEnvironment(
  startOptions: CodexAppServerStartOptions,
  agentDir: string | undefined,
): Promise<CodexAppServerStartOptions> {
  const codexHome = resolveCodexAppServerLocalHomeDir(startOptions, agentDir);
  const nativeHome = startOptions.env?.[HOME_ENV_VAR]?.trim()
    ? startOptions.env[HOME_ENV_VAR]
    : undefined;
  await fs.mkdir(codexHome, { recursive: true });
  if (nativeHome) {
    await fs.mkdir(nativeHome, { recursive: true });
  }
  const nextStartOptions: CodexAppServerStartOptions = {
    ...startOptions,
    env: {
      ...startOptions.env,
      [CODEX_HOME_ENV_VAR]: codexHome,
      ...(nativeHome ? { [HOME_ENV_VAR]: nativeHome } : {}),
    },
  };
  const clearEnv = withoutClearedCodexHomeEnv(startOptions.clearEnv);
  if (clearEnv) {
    nextStartOptions.clearEnv = clearEnv;
  } else {
    delete nextStartOptions.clearEnv;
  }
  return nextStartOptions;
}

/** Reconciles Computer Use artifacts for the exact managed command about to start. */
export async function reconcileCodexComputerUseStartArtifacts(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  pluginConfig?: unknown;
  ownsIsolatedCodexHome?: boolean;
  desktopGeneration?: CodexDesktopGeneration;
  assertCurrent?: () => void;
  forceCacheRefresh?: boolean;
}): Promise<void> {
  if (params.startOptions.transport !== "stdio") {
    return;
  }
  const codexHome = resolveCodexAppServerLocalHomeDir(params.startOptions, params.agentDir);
  const key = path.resolve(codexHome);
  let owner = activeComputerUseArtifactReconciliations.get(key);
  if (!owner) {
    owner = { active: 0, tail: Promise.resolve() };
    activeComputerUseArtifactReconciliations.set(key, owner);
  } else {
    activeComputerUseArtifactReconciliations.delete(key);
    activeComputerUseArtifactReconciliations.set(key, owner);
  }
  owner.active += 1;
  const epoch = params.desktopGeneration?.epoch;
  if (epoch !== undefined && (owner.latestEpoch === undefined || epoch > owner.latestEpoch)) {
    owner.latestEpoch = epoch;
  }
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (epoch !== undefined && owner.latestEpoch !== epoch) {
      throw new Error("Codex Computer Use artifact reconciliation was superseded.");
    }
  };
  const operation = owner.tail
    .catch(() => undefined)
    .then(async () => {
      assertCurrent();
      const appliedCacheBinding = await reconcileCodexComputerUseStartArtifactsOnce({
        ...params,
        codexHome,
        assertCurrent,
        previousCacheBinding: owner.appliedCacheBinding,
      });
      assertCurrent();
      owner.appliedCacheBinding = appliedCacheBinding;
    });
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  owner.tail = settled;
  try {
    await operation;
  } finally {
    owner.active = Math.max(0, owner.active - 1);
    if (
      owner.active === 0 &&
      owner.latestEpoch === undefined &&
      activeComputerUseArtifactReconciliations.get(key) === owner &&
      owner.tail === settled
    ) {
      activeComputerUseArtifactReconciliations.delete(key);
    }
    pruneComputerUseArtifactOwners();
  }
}

async function reconcileCodexComputerUseStartArtifactsOnce(
  params: Parameters<typeof reconcileCodexComputerUseStartArtifacts>[0] & {
    codexHome: string;
    assertCurrent: () => void;
    previousCacheBinding?: string;
  },
): Promise<string | undefined> {
  const codexHome = params.codexHome;
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig });
  const ownsIsolatedCodexHome =
    params.ownsIsolatedCodexHome ??
    (params.startOptions.homeScope !== "user" &&
      !params.startOptions.env?.[CODEX_HOME_ENV_VAR]?.trim());
  const shouldProvisionComputerUse =
    computerUseConfig.enabled && computerUseConfig.autoInstall && ownsIsolatedCodexHome;
  const provisioningAgentDir = shouldProvisionComputerUse ? params.agentDir : undefined;
  if (shouldProvisionComputerUse && !provisioningAgentDir) {
    throw new Error("Managed Codex Computer Use requires an OpenClaw agent directory");
  }
  if (provisioningAgentDir) {
    await ensureOwnedCodexHome(codexHome, provisioningAgentDir);
  } else {
    await fs.mkdir(codexHome, { recursive: true });
  }
  const desktopCandidates = resolveMacOSDesktopCodexAppPathCandidates();
  const exactDesktopCandidate = desktopCandidates.find(
    (candidate) =>
      path.resolve(candidate.appServerCommandPath) === path.resolve(params.startOptions.command),
  );
  const usesManagedBundledMarketplace =
    !computerUseConfig.marketplaceSource &&
    !computerUseConfig.marketplacePath &&
    !computerUseConfig.marketplaceName;
  const needsBundledMarketplace =
    usesManagedBundledMarketplace ||
    (computerUseConfig.pluginCacheMode === "shared" &&
      !computerUseConfig.marketplaceName &&
      !computerUseConfig.marketplacePath);
  const artifactCandidate = shouldProvisionComputerUse
    ? await resolveCompleteComputerUseArtifactCandidate({
        candidates: exactDesktopCandidate ? [exactDesktopCandidate] : desktopCandidates,
        needsBundledMarketplace,
      })
    : exactDesktopCandidate;
  params.assertCurrent();
  let marketplacePath: string | undefined;
  if (provisioningAgentDir) {
    if (desktopCandidates.length > 0 && !artifactCandidate) {
      throw new CodexComputerUseCandidateArtifactsUnavailableError();
    }
    try {
      marketplacePath = usesManagedBundledMarketplace
        ? await ensureCodexManagedBundledMarketplace({
            codexHome,
            ownershipRoot: provisioningAgentDir,
            computerUsePluginName: computerUseConfig.pluginName,
            computerUseMcpServerName: computerUseConfig.mcpServerName,
            ...(artifactCandidate
              ? {
                  appServerCommand: artifactCandidate.appServerCommandPath,
                  candidates: [artifactCandidate],
                  ownershipCandidates: desktopCandidates,
                }
              : {}),
            assertCurrent: params.assertCurrent,
          })
        : undefined;
      params.assertCurrent();
      if (usesManagedBundledMarketplace && desktopCandidates.length > 0 && !marketplacePath) {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
      const service = await ensureCodexComputerUseServiceApp({
        codexHome,
        ownershipRoot: params.agentDir,
        ...(artifactCandidate
          ? {
              appServerCommand: artifactCandidate.appServerCommandPath,
              sourceAppCandidates: artifactCandidate.computerUseServiceAppPaths,
            }
          : {}),
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent();
      if (desktopCandidates.length > 0 && service.status === "source_missing") {
        throw new CodexComputerUseCandidateArtifactsUnavailableError();
      }
    } catch (error) {
      params.assertCurrent();
      if (error instanceof CodexComputerUseCandidateArtifactsUnavailableError) {
        throw error;
      }
      throw new AgentHarnessPreflightError("Codex Computer Use client provisioning failed.", {
        cause: error,
        scope: "harness",
      });
    }
  }
  params.assertCurrent();
  return await reconcileManagedCodexComputerUseCache({
    codexHome,
    config: computerUseConfig,
    ownershipRoot: ownsIsolatedCodexHome ? params.agentDir : undefined,
    managedMarketplacePath: marketplacePath,
    bundledMarketplacePath: artifactCandidate?.bundledMarketplacePath,
    epoch: params.desktopGeneration?.epoch,
    assertCurrent: params.assertCurrent,
    forceRefresh: params.forceCacheRefresh,
    previousCacheBinding: params.previousCacheBinding,
  });
}

async function resolveCompleteComputerUseArtifactCandidate(params: {
  candidates: readonly MacOSDesktopCodexAppPathCandidate[];
  needsBundledMarketplace: boolean;
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  for (const candidate of params.candidates) {
    if (
      params.needsBundledMarketplace &&
      !(await resolveCodexManagedBundledMarketplaceSource({ candidates: [candidate] }))
    ) {
      continue;
    }
    if (
      await resolveCodexComputerUseServiceAppSourcePath({
        sourceAppCandidates: candidate.computerUseServiceAppPaths,
      })
    ) {
      return candidate;
    }
  }
  return undefined;
}

function pruneComputerUseArtifactOwners(): void {
  while (activeComputerUseArtifactReconciliations.size > MAX_COMPUTER_USE_ARTIFACT_OWNERS) {
    const inactive = [...activeComputerUseArtifactReconciliations].find(
      ([, owner]) => owner.active === 0,
    );
    if (!inactive) {
      return;
    }
    activeComputerUseArtifactReconciliations.delete(inactive[0]);
  }
}

class CodexComputerUseCandidateArtifactsUnavailableError extends Error {
  readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";

  constructor() {
    super("The selected Codex desktop app does not contain complete Computer Use artifacts.");
    this.name = "CodexComputerUseCandidateArtifactsUnavailableError";
  }
}

function withoutClearedCodexHomeEnv(clearEnv: string[] | undefined): string[] | undefined {
  if (!clearEnv) {
    return undefined;
  }
  const reserved = new Set(CODEX_APP_SERVER_HOME_ENV_VARS);
  const filtered = clearEnv.filter((envVar) => !reserved.has(envVar.trim().toUpperCase()));
  return filtered.length === clearEnv.length ? clearEnv : filtered;
}

export async function applyCodexAppServerAuthProfile(params: {
  client: CodexAppServerClient;
  agentDir?: string;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  startOptions?: CodexAppServerStartOptions;
  config?: AuthProfileOrderConfig;
  assertCurrent?: () => void;
}): Promise<void> {
  params.assertCurrent?.();
  const loginParams =
    params.preparedAuth?.kind === "api-key"
      ? { type: "apiKey" as const, apiKey: params.preparedAuth.apiKey }
      : params.preparedAuth?.kind === "profile"
        ? params.preparedAuth.snapshot.loginParams
        : params.authProfileId === null
          ? undefined
          : await resolveCodexAppServerAuthProfileLoginParamsInternal({
              agentDir: params.agentDir ?? resolveDefaultAgentDir(params.config ?? {}),
              authProfileId: params.authProfileId ?? undefined,
              authProfileStore: params.authProfileStore,
              config: params.config,
            });
  if (!loginParams) {
    throw createCodexAppServerAuthError(
      "Codex model execution requires a prepared API-key profile. Configure an API key in Models settings, then retry.",
    );
  }
  try {
    await params.client.request("account/login/start", loginParams, {
      assertCurrent: params.assertCurrent,
    });
  } catch (error) {
    throw codexPrewriteRejectionCause(error);
  }
}

function createCodexAppServerAuthError(message: string): Error & { status: 401 } {
  return Object.assign(new Error(message), { status: 401 as const });
}

async function resolveCodexAppServerAuthProfileLoginParamsInternal(params: {
  agentDir: string;
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  config?: AuthProfileOrderConfig;
}): Promise<Extract<CodexLoginAccountParams, { type: "apiKey" }> | undefined> {
  const store = resolveCodexAppServerAuthProfileStore(params);
  const profileId = resolveCodexAppServerAuthProfileId({ ...params, store });
  if (!profileId) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new CodexAppServerAuthProfileUnavailableError(
      formatCodexAuthProfileUnavailableMessage(profileId),
    );
  }
  if (!isCodexAppServerAuthProvider(credential.provider) || credential.type !== "api_key") {
    return undefined;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store: params.authProfileStore?.profiles[profileId] ? params.authProfileStore : store,
    profileId,
    agentDir: params.agentDir,
  });
  const apiKey = resolved?.apiKey?.trim();
  return apiKey ? { type: "apiKey", apiKey } : undefined;
}
