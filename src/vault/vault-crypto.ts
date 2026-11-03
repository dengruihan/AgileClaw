import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export const VAULT_AAD_VERSION = 1 as const;
export const VAULT_KDF_N = 32768;
export const VAULT_KDF_R = 8;
export const VAULT_KDF_P = 1;
export const VAULT_KDF_MAXMEM = 64 * 1024 * 1024;
export const VAULT_DEK_BYTES = 32;
export const VAULT_SALT_BYTES = 16;
export const VAULT_NONCE_BYTES = 12;
export const VAULT_TAG_BYTES = 16;
export const VAULT_KEY_CHECK = "openclaw-vault key check v1";
const ENTRY_KEY_INFO = "openclaw-vault v1 entry";
const WRAP_AAD_PREFIX = "openclaw-vault-key-wrap-v1";
const ENTRY_AAD_PREFIX = "openclaw-vault-entry-v1";

export type VaultWrapParams = {
  N: typeof VAULT_KDF_N;
  r: typeof VAULT_KDF_R;
  p: typeof VAULT_KDF_P;
};

export const VAULT_SCRYPT_PARAMS: VaultWrapParams = {
  N: VAULT_KDF_N,
  r: VAULT_KDF_R,
  p: VAULT_KDF_P,
};

export type VaultEntryAad = {
  keyId: string;
  itemRef: string;
  field: "password" | "notes";
  ownerKind: string;
  ownerId: string;
  originScheme: string;
  originHost: string;
  originPort: number;
  revision: number;
};

export type VaultEncryptedField = {
  nonce: Buffer;
  ciphertext: Buffer;
};

export function newVaultKeyId(): string {
  return `vk_${randomUUID()}`;
}

export function newVaultItemRef(): string {
  return `vault_${randomUUID()}`;
}

export function deriveKek(
  passphrase: string,
  salt: Buffer,
  params: VaultWrapParams = VAULT_SCRYPT_PARAMS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      VAULT_DEK_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: VAULT_KDF_MAXMEM },
      (error, derived) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derived);
      },
    );
  });
}

export function keyCheckForKek(kek: Buffer): Buffer {
  return createHmac("sha256", kek).update(VAULT_KEY_CHECK).digest();
}

export function constantTimeKeyCheckMatches(expected: Buffer, kek: Buffer): boolean {
  if (expected.length !== VAULT_DEK_BYTES) {
    return false;
  }
  return timingSafeEqual(expected, keyCheckForKek(kek));
}

function wrapAad(keyId: string, ownerKind: string, ownerId: string): Buffer {
  return Buffer.from([WRAP_AAD_PREFIX, keyId, ownerKind, ownerId].join("\u0000"), "utf8");
}

export function encryptField(dek: Buffer, aad: Buffer, plaintext: Buffer): VaultEncryptedField {
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function decryptField(dek: Buffer, aad: Buffer, nonce: Buffer, ciphertext: Buffer): Buffer {
  if (nonce.length !== VAULT_NONCE_BYTES || ciphertext.length < VAULT_TAG_BYTES) {
    throw new Error("invalid vault ciphertext framing");
  }
  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.subarray(-VAULT_TAG_BYTES));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, -VAULT_TAG_BYTES)),
    decipher.final(),
  ]);
}

export function entryKey(dek: Buffer, itemRef: string): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.from(itemRef, "utf8"), ENTRY_KEY_INFO, 32));
}

export function entryAadBytes(params: VaultEntryAad): Buffer {
  return Buffer.from(
    [
      ENTRY_AAD_PREFIX,
      params.keyId,
      params.itemRef,
      params.field,
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

export function entryAadForField(
  params: Omit<VaultEntryAad, "field">,
  field: VaultEntryAad["field"],
): Buffer {
  return entryAadBytes({ ...params, field });
}

export type WrappedDek = {
  keyId: string;
  salt: Buffer;
  params: VaultWrapParams;
  nonce: Buffer;
  wrappedDek: Buffer;
  keyCheck: Buffer;
};

export function wrapDek(params: {
  keyId: string;
  ownerKind: string;
  ownerId: string;
  dek: Buffer;
  kek: Buffer;
}): Omit<WrappedDek, "salt" | "params" | "keyId"> {
  const nonce = randomBytes(VAULT_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", params.kek, nonce);
  cipher.setAAD(wrapAad(params.keyId, params.ownerKind, params.ownerId));
  const body = Buffer.concat([cipher.update(params.dek), cipher.final()]);
  return {
    nonce,
    wrappedDek: Buffer.concat([body, cipher.getAuthTag()]),
    keyCheck: keyCheckForKek(params.kek),
  };
}

export function unwrapDek(params: {
  keyId: string;
  ownerKind: string;
  ownerId: string;
  kek: Buffer;
  nonce: Buffer;
  wrappedDek: Buffer;
}): Buffer {
  if (params.nonce.length !== VAULT_NONCE_BYTES || params.wrappedDek.length < VAULT_TAG_BYTES) {
    throw new Error("invalid vault key-wrap framing");
  }
  const decipher = createDecipheriv("aes-256-gcm", params.kek, params.nonce);
  decipher.setAAD(wrapAad(params.keyId, params.ownerKind, params.ownerId));
  decipher.setAuthTag(params.wrappedDek.subarray(-VAULT_TAG_BYTES));
  const dek = Buffer.concat([
    decipher.update(params.wrappedDek.subarray(0, -VAULT_TAG_BYTES)),
    decipher.final(),
  ]);
  if (dek.length !== VAULT_DEK_BYTES) {
    dek.fill(0);
    throw new Error("invalid vault data encryption key length");
  }
  return dek;
}

export function generatePassword(options?: { length?: number; includeSymbols?: boolean }): string {
  const length = Math.min(128, Math.max(12, Math.trunc(options?.length ?? 20)));
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+[]{}";
  const alphabet = lower + upper + digits + (options?.includeSymbols === false ? "" : symbols);
  const required = [lower, upper, digits];
  if (options?.includeSymbols !== false) {
    required.push(symbols);
  }
  const chars: string[] = required.map((set) => set.charAt(randomInt(set.length)));
  while (chars.length < length) {
    chars.push(alphabet.charAt(randomInt(alphabet.length)));
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const current = chars[index] ?? "";
    chars[index] = chars[swap] ?? "";
    chars[swap] = current;
  }
  return chars.join("");
}
