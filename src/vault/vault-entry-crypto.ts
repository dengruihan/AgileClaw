import {
  decryptField,
  encryptField,
  entryAadForField,
  entryKey,
  VAULT_SCRYPT_PARAMS,
} from "./vault-crypto.js";
import type { VaultEncryptedEntry } from "./vault-kernel.js";
import { VaultError, type VaultEntryMetadata, type VaultOwner } from "./vault-types.js";

export function parseScryptParams(paramsJson: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(paramsJson);
  } catch {
    throw new VaultError("VAULT_CORRUPTED", "The password vault KDF parameters are corrupted.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new VaultError("VAULT_CORRUPTED", "The password vault KDF parameters are corrupted.");
  }
  const record = parsed as { N?: unknown; r?: unknown; p?: unknown };
  if (record.N !== 32768 || record.r !== 8 || record.p !== 1) {
    throw new VaultError("VAULT_CORRUPTED", "The password vault KDF parameters are unsupported.");
  }
  return VAULT_SCRYPT_PARAMS;
}

export function backoffUntil(failures: number, now: number): number | undefined {
  if (failures < 5 || failures % 5 !== 0) {
    return undefined;
  }
  const tier = failures / 5;
  const delay = tier <= 1 ? 30_000 : tier === 2 ? 300_000 : 3_600_000;
  return now + delay;
}

export function entryAadParams(entry: VaultEntryMetadata, keyId: string, owner: VaultOwner) {
  return {
    keyId,
    itemRef: entry.itemRef,
    ownerKind: owner.kind,
    ownerId: owner.id,
    originScheme: entry.originScheme,
    originHost: entry.originHost,
    originPort: entry.originPort,
    revision: entry.revision,
  };
}

export function encryptEntry(
  key: Buffer,
  aadParams: ReturnType<typeof entryAadParams>,
  password: string,
  notes: string,
): VaultEncryptedEntry {
  const passwordBytes = Buffer.from(password, "utf8");
  const notesBytes = Buffer.from(notes, "utf8");
  try {
    const passwordEncrypted = encryptField(
      key,
      entryAadForField(aadParams, "password"),
      passwordBytes,
    );
    const notesEncrypted = encryptField(key, entryAadForField(aadParams, "notes"), notesBytes);
    return {
      secretNonce: passwordEncrypted.nonce,
      secretCiphertext: passwordEncrypted.ciphertext,
      notesNonce: notesEncrypted.nonce,
      notesCiphertext: notesEncrypted.ciphertext,
    };
  } finally {
    passwordBytes.fill(0);
    notesBytes.fill(0);
  }
}

export function decryptEntryFields(
  dek: Buffer,
  owner: VaultOwner,
  entry: VaultEntryMetadata,
  secret: {
    secretNonce: Buffer;
    secretCiphertext: Buffer;
    notesNonce: Buffer;
    notesCiphertext: Buffer;
  },
  keyId: string,
): { password: string; notes: string } {
  const key = entryKey(dek, entry.itemRef);
  const aadParams = entryAadParams(entry, keyId, owner);
  try {
    const password = decryptField(
      key,
      entryAadForField(aadParams, "password"),
      secret.secretNonce,
      secret.secretCiphertext,
    );
    const notes = decryptField(
      key,
      entryAadForField(aadParams, "notes"),
      secret.notesNonce,
      secret.notesCiphertext,
    );
    try {
      return { password: password.toString("utf8"), notes: notes.toString("utf8") };
    } finally {
      password.fill(0);
      notes.fill(0);
    }
  } catch (error) {
    if (error instanceof VaultError) {
      throw error;
    }
    throw new VaultError(
      "VAULT_CORRUPTED",
      "This entry could not be decrypted. The entry or its origin metadata may be corrupted.",
    );
  } finally {
    key.fill(0);
  }
}
