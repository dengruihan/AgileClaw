import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateVaultWriteKeyPair,
  newVaultWriteKeyId,
  openVaultEntryWriteSeal,
  sealVaultEntryForWrite,
  unwrapVaultWritePrivateKey,
  wrapVaultWritePrivateKey,
  type VaultWriteAadParams,
} from "./vault-write-crypto.js";

const OWNER = { ownerKind: "profile", ownerId: "local" };

function aad(overrides: Partial<VaultWriteAadParams> = {}): VaultWriteAadParams {
  return {
    writeKeyId: "vw_key-1",
    itemRef: "vault_item-1",
    originScheme: "https",
    originHost: "example.com",
    originPort: 443,
    revision: 1,
    ...OWNER,
    ...overrides,
  };
}

describe("vault write-only crypto", () => {
  it("round-trips a sealed entry through the wrapped private key", () => {
    const dek = randomBytes(32);
    const writeKeyId = newVaultWriteKeyId();
    const keyId = "vk_key-1";
    const pair = generateVaultWriteKeyPair();
    try {
      const wrapped = wrapVaultWritePrivateKey({
        dek,
        writeKeyId,
        keyId,
        privateKey: pair.privateKey,
        ...OWNER,
      });
      const unwrapped = unwrapVaultWritePrivateKey({
        dek,
        writeKeyId,
        keyId,
        nonce: wrapped.nonce,
        wrappedPrivateKey: wrapped.wrappedPrivateKey,
        ...OWNER,
      });
      try {
        const sealed = sealVaultEntryForWrite({
          writePublicKey: pair.publicKey,
          writeKeyId,
          aad: aad({ writeKeyId }),
          password: "synthetic-password",
          notes: "synthetic-notes",
        });
        const opened = openVaultEntryWriteSeal({
          writePrivateKey: unwrapped,
          writePublicKey: pair.publicKey,
          writeKeyId,
          aad: aad({ writeKeyId }),
          sealed,
        });
        expect(opened).toEqual({ password: "synthetic-password", notes: "synthetic-notes" });
      } finally {
        unwrapped.fill(0);
      }
    } finally {
      pair.privateKey.fill(0);
    }
  });

  it("refuses to unwrap under a different DEK, key id, or owner", () => {
    const dek = randomBytes(32);
    const writeKeyId = newVaultWriteKeyId();
    const pair = generateVaultWriteKeyPair();
    try {
      const wrapped = wrapVaultWritePrivateKey({
        dek,
        writeKeyId,
        keyId: "vk_key-1",
        privateKey: pair.privateKey,
        ...OWNER,
      });
      expect(() =>
        unwrapVaultWritePrivateKey({
          dek: randomBytes(32),
          writeKeyId,
          keyId: "vk_key-1",
          nonce: wrapped.nonce,
          wrappedPrivateKey: wrapped.wrappedPrivateKey,
          ...OWNER,
        }),
      ).toThrow();
      expect(() =>
        unwrapVaultWritePrivateKey({
          dek,
          writeKeyId,
          keyId: "vk_key-other",
          nonce: wrapped.nonce,
          wrappedPrivateKey: wrapped.wrappedPrivateKey,
          ...OWNER,
        }),
      ).toThrow();
      expect(() =>
        unwrapVaultWritePrivateKey({
          dek,
          writeKeyId,
          keyId: "vk_key-1",
          nonce: wrapped.nonce,
          wrappedPrivateKey: wrapped.wrappedPrivateKey,
          ownerKind: "profile",
          ownerId: "other-profile",
        }),
      ).toThrow();
    } finally {
      pair.privateKey.fill(0);
    }
  });

  it("fails closed when sealed bytes move to another entry, origin, or write key", () => {
    const writeKeyId = newVaultWriteKeyId();
    const pair = generateVaultWriteKeyPair();
    try {
      const sealed = sealVaultEntryForWrite({
        writePublicKey: pair.publicKey,
        writeKeyId,
        aad: aad({ writeKeyId }),
        password: "synthetic-password",
        notes: "synthetic-notes",
      });
      const attempts: VaultWriteAadParams[] = [
        aad({ writeKeyId, itemRef: "vault_other" }),
        aad({ writeKeyId, originHost: "evil.example.com" }),
        aad({ writeKeyId, revision: 2 }),
        aad({ writeKeyId, ownerId: "other-profile" }),
      ];
      for (const attempt of attempts) {
        expect(() =>
          openVaultEntryWriteSeal({
            writePrivateKey: pair.privateKey,
            writePublicKey: pair.publicKey,
            writeKeyId,
            aad: attempt,
            sealed,
          }),
        ).toThrow();
      }
    } finally {
      pair.privateKey.fill(0);
    }
  });

  it("seals empty password and notes values", () => {
    const writeKeyId = newVaultWriteKeyId();
    const pair = generateVaultWriteKeyPair();
    try {
      const sealed = sealVaultEntryForWrite({
        writePublicKey: pair.publicKey,
        writeKeyId,
        aad: aad({ writeKeyId }),
        password: "",
        notes: "",
      });
      expect(
        openVaultEntryWriteSeal({
          writePrivateKey: pair.privateKey,
          writePublicKey: pair.publicKey,
          writeKeyId,
          aad: aad({ writeKeyId }),
          sealed,
        }),
      ).toEqual({ password: "", notes: "" });
    } finally {
      pair.privateKey.fill(0);
    }
  });
});
