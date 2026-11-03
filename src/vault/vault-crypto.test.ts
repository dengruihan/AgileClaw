import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeKeyCheckMatches,
  decryptField,
  deriveKek,
  encryptField,
  entryAadForField,
  entryKey,
  generatePassword,
  keyCheckForKek,
  unwrapDek,
  newVaultItemRef,
  VAULT_DEK_BYTES,
  VAULT_SALT_BYTES,
  wrapDek,
} from "./vault-crypto.js";

const OWNER = { ownerKind: "profile", ownerId: "local" } as const;

describe("vault cryptography", () => {
  it("wraps and unwraps the data key and detects a wrong passphrase", async () => {
    const dek = randomBytes(VAULT_DEK_BYTES);
    const salt = randomBytes(VAULT_SALT_BYTES);
    const kek = await deriveKek("a sufficiently long passphrase", salt);
    const wrapped = wrapDek({ keyId: "vk_test", ...OWNER, dek, kek });
    expect(constantTimeKeyCheckMatches(wrapped.keyCheck, kek)).toBe(true);
    const wrong = await deriveKek("another sufficiently long passphrase", salt);
    expect(constantTimeKeyCheckMatches(wrapped.keyCheck, wrong)).toBe(false);
    const unwrapped = unwrapDek({
      keyId: "vk_test",
      ...OWNER,
      kek,
      nonce: wrapped.nonce,
      wrappedDek: wrapped.wrappedDek,
    });
    expect(unwrapped.equals(dek)).toBe(true);
    expect(keyCheckForKek(kek).length).toBe(32);
    kek.fill(0);
    wrong.fill(0);
    dek.fill(0);
    unwrapped.fill(0);
  });

  it("binds ciphertext to the item, origin, revision, and field through AAD", async () => {
    const dek = randomBytes(VAULT_DEK_BYTES);
    const itemRef = newVaultItemRef();
    const key = entryKey(dek, itemRef);
    const aad = {
      keyId: "vk_test",
      itemRef,
      ownerKind: OWNER.ownerKind,
      ownerId: OWNER.ownerId,
      originScheme: "https",
      originHost: "example.com",
      originPort: 443,
      revision: 1,
    };
    const plaintext = Buffer.from("synthetic-password", "utf8");
    const encrypted = encryptField(key, entryAadForField(aad, "password"), plaintext);

    expect(
      decryptField(
        key,
        entryAadForField(aad, "password"),
        encrypted.nonce,
        encrypted.ciphertext,
      ).toString("utf8"),
    ).toBe("synthetic-password");

    for (const changed of [
      { ...aad, itemRef: newVaultItemRef() },
      { ...aad, originHost: "attacker.example" },
      { ...aad, revision: 2 },
    ]) {
      expect(() =>
        decryptField(
          key,
          entryAadForField(changed, "password"),
          encrypted.nonce,
          encrypted.ciphertext,
        ),
      ).toThrow();
    }
    expect(() =>
      decryptField(key, entryAadForField(aad, "notes"), encrypted.nonce, encrypted.ciphertext),
    ).toThrow();
    plaintext.fill(0);
    key.fill(0);
    dek.fill(0);
  });

  it("generates CSPRNG passwords with the requested length", () => {
    const password = generatePassword({ length: 24, includeSymbols: true });
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/u);
    expect(password).toMatch(/[A-Z]/u);
    expect(password).toMatch(/[0-9]/u);
    expect(generatePassword({ length: 4, includeSymbols: false })).toHaveLength(12);
  });
});
