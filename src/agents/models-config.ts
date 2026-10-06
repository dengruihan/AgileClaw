/**
 * Ensures agent-local models.json and the SQLite-backed plugin model catalog
 * match runtime config, discovered providers, auth-profile state, and
 * generated catalog ownership.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import {
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
  resolveDefaultAgentDir,
} from "./agent-scope.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { MODELS_JSON_STATE, type ModelsJsonReadyResult } from "./models-config-state.js";
import { planOpenClawModelsJson, type PreparedModelsConfigContext } from "./models-config.plan.js";
import {
  capturePluginModelCatalogAuth,
  withPluginModelCatalogAuthObservations,
} from "./plugin-model-catalog-auth.js";
import { loadPersistedPluginModelCatalogs } from "./plugin-model-catalog-execution.js";
import { replacePersistedPluginModelCatalogs } from "./plugin-model-catalog.js";

type ModelsConfigPluginMetadataSnapshot = Pick<
  PluginMetadataSnapshot,
  "index" | "manifestRegistry" | "owners" | "pluginIds"
>;

type EnsureOpenClawModelsJsonOptions = {
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: ModelsConfigPluginMetadataSnapshot;
  workspaceDir?: string;
};

type PlannedOpenClawModelsJsonSource = Readonly<{
  agentDir: string;
  modelsJsonContents: string | null;
  /** Plugin-owned provider rows, keyed by their generated catalog path. */
  pluginCatalogWrites: Record<string, string>;
}>;

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

async function buildModelsJsonFingerprint(context: PreparedModelsConfigContext): Promise<string> {
  const authProfilesSqlitePath = resolveAuthProfileDatabasePath(context.agentDir);
  const authProfilesMtimeMs = await readFileMtimeMs(authProfilesSqlitePath);
  const authProfilesWalMtimeMs = await readFileMtimeMs(`${authProfilesSqlitePath}-wal`);
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(context.agentDir, "models.json"));
  const pluginCatalogFingerprint = createHash("sha256")
    .update(
      stableStringify(
        await loadPersistedPluginModelCatalogs(context.agentDir, undefined, context.env),
      ),
    )
    .digest("base64url");
  const pluginMetadataSnapshotIndexFingerprint = context.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(context.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: context.cfg,
    discoveryAuthConfigHash: hashRuntimeConfigValue(context.discoveryAuthConfig),
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    envShape: context.envFingerprint,
    authProfilesMtimeMs,
    authProfilesWalMtimeMs,
    modelsFileMtimeMs,
    pluginCatalogFingerprint,
    workspaceDir: context.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    pluginMetadataSnapshotPluginIds:
      context.pluginMetadataSnapshot?.pluginIds === undefined
        ? null
        : context.pluginMetadataSnapshot.pluginIds.toSorted(),
  });
}

function modelsJsonReadyCacheKey(targetPath: string, fingerprint: string): string {
  return `${targetPath}\0${fingerprint}`;
}

async function readExistingModelsFile(pathname: string): Promise<string> {
  try {
    return (
      (await privateFileStore(path.dirname(pathname)).readTextIfExists(path.basename(pathname))) ??
      ""
    );
  } catch {
    return "";
  }
}

/** Best-effort chmod for the user-visible generated models.json file. */
async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

function resolveModelsConfigInput(config: OpenClawConfig): {
  config: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  const projected = runtimeSource ? projectConfigOntoRuntimeSourceSnapshot(config) : config;
  return {
    config: projected,
    discoveryAuthConfig: config,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? (runtimeSource ?? config) : projected,
  };
}

async function prepareModelsConfigContext(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<PreparedModelsConfigContext> {
  let ambientEnv = process.env;
  let capturedOptions = options;
  let resolved: ReturnType<typeof resolveModelsConfigInput>;
  if (config) {
    resolved = resolveModelsConfigInput(config);
  } else {
    capturedOptions = {
      ...options,
      ...(options.env ? { env: cloneEnvWithPlatformSemantics(options.env) } : {}),
    };
    const captured = await captureRuntimeConfigAsyncReader({ capture: true })();
    ambientEnv = captured.env;
    const source = projectConfigOntoRuntimeSourceSnapshot(captured.config);
    resolved = {
      config: source,
      discoveryAuthConfig: captured.config,
      sourceConfigForSecrets: source,
    };
  }
  const cfg = resolved.config;
  const agentDir = agentDirOverride?.trim()
    ? agentDirOverride.trim()
    : resolveDefaultAgentDir(cfg, ambientEnv);
  const workspaceDir =
    capturedOptions.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : // Same ambient owner resolveDefaultAgentDir just used for agentDir; resolving it
        // on the deprecated chain here rejected explicit fleets owned by a system agent.
        resolveAgentWorkspaceDir(cfg, resolveAmbientOwnerAgentId(cfg), ambientEnv));
  const fingerprintEnv = createConfigRuntimeEnv(cfg, capturedOptions.env ?? {});
  const env = capturedOptions.env ? fingerprintEnv : createConfigRuntimeEnv(cfg, ambientEnv);
  const pluginMetadataSnapshot =
    capturedOptions.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
  return {
    cfg,
    discoveryAuthConfig: resolved.discoveryAuthConfig,
    // Native readiness belongs to the captured auth inputs, not the catalog's env clone.
    discoveryAuthEnv: capturedOptions.env ?? ambientEnv,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    env,
    envFingerprint: capturedOptions.env ? hashRuntimeConfigValue(fingerprintEnv) : fingerprintEnv,
    workspaceDir: workspaceDir || undefined,
    pluginMetadataSnapshot,
  };
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<ModelsJsonReadyResult> {
  const context = await prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir } = context;
  const targetPath = path.join(agentDir, "models.json");
  const fingerprint = await buildModelsJsonFingerprint(context);
  const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
  const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
  if (cached) {
    const settled = await cached;
    await ensureModelsFileModeForModelsJson(targetPath);
    return { ...settled };
  }

  const pending = MODELS_JSON_STATE.writeQueue.enqueue(targetPath, async () => {
    const existingModelsRaw = await readExistingModelsFile(targetPath);
    const authSnapshot = await capturePluginModelCatalogAuth(agentDir, context.env);
    const plan = await withPluginModelCatalogAuthObservations(authSnapshot, async () =>
      planOpenClawModelsJson({
        context,
        existingRaw: existingModelsRaw,
      }),
    );

    let wroteRoot = false;
    if (plan.action === "write") {
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      wroteRoot = existingModelsRaw !== plan.contents;
      if (wroteRoot) {
        await privateFileStore(path.dirname(targetPath)).writeText("models.json", plan.contents);
        MODELS_JSON_STATE.costCache.delete(agentDir);
      }
      await ensureModelsFileModeForModelsJson(targetPath);
    }
    const wrotePluginCatalog = plan.pluginCatalogWrites
      ? await replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: plan.pluginCatalogWrites,
          authSnapshot,
          env: context.env,
        })
      : false;
    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
    }
    return { agentDir, wrote: wroteRoot || wrotePluginCatalog };
  });
  MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    const refreshedFingerprint = await buildModelsJsonFingerprint(context);
    const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
    if (refreshedCacheKey !== cacheKey) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
      MODELS_JSON_STATE.readyCache.set(refreshedCacheKey, Promise.resolve(settled));
    }
    return { ...settled };
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * Plans the complete root/plugin catalog generation without mutating agent-owned state.
 * Control-plane inventory reads use this when their lifecycle generation may be superseded.
 */
export async function planOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<PlannedOpenClawModelsJsonSource> {
  const context = await prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir } = context;
  const existingModelsRaw = await readExistingModelsFile(path.join(agentDir, "models.json"));
  const plan = await planOpenClawModelsJson({
    context,
    existingRaw: existingModelsRaw,
  });
  return {
    agentDir,
    modelsJsonContents: plan.action === "write" ? plan.contents : existingModelsRaw || null,
    pluginCatalogWrites: plan.pluginCatalogWrites ?? {},
  };
}
