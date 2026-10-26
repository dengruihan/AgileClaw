import { expectDefined } from "@openclaw/normalization-core";
// On roughly one day in sixteen, the interactive banner gains a tiny ASCII
// jade disc. The shared lobster-day hash keeps the banner deterministic.
import { isLobsterDay, lobsterDayHash } from "../shared/lobster-day.js";

const LOBSTER_ARTS: readonly string[] = [
  // The jade disc held up, catching the light.
  ["   .-==-.  ", "  /  __  \\ ", " |  (__)  |", "  \\      / ", "   '-..-'  "].join("\n"),
  // The disc's reflection rippling on water.
  ["    (  )   ", "  ~ (  ) ~ ", " ~~~~~~~~~~"].join("\n"),
] as const;

/**
 * Return the ASCII jade art for `now`'s calendar day, or null on non-art
 * days and in CI/test environments (banner tests assert exact bytes).
 */
export function pickCliLobsterArt(now: Date, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CI || env.VITEST) {
    return null;
  }
  if (!isLobsterDay(now)) {
    return null;
  }
  return expectDefined(
    LOBSTER_ARTS[(lobsterDayHash(now) >>> 8) % LOBSTER_ARTS.length],
    "lobster arts entry at (lobster day hash(now) >>> 8) % lobster arts.length",
  );
}
