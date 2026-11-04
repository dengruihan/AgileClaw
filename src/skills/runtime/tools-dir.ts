import path from "node:path";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveConfigDir } from "../../utils.js";

/** Resolves a skill's tools directory relative to the AgileClaw config dir. */
export function resolveSkillToolsRootDir(skillKey: string): string {
  const safeKey = safePathSegmentHashed(skillKey);
  return path.join(resolveConfigDir(), "tools", safeKey);
}
