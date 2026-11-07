import { randomBytes, randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  claimAgentWritesAfterUnlock,
  ensureEntrySecretsMigrated,
  ensureVaultWriteKey,
  insertEntryWithDek,
  migratePendingEntrySecrets,
  saveLoginEntry,
  type VaultAgentSaveWorkerDeps,
} from "./vault-agent-save.worker.js";
import {
  constantTimeKeyCheckMatches,
  deriveKek,
  entryKey,
  generatePassword,
  newVaultKeyId,
  unwrapDek,
  VAULT_DEK_BYTES,
  VAULT_SCRYPT_PARAMS,
  VAULT_SALT_BYTES,
  wrapDek,
} from "./vault-crypto.js";
import {
  backoffUntil,
  decryptEntryFields,
  encryptEntry,
  entryAadParams,
  parseScryptParams,
} from "./vault-entry-crypto.js";
import {
  fillVaultEntry,
  recordVaultFillAudit,
  type VaultFillWorkerDeps,
} from "./vault-fill-worker.js";
import {
  normalizeAutoLockSeconds,
  normalizeCreateInput,
  normalizeUpdateInput,
  validatePassphrase,
} from "./vault-input.js";
import {
  countVaultEntries,
  insertVaultAudit,
  insertVaultKey,
  listVaultAudit,
  listVaultEntries,
  purgeExpiredVaultEntries,
  purgeVaultEntry,
  readVaultEntry,
  readVaultEntrySecret,
  readVaultKeyRecord,
  readVaultMeta,
  recordVaultKeyUse,
  restoreVaultEntry,
  softDeleteVaultEntry,
  touchVaultEntryLastUsed,
  updateVaultEntry,
  upsertVaultMeta,
} from "./vault-kernel.worker.js";
import { ensureVaultSchema } from "./vault-schema.js";
import { readVaultStatus } from "./vault-status.js";
import {
  VAULT_DEFAULT_AUTO_LOCK_SECONDS,
  VAULT_DEFAULT_OWNER_ID,
  VAULT_OWNER_KIND,
  VaultError,
  vaultErrorFromUnknown,
  type VaultAuditAction,
  type VaultEntryCreateInput,
  type VaultEntryMetadata,
  type VaultEntryUpdateInput,
  type VaultOwner,
  type VaultStatus,
} from "./vault-types.js";
import type {
  VaultWorkerData,
  VaultWorkerOperation,
  VaultWorkerReply,
  VaultWorkerResult,
} from "./vault-worker-protocol.js";

const port = parentPort;
if (!port) {
  throw new Error("vault worker requires a parent port");
}
// SAFETY: the sole launcher supplies VaultWorkerData.
const data = workerData as VaultWorkerData;
const owner: VaultOwner = { kind: VAULT_OWNER_KIND, id: VAULT_DEFAULT_OWNER_ID };
const log = createSubsystemLogger("vault/worker");
const send = (message: VaultWorkerReply) => port.postMessage(message);

let database: OpenClawStateDatabase | undefined;
let dek: Buffer | undefined;
let autoLockSeconds = VAULT_DEFAULT_AUTO_LOCK_SECONDS;
let manualNow = data.clock?.startMs ?? 0;
const clockNow = () => (data.clock ? manualNow : Date.now());
let lastActivityAt = clockNow();
let autoLockTimer: NodeJS.Timeout | undefined;

function db(): OpenClawStateDatabase {
  if (!database) {
    database = openOpenClawStateDatabase({
      path: data.databasePath,
      env: data.env,
    });
    ensureVaultSchema(database.db);
  }
  return database;
}

function write<T>(operationLabel: string, callback: (db: OpenClawStateDatabase) => T): T {
  const handle = db();
  return runOpenClawStateWriteTransaction(
    ({ db: connection }) => callback({ ...handle, db: connection }),
    { path: handle.path, env: data.env },
    { operationLabel },
  );
}

function audit(
  handle: OpenClawStateDatabase,
  action: VaultAuditAction,
  auditStatus: "succeeded" | "failed" | "blocked",
  options: { itemRef?: string; reasonCode?: string } = {},
): void {
  insertVaultAudit(
    handle.db,
    owner,
    {
      eventId: randomUUID(),
      action,
      status: auditStatus,
      ...(options.itemRef ? { itemRef: options.itemRef } : {}),
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
    },
    clockNow(),
  );
}

function zeroizeDek(): void {
  dek?.fill(0);
  dek = undefined;
}

function clearAutoLock(): void {
  if (autoLockTimer) {
    clearInterval(autoLockTimer);
    autoLockTimer = undefined;
  }
}

function armAutoLock(): void {
  clearAutoLock();
  if (!dek) {
    return;
  }
  autoLockTimer = setInterval(() => {
    checkAutoLock(true);
  }, 1_000);
  autoLockTimer.unref();
}

function checkAutoLock(notify: boolean): boolean {
  if (!dek || clockNow() - lastActivityAt < autoLockSeconds * 1000) {
    return false;
  }
  zeroizeDek();
  clearAutoLock();
  if (notify) {
    send({ type: "locked", reason: "auto" });
  }
  return true;
}

function touchActivity(): void {
  lastActivityAt = clockNow();
}

function requireDek(): Buffer {
  if (!dek) {
    throw new VaultError("VAULT_LOCKED", "Unlock the password vault first.");
  }
  return dek;
}

function status(): VaultStatus {
  return readVaultStatus({
    db,
    owner,
    hasDek: () => dek !== undefined,
    touchActivity,
  });
}

function maintenance(): void {
  const handle = db();
  if (countVaultEntries(handle.db, owner).deletedCount === 0) {
    migratePendingEntrySecrets(agentSaveDeps());
    return;
  }
  const now = clockNow();
  const purged = write("vault.maintenance.purge-expired", (transaction) => {
    const removed = purgeExpiredVaultEntries(transaction.db, owner, now);
    if (removed > 0) {
      audit(transaction, "purge-expired", "succeeded", { reasonCode: String(removed) });
    }
    return removed;
  });
  if (purged > 0) {
    touchActivity();
  }
  migratePendingEntrySecrets(agentSaveDeps());
}

async function initialize(passphrase: string, autoLockOption?: number): Promise<VaultStatus> {
  const normalized = validatePassphrase(passphrase);
  const lockSeconds = normalizeAutoLockSeconds(autoLockOption);
  const handle = db();
  const now = clockNow();
  const freshDek = randomBytes(VAULT_DEK_BYTES);
  const wrapSalt = randomBytes(VAULT_SALT_BYTES);
  const derived = await deriveKek(normalized, wrapSalt);
  try {
    if (readVaultKeyRecord(handle.db, owner)) {
      throw new VaultError("VAULT_ALREADY_INITIALIZED", "The password vault is already set up.");
    }
    const keyId = newVaultKeyId();
    const wrapped = wrapDek({
      keyId,
      ownerKind: owner.kind,
      ownerId: owner.id,
      dek: freshDek,
      kek: derived,
    });
    write("vault.initialize", (transaction) => {
      if (readVaultKeyRecord(transaction.db, owner)) {
        throw new VaultError("VAULT_ALREADY_INITIALIZED", "The password vault is already set up.");
      }
      insertVaultKey(
        transaction.db,
        owner,
        {
          keyId,
          salt: wrapSalt,
          paramsJson: JSON.stringify(VAULT_SCRYPT_PARAMS),
          nonce: wrapped.nonce,
          wrappedDek: wrapped.wrappedDek,
          keyCheck: wrapped.keyCheck,
        },
        lockSeconds,
        now,
      );
      audit(transaction, "initialize", "succeeded");
    });
    zeroizeDek();
    dek = freshDek;
    autoLockSeconds = lockSeconds;
    lastActivityAt = now;
    armAutoLock();
    // A fresh vault gets its write keypair immediately so agent saves work
    // before the first lock; existing vaults claim theirs on the next unlock.
    try {
      ensureVaultWriteKey(agentSaveDeps());
    } catch (error) {
      log.warn("vault write key creation failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
    return status();
  } catch (error) {
    freshDek.fill(0);
    throw error;
  } finally {
    derived.fill(0);
    wrapSalt.fill(0);
  }
}

async function unlock(passphrase: string): Promise<VaultStatus> {
  const normalized = validatePassphrase(passphrase);
  const handle = db();
  const now = clockNow();
  const record = readVaultKeyRecord(handle.db, owner);
  if (!record) {
    throw new VaultError("VAULT_UNINITIALIZED", "Set up the password vault first.");
  }
  if (!record.wrap) {
    throw new VaultError("VAULT_CORRUPTED", "The password vault key wrap is missing.");
  }
  const meta = readVaultMeta(handle.db, owner);
  if (meta?.lockedUntilMs !== undefined && now < meta.lockedUntilMs) {
    throw new VaultError("VAULT_LOCKED_OUT", "Too many failed attempts. Try again later.", {
      lockedUntilMs: meta.lockedUntilMs,
    });
  }
  if (
    record.wrap.method !== "passphrase" ||
    record.wrap.kdf !== "scrypt" ||
    record.wrap.salt.length !== VAULT_SALT_BYTES ||
    record.wrap.keyCheck.length !== VAULT_DEK_BYTES ||
    record.wrap.nonce.length !== 12
  ) {
    throw new VaultError("VAULT_CORRUPTED", "The password vault key material is corrupted.");
  }
  const params = parseScryptParams(record.wrap.paramsJson);
  const kek = await deriveKek(normalized, record.wrap.salt, params);
  try {
    if (!constantTimeKeyCheckMatches(record.wrap.keyCheck, kek)) {
      const failures = (meta?.failedAttempts ?? 0) + 1;
      const lockedUntilMs = backoffUntil(failures, now);
      write("vault.unlock.failed", (transaction) => {
        upsertVaultMeta(
          transaction.db,
          owner,
          {
            autoLockSeconds: meta?.autoLockSeconds ?? VAULT_DEFAULT_AUTO_LOCK_SECONDS,
            failedAttempts: failures,
            ...(lockedUntilMs !== undefined ? { lockedUntilMs } : {}),
          },
          now,
        );
        audit(transaction, "unlock-failed", "failed", { reasonCode: "wrong-passphrase" });
      });
      if (lockedUntilMs !== undefined) {
        throw new VaultError("VAULT_LOCKED_OUT", "Too many failed attempts. Try again later.", {
          lockedUntilMs,
        });
      }
      throw new VaultError("VAULT_WRONG_PASSPHRASE", "Incorrect master passphrase.");
    }
    let unwrapped: Buffer;
    try {
      unwrapped = unwrapDek({
        keyId: record.keyId,
        ownerKind: owner.kind,
        ownerId: owner.id,
        kek,
        nonce: record.wrap.nonce,
        wrappedDek: record.wrap.wrappedDek,
      });
    } catch {
      throw new VaultError(
        "VAULT_CORRUPTED",
        "The password vault data encryption key is corrupted.",
      );
    }
    zeroizeDek();
    dek = unwrapped;
    autoLockSeconds = meta?.autoLockSeconds ?? VAULT_DEFAULT_AUTO_LOCK_SECONDS;
    lastActivityAt = now;
    write("vault.unlock", (transaction) => {
      upsertVaultMeta(
        transaction.db,
        owner,
        { autoLockSeconds, failedAttempts: 0, lockedUntilMs: undefined },
        now,
      );
      recordVaultKeyUse(transaction.db, record.keyId, now);
      audit(transaction, "unlock", "succeeded");
    });
    armAutoLock();
    // Sealed agent rows become DEK-encrypted while the key is held, and a
    // vault that predates agent saves gets its write keypair here.
    claimAgentWritesAfterUnlock(agentSaveDeps());
    return status();
  } finally {
    kek.fill(0);
  }
}

function readVaultKeyId(): string {
  const record = readVaultKeyRecord(db().db, owner);
  if (!record) {
    throw new VaultError("VAULT_UNINITIALIZED", "The password vault is not initialized.");
  }
  return record.keyId;
}

function createEntry(input: VaultEntryCreateInput): VaultEntryMetadata {
  const normalized = normalizeCreateInput(input);
  maintenance();
  return insertEntryWithDek(agentSaveDeps(), normalized);
}

function agentSaveDeps(): VaultAgentSaveWorkerDeps {
  return {
    owner,
    db,
    dek: () => dek,
    requireDek,
    readVaultKeyId,
    write,
    audit,
    clockNow,
    touchActivity,
    maintenance,
    warn: (message, details) => log.warn(message, details),
  };
}

function updateEntry(input: VaultEntryUpdateInput): VaultEntryMetadata {
  const activeDek = requireDek();
  const normalized = normalizeUpdateInput(input);
  const handle = db();
  const existing = readVaultEntry(handle.db, owner, normalized.itemRef);
  if (!existing || existing.deletedAtMs !== undefined) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
  if (existing.revision !== normalized.revision) {
    throw new VaultError(
      "VAULT_CONFLICT",
      "This entry changed on another screen. Refresh and retry.",
    );
  }
  // An agent save that landed while locked may still be sealed; claim it first.
  ensureEntrySecretsMigrated(agentSaveDeps(), normalized.itemRef);
  const secret = readVaultEntrySecret(handle.db, normalized.itemRef);
  if (!secret) {
    throw new VaultError("VAULT_CORRUPTED", "The vault entry secret is missing.");
  }
  const keyId = readVaultKeyId();
  const current = decryptEntryFields(activeDek, owner, existing, secret, secret.keyId);
  const nextNotes = normalized.notes ?? current.notes;
  const now = clockNow();
  const nextEntry: VaultEntryMetadata = {
    ...existing,
    originScheme: normalized.scheme,
    originHost: normalized.host,
    originPort: normalized.port,
    siteLabel: normalized.siteLabel,
    account: normalized.account,
    label: normalized.label || undefined,
    hasNotes: nextNotes.length > 0,
    revision: existing.revision + 1,
    passwordUpdatedAtMs:
      normalized.password !== undefined ? now : (existing.passwordUpdatedAtMs ?? now),
    updatedAtMs: now,
  };
  const key = entryKey(activeDek, normalized.itemRef);
  try {
    const encrypted = encryptEntry(
      key,
      entryAadParams(nextEntry, keyId, owner),
      normalized.password ?? current.password,
      nextNotes,
    );
    write("vault.update", (transaction) => {
      updateVaultEntry(
        transaction.db,
        owner,
        {
          itemRef: normalized.itemRef,
          scheme: normalized.scheme,
          host: normalized.host,
          port: normalized.port,
          siteLabel: normalized.siteLabel,
          account: normalized.account,
          ...(normalized.label ? { label: normalized.label } : {}),
          hasNotes: nextEntry.hasNotes,
          revision: nextEntry.revision,
        },
        {
          ...encrypted,
          keyId,
          passwordUpdatedAtMs: nextEntry.passwordUpdatedAtMs ?? now,
        },
        now,
      );
      audit(transaction, "update", "succeeded", { itemRef: normalized.itemRef });
    });
    touchActivity();
    return nextEntry;
  } finally {
    key.fill(0);
  }
}

function deleteEntry(itemRef: string, revision: number): void {
  requireDek();
  const handle = db();
  const existing = readVaultEntry(handle.db, owner, itemRef);
  if (!existing || existing.deletedAtMs !== undefined) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
  if (existing.revision !== revision) {
    throw new VaultError(
      "VAULT_CONFLICT",
      "This entry changed on another screen. Refresh and retry.",
    );
  }
  const now = clockNow();
  write("vault.delete", (transaction) => {
    softDeleteVaultEntry(transaction.db, owner, itemRef, now);
    audit(transaction, "delete", "succeeded", { itemRef });
  });
  touchActivity();
}

function restoreEntry(itemRef: string): void {
  requireDek();
  const now = clockNow();
  write("vault.restore", (transaction) => {
    restoreVaultEntry(transaction.db, owner, itemRef, now);
    audit(transaction, "restore", "succeeded", { itemRef });
  });
  touchActivity();
}

function purgeEntry(itemRef: string): void {
  requireDek();
  write("vault.purge", (transaction) => {
    purgeVaultEntry(transaction.db, owner, itemRef);
    audit(transaction, "purge", "succeeded", { itemRef });
  });
  touchActivity();
}

function revealEntry(
  itemRef: string,
  mode: "reveal" | "copy",
): { entry: VaultEntryMetadata; password: string; notes: string } {
  requireDek();
  const handle = db();
  const entry = readVaultEntry(handle.db, owner, itemRef);
  if (!entry) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
  if (entry.deletedAtMs !== undefined) {
    throw new VaultError("VAULT_DELETED", "Restore this entry before viewing it.");
  }
  // An agent save that landed while locked may still be sealed; claim it first.
  ensureEntrySecretsMigrated(agentSaveDeps(), itemRef);
  const secret = readVaultEntrySecret(handle.db, itemRef);
  if (!secret) {
    throw new VaultError("VAULT_CORRUPTED", "The vault entry secret is missing.");
  }
  const decrypted = decryptEntryFields(requireDek(), owner, entry, secret, secret.keyId);
  const now = clockNow();
  write(`vault.${mode}`, (transaction) => {
    touchVaultEntryLastUsed(transaction.db, owner, itemRef, now);
    audit(transaction, mode, "succeeded", { itemRef });
  });
  touchActivity();
  return { entry: { ...entry, lastUsedAtMs: now }, ...decrypted };
}

function fillWorkerDeps(): VaultFillWorkerDeps {
  return {
    owner,
    db,
    requireDek,
    write,
    audit,
    clockNow,
    touchActivity,
    ensureSecretsMigrated: (itemRef) => ensureEntrySecretsMigrated(agentSaveDeps(), itemRef),
  };
}

function setAutoLock(seconds: number): VaultStatus {
  requireDek();
  const lockSeconds = normalizeAutoLockSeconds(seconds);
  const now = clockNow();
  write("vault.set-auto-lock", (transaction) => {
    upsertVaultMeta(
      transaction.db,
      owner,
      { autoLockSeconds: lockSeconds, failedAttempts: 0, lockedUntilMs: undefined },
      now,
    );
  });
  autoLockSeconds = lockSeconds;
  lastActivityAt = now;
  armAutoLock();
  return status();
}

async function execute(operation: VaultWorkerOperation): Promise<VaultWorkerResult> {
  switch (operation.type) {
    case "status":
      return { type: "status", status: status() };
    case "initialize":
      return {
        type: "initialize",
        status: await initialize(operation.passphrase, operation.autoLockSeconds),
      };
    case "unlock":
      return { type: "unlock", status: await unlock(operation.passphrase) };
    case "lock": {
      zeroizeDek();
      clearAutoLock();
      write("vault.lock", (transaction) => {
        audit(transaction, "lock", "succeeded");
      });
      return { type: "lock" };
    }
    case "list": {
      touchActivity();
      maintenance();
      return {
        type: "list",
        entries: listVaultEntries(db().db, owner, { includeDeleted: operation.includeDeleted }),
      };
    }
    case "create":
      return { type: "create", entry: createEntry(operation.input) };
    case "saveLogin":
      return { type: "saveLogin", entry: saveLoginEntry(agentSaveDeps(), operation.input) };
    case "update":
      return { type: "update", entry: updateEntry(operation.input) };
    case "delete":
      deleteEntry(operation.itemRef, operation.revision);
      return { type: "delete" };
    case "restore":
      restoreEntry(operation.itemRef);
      return { type: "restore" };
    case "purge":
      purgeEntry(operation.itemRef);
      return { type: "purge" };
    case "reveal":
      return { type: "reveal", ...revealEntry(operation.itemRef, operation.mode) };
    case "fill":
      return {
        type: "fill",
        ...fillVaultEntry(
          fillWorkerDeps(),
          operation.itemRef,
          operation.revision,
          operation.origin,
        ),
      };
    case "fill.audit":
      recordVaultFillAudit(
        fillWorkerDeps(),
        operation.itemRef,
        operation.reasonCode,
        operation.status,
      );
      return { type: "fill.audit" };
    case "generate": {
      const password = generatePassword({
        ...(operation.length !== undefined ? { length: operation.length } : {}),
        ...(operation.includeSymbols !== undefined
          ? { includeSymbols: operation.includeSymbols }
          : {}),
      });
      write("vault.generate", (transaction) => {
        audit(transaction, "generate", "succeeded");
      });
      touchActivity();
      return { type: "generate", password };
    }
    case "setAutoLock":
      return { type: "setAutoLock", status: setAutoLock(operation.autoLockSeconds) };
    case "audit.list":
      touchActivity();
      return {
        type: "audit.list",
        events: listVaultAudit(db().db, owner, {
          limit: operation.limit,
          ...(operation.before !== undefined ? { before: operation.before } : {}),
        }),
      };
    case "internal.tick": {
      if (!data.clock) {
        throw new VaultError("VAULT_UNAVAILABLE", "A manual clock is not configured.");
      }
      manualNow += Math.max(0, operation.advanceMs);
      checkAutoLock(false);
      runLifecycleMaintenance();
      return { type: "internal.tick", status: status() };
    }
    default:
      throw new VaultError("VAULT_UNAVAILABLE", "Unknown password vault operation.");
  }
}

port.on("message", (request: { id: number; operation: VaultWorkerOperation }) => {
  void (async () => {
    try {
      const result = await execute(request.operation);
      send({ type: "reply", id: request.id, ok: true, result });
    } catch (error) {
      const vaultError = vaultErrorFromUnknown(error);
      send({
        type: "reply",
        id: request.id,
        ok: false,
        error: {
          code: vaultError.code,
          message: vaultError.message,
          ...(vaultError.details ? { details: vaultError.details } : {}),
        },
      });
    }
  })();
});

function runLifecycleMaintenance(): void {
  try {
    maintenance();
  } catch {
    // The first vault request retries after a transient startup failure.
  }
}

runLifecycleMaintenance();
if (!data.clock) {
  const maintenanceTimer = setInterval(runLifecycleMaintenance, 60 * 60_000);
  maintenanceTimer.unref();
}

send({ type: "ready" });

process.on("exit", () => {
  zeroizeDek();
  void database?.walMaintenance.stop();
});
