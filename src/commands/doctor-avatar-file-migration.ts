/** Doctor-owned migration of persisted base64 agent avatars into workspace image files. */
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import {
  decodeAvatarImageDataUrl,
  persistAgentAvatarUpload,
} from "../agents/identity-avatar-upload.js";
import {
  MAX_IDENTITY_FILE_BYTES,
  mergeIdentityMarkdownContent,
  parseIdentityMarkdown,
} from "../agents/identity-file.js";
import { getAgentWorkspaceAccess, type AgentWorkspaceAccess } from "../agents/workspace-access.js";
import { DEFAULT_IDENTITY_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getRecord } from "../config/legacy.shared.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { publishFileNoClobber, syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isAvatarDataUrl } from "../shared/avatar-policy.js";
import { shortenHomePath } from "../utils.js";

const AVATAR_MIGRATION_CHECK_ID = "core/doctor/avatar-file-migration";

const NO_CLOBBER_PUBLICATION = {
  strategy: "link-or-copy",
  durability: "degrade",
} as const;

type AvatarMigrationTarget = {
  agentId: string;
  workspaceDir: string;
  /** Config-held avatar value; a data URL here gets replaced with the file path. */
  configAvatar: string | undefined;
  /** Avatar value parsed from the workspace IDENTITY.md. */
  identityAvatar: string | undefined;
  /** Why IDENTITY.md could not be inspected; unknown state must never look synced. */
  identityReadError?: string;
};

function isDataUrlAvatar(value: string | undefined): value is string {
  return value !== undefined && isAvatarDataUrl(value);
}

function readConfigAvatar(entry: unknown): string | undefined {
  const avatar = getRecord(getRecord(entry)?.identity)?.avatar;
  return typeof avatar === "string" && avatar.trim() ? avatar.trim() : undefined;
}

/** Walk both roster shapes so legacy list configs migrate before their roster repair. */
function* visitAgentEntryRecords(
  config: OpenClawConfig,
): Generator<{ agentId: string; entry: Record<string, unknown> }> {
  const agents = getRecord(config.agents);
  const entries = getRecord(agents?.entries);
  if (entries) {
    for (const [key, value] of Object.entries(entries)) {
      const entry = getRecord(value);
      const agentId = normalizeAgentId(key);
      if (entry && agentId) {
        yield { agentId, entry };
      }
    }
  }
  const list = agents?.list;
  if (Array.isArray(list)) {
    for (const value of list) {
      const entry = getRecord(value);
      const agentId = typeof entry?.id === "string" ? normalizeAgentId(entry.id) : "";
      if (entry && agentId) {
        yield { agentId, entry };
      }
    }
  }
}

/** Read IDENTITY.md through the workspace owner so remote workspaces migrate too. */
async function readWorkspaceIdentityState(
  workspaceDir: string,
): Promise<{ content: string; access?: AgentWorkspaceAccess } | undefined> {
  const access = getAgentWorkspaceAccess(workspaceDir);
  if (access) {
    try {
      const buffer = await access.bridge.readFile({
        filePath: DEFAULT_IDENTITY_FILENAME,
        maxBytes: MAX_IDENTITY_FILE_BYTES,
      });
      if (getAgentWorkspaceAccess(workspaceDir) !== access) {
        throw new Error("Workspace access changed while reading the Agent identity");
      }
      return { content: buffer.toString("utf8"), access };
    } catch (error) {
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
  }
  try {
    const workspaceRoot = await fsSafeRoot(workspaceDir);
    const safeRead = await workspaceRoot.read(DEFAULT_IDENTITY_FILENAME, { hardlinks: "reject" });
    return { content: safeRead.buffer.toString("utf8") };
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return undefined;
    }
    throw error;
  }
}

async function inspectWorkspaceIdentityAvatar(
  workspaceDir: string,
): Promise<{ avatar?: string; error?: string }> {
  try {
    const state = await readWorkspaceIdentityState(workspaceDir);
    if (!state) {
      return {};
    }
    const identity = parseIdentityMarkdown(state.content);
    const avatar = identity?.avatar?.trim();
    return avatar ? { avatar } : {};
  } catch (error) {
    // An unreadable IDENTITY.md is unknown state, not an empty file: keep the
    // error so Doctor neither claims a sync nor silently half-migrates config.
    return { error: formatErrorMessage(error) };
  }
}

async function collectAvatarMigrationTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<AvatarMigrationTarget[]> {
  const targets: AvatarMigrationTarget[] = [];
  const seen = new Set<string>();
  for (const { agentId, entry } of visitAgentEntryRecords(config)) {
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    const configAvatar = readConfigAvatar(entry);
    const workspaceDir = resolveAgentWorkspaceDir(config, agentId, env);
    const identity = await inspectWorkspaceIdentityAvatar(workspaceDir);
    if (identity.error || isDataUrlAvatar(configAvatar) || isDataUrlAvatar(identity.avatar)) {
      targets.push({
        agentId,
        workspaceDir,
        configAvatar,
        identityAvatar: identity.avatar,
        ...(identity.error ? { identityReadError: identity.error } : {}),
      });
    }
  }
  return targets;
}

async function archiveIdentityFile(params: {
  agentId: string;
  content: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const safeAgentId = params.agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  const archivePath = path.join(
    resolveStateDir(params.env),
    "backups",
    "avatar-file-migration",
    `${safeAgentId}-${sha256Hex(params.content)}.md`,
  );
  const archiveDir = path.dirname(archivePath);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const tempPath = `${archivePath}.doctor-writing-${process.pid}-${Date.now()}`;
  try {
    {
      await using handle = await fs.open(tempPath, "wx", 0o600);
      await handle.writeFile(params.content, "utf8");
      await handle.sync();
    }
    await publishFileNoClobber(tempPath, archivePath, NO_CLOBBER_PUBLICATION);
    await fs.rm(tempPath);
    await syncDirectoryIfSupported(archiveDir);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (sha256Hex(await fs.readFile(archivePath, "utf8")) !== sha256Hex(params.content)) {
      throw new Error(`Avatar migration archive collision at ${archivePath}`, { cause: error });
    }
  }
  return archivePath;
}

async function writeWorkspaceIdentityContent(params: {
  workspaceDir: string;
  content: string;
  access: AgentWorkspaceAccess | undefined;
}): Promise<void> {
  // Archive I/O may outlive the binding captured by the read; revalidate the
  // exact owner immediately before the write side effect.
  if (getAgentWorkspaceAccess(params.workspaceDir) !== params.access) {
    throw new Error(
      "Workspace access changed after the Agent identity was archived; refusing to write through a stale workspace binding",
    );
  }
  if (params.access) {
    await params.access.bridge.writeFile({
      filePath: DEFAULT_IDENTITY_FILENAME,
      data: params.content,
      mkdir: false,
    });
    if (getAgentWorkspaceAccess(params.workspaceDir) !== params.access) {
      throw new Error("Workspace access changed while writing the Agent identity");
    }
    return;
  }
  const workspaceRoot = await fsSafeRoot(params.workspaceDir);
  await workspaceRoot.write(DEFAULT_IDENTITY_FILENAME, params.content, { encoding: "utf8" });
}

async function rewriteIdentityAvatarLine(params: {
  agentId: string;
  workspaceDir: string;
  source: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const existing = await readWorkspaceIdentityState(params.workspaceDir);
  if (existing === undefined) {
    return undefined;
  }
  const archivePath = await archiveIdentityFile({
    agentId: params.agentId,
    content: existing.content,
    env: params.env,
  });
  const content = mergeIdentityMarkdownContent(existing.content, { avatar: params.source });
  await writeWorkspaceIdentityContent({
    workspaceDir: params.workspaceDir,
    content,
    access: existing.access,
  });
  return shortenHomePath(archivePath);
}

function describeTargetSources(target: AvatarMigrationTarget): string {
  const sources = [
    ...(isDataUrlAvatar(target.configAvatar) ? ["config"] : []),
    ...(isDataUrlAvatar(target.identityAvatar) ? ["IDENTITY.md"] : []),
  ];
  return sources.join(" and ");
}

export async function collectAvatarFileMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  try {
    const targets = await collectAvatarMigrationTargets(cfg, env);
    return targets.map((target) => {
      if (target.identityReadError) {
        return {
          checkId: AVATAR_MIGRATION_CHECK_ID,
          severity: "error" as const,
          message: `Agent "${target.agentId}" IDENTITY.md could not be inspected: ${target.identityReadError}. Its persisted avatar state is unknown.`,
          target: target.agentId,
          requirement: "avatar-file-migration",
          fixHint: `Restore workspace read access for ${shortenHomePath(target.workspaceDir)}, then run ${formatCliCommand("openclaw doctor --fix")} and rerun doctor to confirm no avatar findings remain.`,
        };
      }
      return {
        checkId: AVATAR_MIGRATION_CHECK_ID,
        severity: "warning" as const,
        message: `Agent "${target.agentId}" persists a base64 avatar data URI in ${describeTargetSources(target)}; base64 is no longer a supported persisted avatar source.`,
        target: target.agentId,
        requirement: "avatar-file-migration",
        fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to decode it into an image file under ${shortenHomePath(target.workspaceDir)} and reference that path.`,
      };
    });
  } catch (error) {
    return [
      {
        checkId: AVATAR_MIGRATION_CHECK_ID,
        severity: "error" as const,
        message: `Persisted avatars could not be inspected: ${formatErrorMessage(error)}`,
        requirement: "avatar-file-migration",
        fixHint: `Resolve the workspace read error, then run ${formatCliCommand("openclaw doctor --fix")}.`,
      },
    ];
  }
}

export type AvatarFileMigrationResult = {
  config: OpenClawConfig;
  /** Committed filesystem effects; safe to report immediately. */
  fileChanges: string[];
  /** Config mutations that become durable with the doctor config write. */
  configChanges: string[];
  warnings: string[];
};

/**
 * Decode every persisted base64 avatar into a workspace image file and point
 * config plus IDENTITY.md at it. A failed agent keeps its original values with
 * an actionable warning so no source data is lost.
 */
export async function migrateAgentAvatarFilesToWorkspaces(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<AvatarFileMigrationResult> {
  const env = params.env ?? process.env;
  const fileChanges: string[] = [];
  const configChanges: string[] = [];
  const warnings: string[] = [];
  let targets: AvatarMigrationTarget[];
  try {
    targets = await collectAvatarMigrationTargets(params.config, env);
  } catch (error) {
    return {
      config: params.config,
      fileChanges,
      configChanges,
      warnings: [`Persisted avatars could not be inspected: ${formatErrorMessage(error)}`],
    };
  }

  for (const target of targets) {
    const label = `Agent "${target.agentId}"`;
    if (target.identityReadError) {
      warnings.push(
        `${label} avatar was not migrated: IDENTITY.md could not be read (${target.identityReadError}). No persisted avatar source was changed; restore workspace read access, then rerun doctor.`,
      );
      continue;
    }
    // Config owns the effective avatar; when both hold base64, its bytes win and
    // the archived IDENTITY.md preserves the other value.
    const dataUrl = isDataUrlAvatar(target.configAvatar)
      ? target.configAvatar
      : target.identityAvatar;
    if (!dataUrl || !isDataUrlAvatar(dataUrl)) {
      continue;
    }
    const decoded = decodeAvatarImageDataUrl(dataUrl);
    if (!decoded.ok) {
      warnings.push(
        `${label} avatar was not migrated: ${decoded.message}. Replace its persisted avatar with a workspace-relative path or http(s) URL, then rerun doctor.`,
      );
      continue;
    }
    try {
      const persisted = await persistAgentAvatarUpload({
        workspaceDir: target.workspaceDir,
        agentId: target.agentId,
        decoded: decoded.value,
      });
      let archivedNote = "";
      if (isDataUrlAvatar(target.identityAvatar)) {
        const archivePath = await rewriteIdentityAvatarLine({
          agentId: target.agentId,
          workspaceDir: target.workspaceDir,
          source: persisted.source,
          env,
        });
        archivedNote = archivePath ? ` (IDENTITY.md archived at ${archivePath})` : "";
      }
      fileChanges.push(
        `${label} avatar decoded to ${shortenHomePath(persisted.filePath)}${archivedNote}.`,
      );
      if (isDataUrlAvatar(target.configAvatar)) {
        for (const { agentId, entry } of visitAgentEntryRecords(params.config)) {
          if (agentId === target.agentId) {
            const identity = getRecord(entry.identity) ?? {};
            identity.avatar = persisted.source;
            entry.identity = identity;
          }
        }
        configChanges.push(
          `${label} identity.avatar now references the workspace file ${persisted.source}.`,
        );
      }
    } catch (error) {
      warnings.push(
        `${label} avatar was not migrated: ${formatErrorMessage(error)}. The original avatar value is unchanged; fix the workspace error, then rerun doctor.`,
      );
    }
  }

  return { config: params.config, fileChanges, configChanges, warnings };
}
