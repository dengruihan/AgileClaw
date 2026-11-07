import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { entryKey, newVaultItemRef } from "./vault-crypto.js";
import { entryAadParams, encryptEntry } from "./vault-entry-crypto.js";
import { normalizeAgentSaveInput } from "./vault-input.js";
import {
  deleteVaultPendingEntrySecret,
  findVaultEntryByAccount,
  insertVaultEntry,
  insertVaultEntryRow,
  insertVaultEntrySecretRow,
  insertVaultPendingEntrySecret,
  insertVaultWriteKey,
  listVaultPendingEntrySecrets,
  readVaultEntry,
  readVaultEntrySecret,
  readVaultKeyRecord,
  readVaultPendingEntrySecret,
  readVaultWriteKeyRow,
} from "./vault-kernel.worker.js";
import {
  VaultError,
  type VaultAgentSaveInput,
  type VaultAuditAction,
  type VaultAuditStatus,
  type VaultEntryMetadata,
  type VaultOwner,
} from "./vault-types.js";
import {
  generateVaultWriteKeyPair,
  newVaultWriteKeyId,
  openVaultEntryWriteSeal,
  sealVaultEntryForWrite,
  unwrapVaultWritePrivateKey,
  wrapVaultWritePrivateKey,
} from "./vault-write-crypto.js";

export type NormalizedVaultEntryFields = {
  scheme: "https" | "http";
  host: string;
  port: number;
  siteLabel: string;
  account: string;
  label: string;
  password: string;
  notes: string;
};

export type VaultAgentSaveWorkerDeps = {
  owner: VaultOwner;
  db: () => OpenClawStateDatabase;
  /** Live DEK, or undefined while locked; never materializes a key. */
  dek: () => Buffer | undefined;
  requireDek: () => Buffer;
  readVaultKeyId: () => string;
  write: <T>(label: string, callback: (handle: OpenClawStateDatabase) => T) => T;
  audit: (
    handle: OpenClawStateDatabase,
    action: VaultAuditAction,
    status: VaultAuditStatus,
    options?: { itemRef?: string; reasonCode?: string },
  ) => void;
  clockNow: () => number;
  touchActivity: () => void;
  maintenance: () => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
};

function entryWriteFields(
  itemRef: string,
  normalized: NormalizedVaultEntryFields,
  hasNotes: boolean,
) {
  return {
    itemRef,
    scheme: normalized.scheme,
    host: normalized.host,
    port: normalized.port,
    siteLabel: normalized.siteLabel,
    account: normalized.account,
    ...(normalized.label ? { label: normalized.label } : {}),
    hasNotes,
    revision: 1,
  };
}

function baseEntryMetadata(
  itemRef: string,
  normalized: NormalizedVaultEntryFields,
  now: number,
): VaultEntryMetadata {
  return {
    itemRef,
    originScheme: normalized.scheme,
    originHost: normalized.host,
    originPort: normalized.port,
    siteLabel: normalized.siteLabel,
    account: normalized.account,
    ...(normalized.label ? { label: normalized.label } : {}),
    hasNotes: normalized.notes.length > 0,
    revision: 1,
    passwordUpdatedAtMs: now,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export function insertEntryWithDek(
  deps: VaultAgentSaveWorkerDeps,
  normalized: NormalizedVaultEntryFields,
  options: { reasonCode?: string } = {},
): VaultEntryMetadata {
  const activeDek = deps.requireDek();
  const now = deps.clockNow();
  const itemRef = newVaultItemRef();
  const baseEntry = baseEntryMetadata(itemRef, normalized, now);
  const key = entryKey(activeDek, itemRef);
  try {
    const keyId = deps.readVaultKeyId();
    const encrypted = encryptEntry(
      key,
      entryAadParams(baseEntry, keyId, deps.owner),
      normalized.password,
      normalized.notes,
    );
    deps.write("vault.create", (transaction) => {
      insertVaultEntry(
        transaction.db,
        deps.owner,
        entryWriteFields(itemRef, normalized, baseEntry.hasNotes),
        { ...encrypted, keyId },
        now,
      );
      deps.audit(transaction, "create", "succeeded", {
        itemRef,
        ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
      });
    });
    deps.touchActivity();
    return baseEntry;
  } finally {
    key.fill(0);
  }
}

/**
 * Agent save: only the site is required, blank fields stay blank for the
 * operator to complete later, and no approval flow runs. While unlocked this
 * is a normal DEK-encrypted create; while locked the secrets are sealed to the
 * write public key and migrate into the DEK format at the next unlock.
 */
export function saveLoginEntry(
  deps: VaultAgentSaveWorkerDeps,
  input: VaultAgentSaveInput,
): VaultEntryMetadata {
  const normalized = normalizeAgentSaveInput(input);
  deps.maintenance();
  if (normalized.account.length > 0) {
    const existing = findVaultEntryByAccount(
      deps.db().db,
      deps.owner,
      normalized.host,
      normalized.account,
    );
    if (existing && existing.deletedAtMs === undefined) {
      throw new VaultError(
        "VAULT_DUPLICATE",
        "An entry for this site and account already exists.",
        { existingItemRef: existing.itemRef },
      );
    }
  }
  if (deps.dek()) {
    return insertEntryWithDek(deps, normalized, { reasonCode: "agent" });
  }
  if (!readVaultKeyRecord(deps.db().db, deps.owner)) {
    throw new VaultError("VAULT_UNINITIALIZED", "Set up the password vault first.");
  }
  const writeKey = readVaultWriteKeyRow(deps.db().db, deps.owner);
  if (!writeKey) {
    throw new VaultError(
      "VAULT_WRITE_KEY_UNAVAILABLE",
      "Unlock the password vault once so agent saves also work while it stays locked.",
    );
  }
  const now = deps.clockNow();
  const itemRef = newVaultItemRef();
  const baseEntry = baseEntryMetadata(itemRef, normalized, now);
  const sealed = sealVaultEntryForWrite({
    writePublicKey: writeKey.publicKey,
    writeKeyId: writeKey.writeKeyId,
    aad: {
      writeKeyId: writeKey.writeKeyId,
      itemRef,
      ownerKind: deps.owner.kind,
      ownerId: deps.owner.id,
      originScheme: normalized.scheme,
      originHost: normalized.host,
      originPort: normalized.port,
      revision: 1,
    },
    password: normalized.password,
    notes: normalized.notes,
  });
  deps.write("vault.agent-save", (transaction) => {
    insertVaultEntryRow(
      transaction.db,
      deps.owner,
      entryWriteFields(itemRef, normalized, baseEntry.hasNotes),
      now,
    );
    insertVaultPendingEntrySecret(transaction.db, itemRef, writeKey.writeKeyId, sealed, now);
    deps.audit(transaction, "create", "succeeded", { itemRef, reasonCode: "agent" });
  });
  deps.touchActivity();
  return baseEntry;
}

/** Generate the owner write keypair on first unlock after this feature ships. */
export function ensureVaultWriteKey(deps: VaultAgentSaveWorkerDeps): void {
  if (readVaultWriteKeyRow(deps.db().db, deps.owner)) {
    return;
  }
  const activeDek = deps.requireDek();
  const keyId = deps.readVaultKeyId();
  const writeKeyId = newVaultWriteKeyId();
  const pair = generateVaultWriteKeyPair();
  try {
    const wrapped = wrapVaultWritePrivateKey({
      dek: activeDek,
      writeKeyId,
      ownerKind: deps.owner.kind,
      ownerId: deps.owner.id,
      keyId,
      privateKey: pair.privateKey,
    });
    deps.write("vault.write-key.create", (transaction) => {
      insertVaultWriteKey(
        transaction.db,
        deps.owner,
        {
          writeKeyId,
          publicKey: pair.publicKey,
          keyId,
          nonce: wrapped.nonce,
          wrappedPrivateKey: wrapped.wrappedPrivateKey,
        },
        deps.clockNow(),
      );
    });
  } finally {
    pair.privateKey.fill(0);
  }
}

/**
 * Move sealed agent rows into the per-entry DEK format. Runs at unlock, in
 * maintenance while unlocked, and lazily before reveal/update of an entry that
 * still has only a pending row. Per-row failures stay sealed and retry later.
 */
export function migratePendingEntrySecrets(
  deps: VaultAgentSaveWorkerDeps,
  itemRefs?: string[],
): void {
  if (!deps.dek()) {
    return;
  }
  const refs = itemRefs ?? listVaultPendingEntrySecrets(deps.db().db);
  if (refs.length === 0) {
    return;
  }
  const writeKey = readVaultWriteKeyRow(deps.db().db, deps.owner);
  if (!writeKey) {
    deps.warn("vault pending secrets have no write key");
    return;
  }
  const privateKey = unwrapVaultWritePrivateKey({
    dek: deps.requireDek(),
    writeKeyId: writeKey.writeKeyId,
    ownerKind: deps.owner.kind,
    ownerId: deps.owner.id,
    keyId: writeKey.keyId,
    nonce: writeKey.nonce,
    wrappedPrivateKey: writeKey.wrappedPrivateKey,
  });
  try {
    for (const itemRef of refs) {
      const pending = readVaultPendingEntrySecret(deps.db().db, itemRef);
      if (!pending) {
        continue;
      }
      const entry = readVaultEntry(deps.db().db, deps.owner, itemRef);
      if (!entry) {
        deps.write("vault.agent-claim", (transaction) => {
          deleteVaultPendingEntrySecret(transaction.db, itemRef);
        });
        continue;
      }
      try {
        const opened = openVaultEntryWriteSeal({
          writePrivateKey: privateKey,
          writePublicKey: writeKey.publicKey,
          writeKeyId: pending.writeKeyId,
          aad: {
            writeKeyId: pending.writeKeyId,
            itemRef,
            ownerKind: deps.owner.kind,
            ownerId: deps.owner.id,
            originScheme: entry.originScheme,
            originHost: entry.originHost,
            originPort: entry.originPort,
            revision: entry.revision,
          },
          sealed: pending,
        });
        const key = entryKey(deps.requireDek(), itemRef);
        try {
          const encrypted = encryptEntry(
            key,
            entryAadParams(entry, writeKey.keyId, deps.owner),
            opened.password,
            opened.notes,
          );
          deps.write("vault.agent-claim", (transaction) => {
            insertVaultEntrySecretRow(
              transaction.db,
              itemRef,
              { ...encrypted, keyId: writeKey.keyId },
              deps.clockNow(),
            );
            deleteVaultPendingEntrySecret(transaction.db, itemRef);
          });
        } finally {
          key.fill(0);
        }
      } catch (error) {
        // A row that fails authentication stays sealed; it retries on the next
        // unlock or maintenance pass instead of failing the whole sweep.
        deps.warn("vault pending secret migration failed", {
          itemRef,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  } finally {
    privateKey.fill(0);
  }
}

export function ensureEntrySecretsMigrated(deps: VaultAgentSaveWorkerDeps, itemRef: string): void {
  if (!deps.dek()) {
    return;
  }
  if (readVaultEntrySecret(deps.db().db, itemRef)) {
    return;
  }
  if (readVaultPendingEntrySecret(deps.db().db, itemRef)) {
    migratePendingEntrySecrets(deps, [itemRef]);
  }
}

/** Best-effort write-key setup and sealed-row claim right after an unlock. */
export function claimAgentWritesAfterUnlock(deps: VaultAgentSaveWorkerDeps): void {
  try {
    ensureVaultWriteKey(deps);
    migratePendingEntrySecrets(deps);
  } catch (error) {
    deps.warn("vault agent-write claim after unlock failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
