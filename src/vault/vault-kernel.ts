import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  VAULT_SOFT_DELETE_RETENTION_MS,
  VaultError,
  type VaultAuditAction,
  type VaultAuditEvent,
  type VaultAuditStatus,
  type VaultEntryMetadata,
  type VaultOrigin,
  type VaultOwner,
} from "./vault-types.js";

type VaultDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "vault_entries"
  | "vault_entry_secrets"
  | "vault_keys"
  | "vault_key_wraps"
  | "vault_meta"
  | "vault_audit_events"
>;

export type VaultKeyRecord = {
  keyId: string;
  ownerKind: string;
  ownerId: string;
  createdAtMs: number;
  wrap?: {
    method: string;
    kdf: string;
    salt: Buffer;
    paramsJson: string;
    nonce: Buffer;
    wrappedDek: Buffer;
    keyCheck: Buffer;
    lastUsedAtMs?: number;
  };
};

export type VaultMetaRecord = {
  autoLockSeconds: number;
  failedAttempts: number;
  lockedUntilMs?: number;
};

export type VaultEntrySecretRecord = {
  itemRef: string;
  keyId: string;
  aadVersion: number;
  secretNonce: Buffer;
  secretCiphertext: Buffer;
  notesNonce: Buffer;
  notesCiphertext: Buffer;
};

export type VaultEncryptedEntry = {
  secretNonce: Buffer;
  secretCiphertext: Buffer;
  notesNonce: Buffer;
  notesCiphertext: Buffer;
};

export type VaultEntryWriteFields = VaultOrigin & {
  itemRef: string;
  siteLabel: string;
  account: string;
  label?: string;
  hasNotes: boolean;
  revision: number;
};

function kysely(db: DatabaseSync) {
  return getNodeSqliteKysely<VaultDatabase>(db);
}

function toMetadata(row: OpenClawStateKyselyDatabase["vault_entries"]): VaultEntryMetadata {
  return {
    itemRef: row.item_ref,
    originScheme: row.origin_scheme as "https" | "http",
    originHost: row.origin_host,
    originPort: Number(row.origin_port),
    siteLabel: row.site_label,
    account: row.account,
    ...(row.label !== null ? { label: row.label } : {}),
    hasNotes: Number(row.has_notes) === 1,
    revision: Number(row.revision),
    ...(row.password_updated_at_ms !== null
      ? { passwordUpdatedAtMs: Number(row.password_updated_at_ms) }
      : {}),
    ...(row.last_used_at_ms !== null ? { lastUsedAtMs: Number(row.last_used_at_ms) } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    ...(row.deleted_at_ms !== null ? { deletedAtMs: Number(row.deleted_at_ms) } : {}),
  };
}

export function readVaultKeyRecord(
  db: DatabaseSync,
  owner: VaultOwner,
): VaultKeyRecord | undefined {
  const key = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("vault_keys")
      .selectAll()
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("retired_at_ms", "is", null),
  );
  if (!key) {
    return undefined;
  }
  const wrap = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db).selectFrom("vault_key_wraps").selectAll().where("key_id", "=", key.key_id),
  );
  return {
    keyId: key.key_id,
    ownerKind: key.owner_kind,
    ownerId: key.owner_id,
    createdAtMs: Number(key.created_at_ms),
    wrap: wrap
      ? {
          method: wrap.method,
          kdf: wrap.kdf,
          salt: Buffer.from(wrap.salt),
          paramsJson: wrap.params_json,
          nonce: Buffer.from(wrap.nonce),
          wrappedDek: Buffer.from(wrap.wrapped_dek),
          keyCheck: Buffer.from(wrap.key_check),
          ...(wrap.last_used_at_ms !== null ? { lastUsedAtMs: Number(wrap.last_used_at_ms) } : {}),
        }
      : undefined,
  } as VaultKeyRecord;
}

export function readVaultMeta(db: DatabaseSync, owner: VaultOwner): VaultMetaRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("vault_meta")
      .selectAll()
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id),
  );
  if (!row) {
    return undefined;
  }
  return {
    autoLockSeconds: Number(row.auto_lock_seconds),
    failedAttempts: Number(row.failed_attempts),
    ...(row.locked_until_ms !== null ? { lockedUntilMs: Number(row.locked_until_ms) } : {}),
  };
}

export function countVaultEntries(
  db: DatabaseSync,
  owner: VaultOwner,
): { itemCount: number; deletedCount: number } {
  const rows = executeSqliteQuerySync(
    db,
    kysely(db)
      .selectFrom("vault_entries")
      .select(["deleted_at_ms"])
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id),
  ).rows;
  let itemCount = 0;
  let deletedCount = 0;
  for (const row of rows) {
    if (row.deleted_at_ms === null) {
      itemCount += 1;
    } else {
      deletedCount += 1;
    }
  }
  return { itemCount, deletedCount };
}

export function listVaultEntries(
  db: DatabaseSync,
  owner: VaultOwner,
  options: { includeDeleted: boolean },
): VaultEntryMetadata[] {
  let query = kysely(db)
    .selectFrom("vault_entries")
    .selectAll()
    .where("owner_kind", "=", owner.kind)
    .where("owner_id", "=", owner.id);
  if (!options.includeDeleted) {
    query = query.where("deleted_at_ms", "is", null);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("deleted_at_ms", "asc").orderBy("updated_at_ms", "desc"),
  ).rows;
  return rows.map(toMetadata);
}

export function readVaultEntry(
  db: DatabaseSync,
  owner: VaultOwner,
  itemRef: string,
): VaultEntryMetadata | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db)
      .selectFrom("vault_entries")
      .selectAll()
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", itemRef),
  );
  return row ? toMetadata(row) : undefined;
}

export function readVaultEntrySecret(
  db: DatabaseSync,
  itemRef: string,
): VaultEntrySecretRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely(db).selectFrom("vault_entry_secrets").selectAll().where("item_ref", "=", itemRef),
  );
  if (!row) {
    return undefined;
  }
  return {
    itemRef: row.item_ref,
    keyId: row.key_id,
    aadVersion: Number(row.aad_version),
    secretNonce: Buffer.from(row.secret_nonce),
    secretCiphertext: Buffer.from(row.secret_ciphertext),
    notesNonce: Buffer.from(row.notes_nonce),
    notesCiphertext: Buffer.from(row.notes_ciphertext),
  };
}

export function insertVaultEntry(
  db: DatabaseSync,
  owner: VaultOwner,
  fields: VaultEntryWriteFields,
  encrypted: VaultEncryptedEntry & { keyId: string },
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .insertInto("vault_entries")
      .values({
        item_ref: fields.itemRef,
        owner_kind: owner.kind,
        owner_id: owner.id,
        origin_scheme: fields.scheme,
        origin_host: fields.host,
        origin_port: fields.port,
        site_label: fields.siteLabel,
        account: fields.account,
        label: fields.label ?? null,
        has_notes: fields.hasNotes ? 1 : 0,
        revision: fields.revision,
        password_updated_at_ms: now,
        last_used_at_ms: null,
        created_at_ms: now,
        updated_at_ms: now,
        deleted_at_ms: null,
      }),
  );
  executeSqliteQuerySync(
    db,
    kysely(db).insertInto("vault_entry_secrets").values({
      item_ref: fields.itemRef,
      key_id: encrypted.keyId,
      aad_version: 1,
      secret_nonce: encrypted.secretNonce,
      secret_ciphertext: encrypted.secretCiphertext,
      notes_nonce: encrypted.notesNonce,
      notes_ciphertext: encrypted.notesCiphertext,
      updated_at_ms: now,
    }),
  );
}

export function updateVaultEntry(
  db: DatabaseSync,
  owner: VaultOwner,
  fields: VaultEntryWriteFields,
  encrypted: VaultEncryptedEntry & { keyId: string; passwordUpdatedAtMs: number },
  now: number,
): void {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_entries")
      .set({
        origin_scheme: fields.scheme,
        origin_host: fields.host,
        origin_port: fields.port,
        site_label: fields.siteLabel,
        account: fields.account,
        label: fields.label ?? null,
        has_notes: fields.hasNotes ? 1 : 0,
        revision: fields.revision,
        password_updated_at_ms: encrypted.passwordUpdatedAtMs,
        updated_at_ms: now,
      })
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", fields.itemRef)
      .where("deleted_at_ms", "is", null),
  );
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
  executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_entry_secrets")
      .set({
        key_id: encrypted.keyId,
        secret_nonce: encrypted.secretNonce,
        secret_ciphertext: encrypted.secretCiphertext,
        notes_nonce: encrypted.notesNonce,
        notes_ciphertext: encrypted.notesCiphertext,
        updated_at_ms: now,
      })
      .where("item_ref", "=", fields.itemRef),
  );
}

export function softDeleteVaultEntry(
  db: DatabaseSync,
  owner: VaultOwner,
  itemRef: string,
  now: number,
): void {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_entries")
      .set({ deleted_at_ms: now, updated_at_ms: now })
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", itemRef)
      .where("deleted_at_ms", "is", null),
  );
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
}

export function restoreVaultEntry(
  db: DatabaseSync,
  owner: VaultOwner,
  itemRef: string,
  now: number,
): void {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_entries")
      .set({ deleted_at_ms: null, updated_at_ms: now })
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", itemRef)
      .where("deleted_at_ms", "is not", null),
  );
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw new VaultError("VAULT_NOT_FOUND", "The deleted vault entry no longer exists.");
  }
}

export function purgeVaultEntry(db: DatabaseSync, owner: VaultOwner, itemRef: string): void {
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .deleteFrom("vault_entries")
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", itemRef),
  );
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw new VaultError("VAULT_NOT_FOUND", "The vault entry no longer exists.");
  }
}

export function purgeExpiredVaultEntries(db: DatabaseSync, owner: VaultOwner, now: number): number {
  const cutoff = now - VAULT_SOFT_DELETE_RETENTION_MS;
  const result = executeSqliteQuerySync(
    db,
    kysely(db)
      .deleteFrom("vault_entries")
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("deleted_at_ms", "is not", null)
      .where("deleted_at_ms", "<=", cutoff),
  );
  return Number(result.numAffectedRows ?? 0n);
}

export function touchVaultEntryLastUsed(
  db: DatabaseSync,
  owner: VaultOwner,
  itemRef: string,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_entries")
      .set({ last_used_at_ms: now })
      .where("owner_kind", "=", owner.kind)
      .where("owner_id", "=", owner.id)
      .where("item_ref", "=", itemRef),
  );
}

export function insertVaultKey(
  db: DatabaseSync,
  owner: VaultOwner,
  key: {
    keyId: string;
    salt: Buffer;
    paramsJson: string;
    nonce: Buffer;
    wrappedDek: Buffer;
    keyCheck: Buffer;
  },
  autoLockSeconds: number,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    kysely(db).insertInto("vault_keys").values({
      key_id: key.keyId,
      owner_kind: owner.kind,
      owner_id: owner.id,
      created_at_ms: now,
      retired_at_ms: null,
    }),
  );
  executeSqliteQuerySync(
    db,
    kysely(db).insertInto("vault_key_wraps").values({
      key_id: key.keyId,
      method: "passphrase",
      kdf: "scrypt",
      salt: key.salt,
      params_json: key.paramsJson,
      nonce: key.nonce,
      wrapped_dek: key.wrappedDek,
      key_check: key.keyCheck,
      created_at_ms: now,
      last_used_at_ms: null,
    }),
  );
  upsertVaultMeta(db, owner, { autoLockSeconds, failedAttempts: 0 }, now);
}

export function upsertVaultMeta(
  db: DatabaseSync,
  owner: VaultOwner,
  meta: VaultMetaRecord,
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .insertInto("vault_meta")
      .values({
        owner_kind: owner.kind,
        owner_id: owner.id,
        auto_lock_seconds: meta.autoLockSeconds,
        failed_attempts: meta.failedAttempts,
        locked_until_ms: meta.lockedUntilMs ?? null,
        updated_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["owner_kind", "owner_id"]).doUpdateSet({
          auto_lock_seconds: meta.autoLockSeconds,
          failed_attempts: meta.failedAttempts,
          locked_until_ms: meta.lockedUntilMs ?? null,
          updated_at_ms: now,
        }),
      ),
  );
}

export function recordVaultKeyUse(db: DatabaseSync, keyId: string, now: number): void {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .updateTable("vault_key_wraps")
      .set({ last_used_at_ms: now })
      .where("key_id", "=", keyId),
  );
}

export function insertVaultAudit(
  db: DatabaseSync,
  owner: VaultOwner,
  event: {
    eventId: string;
    action: VaultAuditAction;
    status: VaultAuditStatus;
    itemRef?: string;
    reasonCode?: string;
  },
  now: number,
): void {
  executeSqliteQuerySync(
    db,
    kysely(db)
      .insertInto("vault_audit_events")
      .values({
        event_id: event.eventId,
        owner_kind: owner.kind,
        owner_id: owner.id,
        action: event.action,
        status: event.status,
        item_ref: event.itemRef ?? null,
        reason_code: event.reasonCode ?? null,
        occurred_at_ms: now,
      }),
  );
}

export function listVaultAudit(
  db: DatabaseSync,
  owner: VaultOwner,
  options: { limit: number; before?: number },
): VaultAuditEvent[] {
  let query = kysely(db)
    .selectFrom("vault_audit_events")
    .selectAll()
    .where("owner_kind", "=", owner.kind)
    .where("owner_id", "=", owner.id);
  if (options.before !== undefined) {
    query = query.where("sequence", "<", options.before);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("sequence", "desc").limit(options.limit),
  ).rows;
  const events: VaultAuditEvent[] = [];
  for (const row of rows) {
    events.push({
      sequence: Number(row.sequence),
      action: row.action as VaultAuditAction,
      status: row.status as VaultAuditStatus,
      ...(row.item_ref !== null ? { itemRef: row.item_ref } : {}),
      ...(row.reason_code !== null ? { reasonCode: row.reason_code } : {}),
      occurredAtMs: Number(row.occurred_at_ms),
    });
  }
  return events;
}
