import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { countVaultEntries, readVaultKeyRecord, readVaultMeta } from "./vault-kernel.worker.js";
import {
  VAULT_DEFAULT_AUTO_LOCK_SECONDS,
  type VaultOwner,
  type VaultStatus,
} from "./vault-types.js";

export type VaultStatusDeps = {
  db: () => OpenClawStateDatabase;
  owner: VaultOwner;
  hasDek: () => boolean;
  touchActivity: () => void;
};

export function readVaultStatus(deps: VaultStatusDeps): VaultStatus {
  const handle = deps.db();
  deps.touchActivity();
  const record = readVaultKeyRecord(handle.db, deps.owner);
  const meta = readVaultMeta(handle.db, deps.owner) ?? {
    autoLockSeconds: VAULT_DEFAULT_AUTO_LOCK_SECONDS,
    failedAttempts: 0,
  };
  const counts = countVaultEntries(handle.db, deps.owner);
  const state = !record
    ? ("uninitialized" as const)
    : !record.wrap
      ? ("corrupted" as const)
      : deps.hasDek()
        ? ("unlocked" as const)
        : ("locked" as const);
  return {
    initialized: Boolean(record?.wrap),
    state,
    autoLockSeconds: meta.autoLockSeconds,
    failedAttempts: meta.failedAttempts,
    ...(meta.lockedUntilMs !== undefined ? { lockedUntilMs: meta.lockedUntilMs } : {}),
    ...counts,
  };
}
