/** Prevents daemon write actions when the config belongs to a newer AgileClaw. */
import {
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "../config/future-version-guard.js";

export async function assertFutureConfigActionAllowed(action: string): Promise<void> {
  const { readConfigFileSnapshot } = await import("../config/io.runtime.js");
  const block = await readConfigFileSnapshot()
    .then((snapshot) => resolveFutureConfigActionBlock({ action, snapshot }))
    .catch(() => null);
  if (block) {
    throw new Error(formatFutureConfigActionBlock(block));
  }
}
