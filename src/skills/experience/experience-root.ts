import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";

export const EXPERIENCE_SOURCE = "openclaw-experience";
export const EXPERIENCE_DOCUMENT_FILE = "EXPERIENCE.md";
/** Retired documents stay on disk, hidden from discovery and the prompt directory. */
export const EXPERIENCE_RETIRED_DIR = ".retired";
export const EXPERIENCE_MAX_ID_CHARS = 120;
export const EXPERIENCE_MAX_DESCRIPTION_BYTES = 160;

/** Agent-private Experience root; documents never cross agent boundaries. */
export function resolveExperienceRoot(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAgentDir(config, agentId, env), "experience");
}

export function resolveRetiredExperienceRoot(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveExperienceRoot(config, agentId, env), EXPERIENCE_RETIRED_DIR);
}

/** Stable document id derived from the human name, matching the directory name. */
export function normalizeExperienceId(name: string): string {
  return normalizeSkillIndexName(name);
}

export function assertExperienceId(id: string): string {
  const normalized = id.trim();
  if (
    !normalized ||
    normalized.length > EXPERIENCE_MAX_ID_CHARS ||
    normalized.startsWith(".") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("..") ||
    normalizeExperienceId(normalized) !== normalized
  ) {
    throw new Error(
      "Experience id must be a lowercase slug (letters, digits, single hyphens) of at most 120 characters.",
    );
  }
  return normalized;
}
