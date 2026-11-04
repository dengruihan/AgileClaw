import { describe, expect, it } from "vitest";
import { STATE_SECRET_TABLE_NAMES } from "../state/secret-state-tables.js";

describe("vault backup policy", () => {
  it("omits every vault table from credential-redacted Git backups", () => {
    expect(STATE_SECRET_TABLE_NAMES).toEqual(
      expect.arrayContaining([
        "vault_entries",
        "vault_entry_secrets",
        "vault_keys",
        "vault_key_wraps",
        "vault_meta",
        "vault_audit_events",
      ]),
    );
  });
});
