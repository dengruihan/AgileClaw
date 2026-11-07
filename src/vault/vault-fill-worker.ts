import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { decryptEntryFields } from "./vault-entry-crypto.js";
import { compareFillOrigin } from "./vault-fill-origin.js";
import {
  readVaultEntry,
  readVaultEntrySecret,
  touchVaultEntryLastUsed,
} from "./vault-kernel.worker.js";
import {
  VaultError,
  type VaultAuditAction,
  type VaultAuditStatus,
  type VaultEntryMetadata,
  type VaultOrigin,
  type VaultOwner,
} from "./vault-types.js";

export type VaultFillWorkerDeps = {
  owner: VaultOwner;
  db: () => OpenClawStateDatabase;
  requireDek: () => Buffer;
  write: <T>(label: string, callback: (handle: OpenClawStateDatabase) => T) => T;
  audit: (
    handle: OpenClawStateDatabase,
    action: VaultAuditAction,
    status: VaultAuditStatus,
    options?: { itemRef?: string; reasonCode?: string },
  ) => void;
  clockNow: () => number;
  touchActivity: () => void;
  /** Claims a still-sealed agent save before the fill reads its secrets. */
  ensureSecretsMigrated?: (itemRef: string) => void;
};

/** Decrypt one entry for the fill broker after exact revision and origin checks. */
export function fillVaultEntry(
  deps: VaultFillWorkerDeps,
  itemRef: string,
  revision: number,
  origin: VaultOrigin,
): { entry: VaultEntryMetadata; password: string } {
  deps.requireDek();
  const handle = deps.db();
  const entry = readVaultEntry(handle.db, deps.owner, itemRef);
  if (!entry || entry.deletedAtMs !== undefined) {
    deps.write("vault.fill.not-found", (transaction) => {
      deps.audit(transaction, "fill", "failed", { itemRef, reasonCode: "not_found" });
    });
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
  if (entry.revision !== revision) {
    deps.write("vault.fill.revision-mismatch", (transaction) => {
      deps.audit(transaction, "fill", "blocked", { itemRef, reasonCode: "revision_mismatch" });
    });
    throw new VaultError(
      "VAULT_CONFLICT",
      "This entry changed after approval. Request the fill again.",
    );
  }
  const comparison = compareFillOrigin(
    { scheme: entry.originScheme, host: entry.originHost, port: entry.originPort },
    origin,
  );
  if (comparison !== "match") {
    deps.write("vault.fill.origin-mismatch", (transaction) => {
      deps.audit(transaction, "fill", "blocked", { itemRef, reasonCode: comparison });
    });
    throw new VaultError(
      "VAULT_ORIGIN_MISMATCH",
      "The browser origin does not match this vault entry.",
    );
  }
  deps.ensureSecretsMigrated?.(itemRef);
  const secret = readVaultEntrySecret(handle.db, itemRef);
  if (!secret) {
    deps.write("vault.fill.corrupted", (transaction) => {
      deps.audit(transaction, "fill", "failed", { itemRef, reasonCode: "corrupted" });
    });
    throw new VaultError("VAULT_CORRUPTED", "The vault entry secret is missing.");
  }
  const decrypted = decryptEntryFields(deps.requireDek(), deps.owner, entry, secret, secret.keyId);
  const now = deps.clockNow();
  deps.write("vault.fill", (transaction) => {
    touchVaultEntryLastUsed(transaction.db, deps.owner, itemRef, now);
    deps.audit(transaction, "fill", "succeeded", { itemRef });
  });
  deps.touchActivity();
  return { entry: { ...entry, lastUsedAtMs: now }, password: decrypted.password };
}

/** Value-free audit for a fill attempt that never reached decryption. */
export function recordVaultFillAudit(
  deps: VaultFillWorkerDeps,
  itemRef: string | undefined,
  reasonCode: string,
  status: "failed" | "blocked",
): void {
  deps.write("vault.fill.audit", (transaction) => {
    deps.audit(transaction, "fill", status, {
      ...(itemRef ? { itemRef } : {}),
      reasonCode,
    });
  });
}
