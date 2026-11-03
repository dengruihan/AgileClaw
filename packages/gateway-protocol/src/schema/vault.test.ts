import { describe, expect, it } from "vitest";
import {
  validateVaultCreateParams,
  validateVaultRevealResult,
  validateVaultStatusResult,
  validateVaultUpdateParams,
} from "../validator-registry.js";

describe("vault protocol schemas", () => {
  it("accepts a complete create payload and rejects unknown fields", () => {
    expect(
      validateVaultCreateParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "person@example.com",
        password: "synthetic-password",
        notes: "note",
      }),
    ).toBe(true);
    expect(
      validateVaultCreateParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "Example",
        account: "person@example.com",
        password: "synthetic-password",
        extra: true,
      }),
    ).toBe(false);
  });

  it("requires the revision on update and leaves the password optional", () => {
    const base = {
      itemRef: "vault_11111111-1111-4111-8111-111111111111",
      originScheme: "https",
      originHost: "example.com",
      originPort: 443,
      siteLabel: "Example",
      account: "person@example.com",
      notes: "",
    };
    expect(validateVaultUpdateParams({ ...base, revision: 2 })).toBe(true);
    expect(validateVaultUpdateParams(base)).toBe(false);
    expect(validateVaultUpdateParams({ ...base, revision: 2, password: "" })).toBe(false);
  });

  it("never treats a missing reveal value or invalid status as a valid payload", () => {
    expect(
      validateVaultRevealResult({
        entry: {
          itemRef: "vault_11111111-1111-4111-8111-111111111111",
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "Example",
          account: "person@example.com",
          hasNotes: false,
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        password: "synthetic-password",
        notes: "",
      }),
    ).toBe(true);
    expect(
      validateVaultRevealResult({
        entry: {},
        password: "",
        notes: "",
      }),
    ).toBe(false);
    expect(
      validateVaultStatusResult({
        initialized: true,
        state: "unlocked",
        autoLockSeconds: 300,
        failedAttempts: 0,
        itemCount: 0,
        deletedCount: 0,
      }),
    ).toBe(true);
    expect(
      validateVaultStatusResult({
        initialized: true,
        state: "unknown",
        autoLockSeconds: 300,
        failedAttempts: 0,
        itemCount: 0,
        deletedCount: 0,
      }),
    ).toBe(false);
  });
});
