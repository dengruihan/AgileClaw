import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const GEMINI_CLI_TRUSTED_TRANSPORT_ENV = new Set([
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_API_KEY_AUTH_MECHANISM",
  "GOOGLE_GENAI_API_VERSION",
]);

export const GEMINI_CLI_EXACT_TOOL_ENV_BARRIERS: Record<string, string> = {
  GOOGLE_GENAI_USE_GCA: "false",
  CLOUD_SHELL: "false",
  GEMINI_CLI_USE_COMPUTE_ADC: "false",
  GEMINI_TELEMETRY_LOG_PROMPTS: "false",
  // Gemini CLI otherwise treats an inherited path as authority to write its
  // built-in system prompt, including outside the isolated workspace.
  GEMINI_WRITE_SYSTEM_MD: "false",
};

export type GeminiCliRestrictedAuthContext = {
  workspaceDir?: string;
  baseEnv?: Record<string, string>;
  systemSettingsPath?: string;
  isolatedCompletionPrompt?: string;
  isolatedCompletionSystemPrompt?: string;
};

type GeminiCliTransportEnv = {
  transport: Record<string, string>;
};

// Gemini CLI 0.39.1 runs this commandUtils grammar before pasted-text unescape;
// any immediate backslash suppresses inclusion. Parity logic would reject
// prompts the pinned CLI keeps literal.
const GEMINI_CLI_AT_INCLUDE_PATTERN =
  /(?<!\\)@(?:(?:"(?:[^"]*)")|(?:\\.|[^ \t\n\r,;!?()[\]{}.]|\.(?!$|[ \t\n\r])))+/u;

export function isolatedCompletionInputError(message: string): Error & { code: "input-rejected" } {
  const error = new Error(message) as Error & { code: "input-rejected" };
  error.name = "IsolatedCompletionInputError";
  error.code = "input-rejected";
  return error;
}

export function assertGeminiCliLiteralIsolatedPrompt(ctx: GeminiCliRestrictedAuthContext): boolean {
  if (ctx.isolatedCompletionSystemPrompt === undefined) {
    return false;
  }
  const prompt = ctx.isolatedCompletionPrompt;
  if (prompt === undefined) {
    return false;
  }
  // Gemini CLI preprocesses these forms before inference and has no raw-input
  // flag. Reject them rather than read a resource or alter the user's bytes.
  if (GEMINI_CLI_AT_INCLUDE_PATTERN.test(prompt)) {
    throw isolatedCompletionInputError(
      "Gemini CLI isolated completion cannot safely pass native @-include syntax.",
    );
  }
  if (prompt.startsWith("/") && !prompt.startsWith("//") && !prompt.startsWith("/*")) {
    throw isolatedCompletionInputError(
      "Gemini CLI isolated completion cannot safely pass native /command syntax.",
    );
  }
  return true;
}

export async function readGeminiCliJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const normalized = normalizeOptionalString(filePath);
  if (!normalized) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(normalized, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Gemini CLI system settings must be a JSON object: ${normalized}`);
    }
    return { ...parsed };
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function resolveGeminiCliAmbientHome(ctx: GeminiCliRestrictedAuthContext): string {
  return (
    normalizeOptionalString(ctx.baseEnv?.GEMINI_CLI_HOME) ??
    normalizeOptionalString(process.env.GEMINI_CLI_HOME) ??
    os.homedir()
  );
}

function projectGeminiCliTrustedTransportEnv(
  ctx: GeminiCliRestrictedAuthContext,
  ambientEnv: GeminiCliTransportEnv,
): Record<string, string> {
  return Object.fromEntries(
    [...GEMINI_CLI_TRUSTED_TRANSPORT_ENV].map((name) => [
      name,
      normalizeOptionalString(ctx.baseEnv?.[name]) ??
        normalizeOptionalString(process.env[name]) ??
        normalizeOptionalString(ambientEnv.transport[name]) ??
        "",
    ]),
  );
}

async function readGeminiCliTransportEnv(
  filePath: string,
): Promise<GeminiCliTransportEnv | undefined> {
  try {
    const parsed = parseDotEnv(await fs.readFile(filePath, "utf8"));
    return {
      transport: Object.fromEntries(
        Object.entries(parsed).filter(([key]) => GEMINI_CLI_TRUSTED_TRANSPORT_ENV.has(key)),
      ),
    };
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function loadGeminiCliTransportEnv(
  ctx: GeminiCliRestrictedAuthContext,
): Promise<GeminiCliTransportEnv> {
  const home = resolveGeminiCliAmbientHome(ctx);
  for (const candidate of [path.join(home, ".gemini", ".env"), path.join(home, ".env")]) {
    const env = await readGeminiCliTransportEnv(candidate);
    if (env !== undefined) {
      return env;
    }
  }
  return { transport: {} };
}

export async function resolveGeminiCliTrustedTransportEnv(
  ctx: GeminiCliRestrictedAuthContext,
): Promise<Record<string, string>> {
  return projectGeminiCliTrustedTransportEnv(ctx, await loadGeminiCliTransportEnv(ctx));
}
