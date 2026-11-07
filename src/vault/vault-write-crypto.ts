import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { VAULT_NONCE_BYTES } from "./vault-crypto.js";

/**
 * Agent write-only tier for the personal password vault.
 *
 * The X25519 write keypair lets the vault worker seal agent-supplied passwords
 * and notes while the vault is locked: sealing needs only the public key, which
 * is not secret. Opening requires the private key, which exists on disk only
 * wrapped under the passphrase-protected DEK, so decryption stays impossible
 * while locked. Sealed rows migrate into the per-entry DEK format at the next
 * unlock and the sealed copy is deleted.
 */

const WRITE_KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;
const WRITE_WRAP_INFO = "openclaw-vault-write-key-wrap-v1";
const WRITE_WRAP_AAD_PREFIX = "openclaw-vault-write-key-wrap-v1";
const WRITE_SEAL_INFO = "openclaw-vault-write-seal-v1";
const WRITE_SEAL_AAD_PREFIX = "openclaw-vault-write-entry-v1";

export type VaultWriteAadParams = {
  writeKeyId: string;
  itemRef: string;
  ownerKind: string;
  ownerId: string;
  originScheme: string;
  originHost: string;
  originPort: number;
  revision: number;
};

export type SealedVaultEntrySecrets = {
  ephemeralPublicKey: Buffer;
  secretNonce: Buffer;
  secretCiphertext: Buffer;
  notesNonce: Buffer;
  notesCiphertext: Buffer;
};

export function newVaultWriteKeyId(): string {
  return `vw_${randomUUID()}`;
}

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

function rawPublicKeyObject(raw: Buffer): KeyObject {
  if (raw.length !== WRITE_KEY_BYTES) {
    throw new Error("invalid vault write public key length");
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64url(raw) },
    format: "jwk",
  });
}

function rawPrivateKeyObject(publicKey: Buffer, privateKey: Buffer): KeyObject {
  if (privateKey.length !== WRITE_KEY_BYTES) {
    throw new Error("invalid vault write private key length");
  }
  return createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: b64url(publicKey), d: b64url(privateKey) },
    format: "jwk",
  });
}

function keyObjectRaw(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") {
    throw new Error("vault write key export failed");
  }
  return Buffer.from(jwk.x, "base64url");
}

export function generateVaultWriteKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicRaw = keyObjectRaw(publicKey);
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  if (typeof jwk.d !== "string") {
    throw new Error("vault write key export failed");
  }
  return { publicKey: publicRaw, privateKey: Buffer.from(jwk.d, "base64url") };
}

function writeWrapAad(params: {
  writeKeyId: string;
  ownerKind: string;
  ownerId: string;
  keyId: string;
}): Buffer {
  return Buffer.from(
    [WRITE_WRAP_AAD_PREFIX, params.writeKeyId, params.ownerKind, params.ownerId, params.keyId].join(
      "\u0000",
    ),
    "utf8",
  );
}

function writeSealAad(params: VaultWriteAadParams, field: "password" | "notes"): Buffer {
  return Buffer.from(
    [
      WRITE_SEAL_AAD_PREFIX,
      params.writeKeyId,
      params.itemRef,
      field,
      params.ownerKind,
      params.ownerId,
      params.originScheme,
      params.originHost,
      String(params.originPort),
      String(params.revision),
    ].join("\u0000"),
    "utf8",
  );
}

function deriveWrapKey(dek: Buffer, writeKeyId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      dek,
      Buffer.from(writeKeyId, "utf8"),
      Buffer.from(WRITE_WRAP_INFO, "utf8"),
      32,
    ),
  );
}

/**
 * Wrap one X25519 write private key under the vault DEK. Only an unlocked
 * worker holds the DEK, so the wrapped form cannot be opened while locked.
 */
export function wrapVaultWritePrivateKey(params: {
  dek: Buffer;
  writeKeyId: string;
  ownerKind: string;
  ownerId: string;
  keyId: string;
  privateKey: Buffer;
}): { nonce: Buffer; wrappedPrivateKey: Buffer } {
  const wrapKey = deriveWrapKey(params.dek, params.writeKeyId);
  try {
    const nonce = randomBytes(VAULT_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
    cipher.setAAD(writeWrapAad(params));
    const body = Buffer.concat([cipher.update(params.privateKey), cipher.final()]);
    return { nonce, wrappedPrivateKey: Buffer.concat([body, cipher.getAuthTag()]) };
  } finally {
    wrapKey.fill(0);
  }
}

export function unwrapVaultWritePrivateKey(params: {
  dek: Buffer;
  writeKeyId: string;
  ownerKind: string;
  ownerId: string;
  keyId: string;
  nonce: Buffer;
  wrappedPrivateKey: Buffer;
}): Buffer {
  if (
    params.nonce.length !== VAULT_NONCE_BYTES ||
    params.wrappedPrivateKey.length < GCM_TAG_BYTES
  ) {
    throw new Error("invalid vault write key wrap framing");
  }
  const wrapKey = deriveWrapKey(params.dek, params.writeKeyId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrapKey, params.nonce);
    decipher.setAAD(writeWrapAad(params));
    decipher.setAuthTag(params.wrappedPrivateKey.subarray(-GCM_TAG_BYTES));
    const privateKey = Buffer.concat([
      decipher.update(params.wrappedPrivateKey.subarray(0, -GCM_TAG_BYTES)),
      decipher.final(),
    ]);
    if (privateKey.length !== WRITE_KEY_BYTES) {
      privateKey.fill(0);
      throw new Error("invalid vault write private key length");
    }
    return privateKey;
  } finally {
    wrapKey.fill(0);
  }
}

function encryptSealedField(
  sealKey: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealKey, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

function decryptSealedField(
  sealKey: Buffer,
  aad: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
): Buffer {
  if (nonce.length !== VAULT_NONCE_BYTES || ciphertext.length < GCM_TAG_BYTES) {
    throw new Error("invalid vault write ciphertext framing");
  }
  const decipher = createDecipheriv("aes-256-gcm", sealKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.subarray(-GCM_TAG_BYTES));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -GCM_TAG_BYTES)), decipher.final()]);
}

/**
 * Seal the two secret fields for one entry to the write public key. The
 * ephemeral keypair is fresh per call; both fields share it with field-bound
 * AAD so moving ciphertext between fields or entries fails authentication.
 */
export function sealVaultEntryForWrite(params: {
  writePublicKey: Buffer;
  writeKeyId: string;
  aad: VaultWriteAadParams;
  password: string;
  notes: string;
}): SealedVaultEntrySecrets {
  const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } =
    generateKeyPairSync("x25519");
  const ephemeralRaw = keyObjectRaw(ephemeralPublic);
  const writePublic = rawPublicKeyObject(params.writePublicKey);
  const shared = diffieHellman({ privateKey: ephemeralPrivate, publicKey: writePublic });
  const sealKey = Buffer.from(
    hkdfSync("sha256", shared, ephemeralRaw, Buffer.from(WRITE_SEAL_INFO, "utf8"), 32),
  );
  shared.fill(0);
  try {
    const passwordBytes = Buffer.from(params.password, "utf8");
    const notesBytes = Buffer.from(params.notes, "utf8");
    try {
      const passwordEncrypted = encryptSealedField(
        sealKey,
        writeSealAad(params.aad, "password"),
        passwordBytes,
      );
      const notesEncrypted = encryptSealedField(
        sealKey,
        writeSealAad(params.aad, "notes"),
        notesBytes,
      );
      return {
        ephemeralPublicKey: ephemeralRaw,
        secretNonce: passwordEncrypted.nonce,
        secretCiphertext: passwordEncrypted.ciphertext,
        notesNonce: notesEncrypted.nonce,
        notesCiphertext: notesEncrypted.ciphertext,
      };
    } finally {
      passwordBytes.fill(0);
      notesBytes.fill(0);
    }
  } finally {
    sealKey.fill(0);
  }
}

/**
 * Open one entry's sealed fields with the unwrapped write private key. AAD
 * mismatch — another entry, origin, revision, or write key — fails closed.
 */
export function openVaultEntryWriteSeal(params: {
  writePrivateKey: Buffer;
  writePublicKey: Buffer;
  writeKeyId: string;
  aad: VaultWriteAadParams;
  sealed: SealedVaultEntrySecrets;
}): { password: string; notes: string } {
  const privateObject = rawPrivateKeyObject(params.writePublicKey, params.writePrivateKey);
  const ephemeralPublic = rawPublicKeyObject(params.sealed.ephemeralPublicKey);
  const shared = diffieHellman({ privateKey: privateObject, publicKey: ephemeralPublic });
  const sealKey = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      params.sealed.ephemeralPublicKey,
      Buffer.from(WRITE_SEAL_INFO, "utf8"),
      32,
    ),
  );
  shared.fill(0);
  try {
    const password = decryptSealedField(
      sealKey,
      writeSealAad(params.aad, "password"),
      params.sealed.secretNonce,
      params.sealed.secretCiphertext,
    );
    const notes = decryptSealedField(
      sealKey,
      writeSealAad(params.aad, "notes"),
      params.sealed.notesNonce,
      params.sealed.notesCiphertext,
    );
    try {
      return { password: password.toString("utf8"), notes: notes.toString("utf8") };
    } finally {
      password.fill(0);
      notes.fill(0);
    }
  } finally {
    sealKey.fill(0);
  }
}
