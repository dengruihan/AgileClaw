import { describe, expect, it } from "vitest";
import {
  validateVaultCreateParams,
  validateVaultRevealResult,
  validateVaultSaveLoginParams,
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
    const { notes: _notes, ...withoutNotes } = base;
    expect(validateVaultUpdateParams({ ...withoutNotes, revision: 2 })).toBe(true);
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

  it("accepts an agent save with only an origin and blank optional fields", () => {
    expect(
      validateVaultSaveLoginParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
      }),
    ).toBe(true);
    expect(
      validateVaultSaveLoginParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        account: "",
        password: "",
        notes: "",
        label: "",
      }),
    ).toBe(true);
    expect(
      validateVaultSaveLoginParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        extra: true,
      }),
    ).toBe(false);
    expect(
      validateVaultSaveLoginParams({
        originScheme: "ftp",
        originHost: "example.com",
        originPort: 443,
      }),
    ).toBe(false);
    expect(
      validateVaultSaveLoginParams({
        originScheme: "https",
        originPort: 443,
      }),
    ).toBe(false);
  });

  it("keeps an empty account and empty revealed password valid payloads", () => {
    expect(
      validateVaultCreateParams({
        originScheme: "https",
        originHost: "example.com",
        originPort: 443,
        siteLabel: "example.com",
        account: "",
        password: "synthetic-password",
      }),
    ).toBe(true);
    expect(
      validateVaultRevealResult({
        entry: {
          itemRef: "vault_11111111-1111-4111-8111-111111111111",
          originScheme: "https",
          originHost: "example.com",
          originPort: 443,
          siteLabel: "example.com",
          account: "",
          hasNotes: false,
          revision: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        password: "",
        notes: "",
      }),
    ).toBe(true);
  });
});
