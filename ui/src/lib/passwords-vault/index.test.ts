import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { passwordsVaultErrorHint, toPasswordsVaultError } from "./index.ts";

const KNOWN_VAULT_ERROR_CODES = [
  "VAULT_WRONG_PASSPHRASE",
  "VAULT_LOCKED_OUT",
  "VAULT_CORRUPTED",
  "VAULT_CONFLICT",
  "VAULT_DUPLICATE",
  "VAULT_REVEAL_SCOPE_REQUIRED",
  "VAULT_LOCKED",
  "VAULT_UNINITIALIZED",
  "VAULT_ALREADY_INITIALIZED",
  "VAULT_NOT_FOUND",
  "VAULT_DELETED",
  "VAULT_INVALID_INPUT",
  "VAULT_UNAVAILABLE",
] as const;

function hintFor(vaultCode: string, extra: { lockedUntilMs?: number } = {}): string | null {
  return passwordsVaultErrorHint({ message: "raw gateway message", vaultCode, ...extra });
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  await i18n.setLocale("en");
});

afterEach(async () => {
  await i18n.setLocale("en");
  vi.unstubAllGlobals();
});

describe("password vault error hints", () => {
  it.each(KNOWN_VAULT_ERROR_CODES)("localizes the known %s code in zh-CN", async (vaultCode) => {
    const english = hintFor(vaultCode);
    await i18n.setLocale("zh-CN");
    const chinese = hintFor(vaultCode);

    expect(english).not.toBeNull();
    expect(chinese).toMatch(/\p{Script=Han}/u);
    expect(chinese).not.toMatch(/VAULT_/u);
    expect(chinese).not.toBe(english);
  });

  it("includes the retry time when a lockout reports one", async () => {
    await i18n.setLocale("zh-CN");
    const withoutTime = hintFor("VAULT_LOCKED_OUT");
    const withTime = hintFor("VAULT_LOCKED_OUT", { lockedUntilMs: 1_786_353_000_000 });

    expect(withTime).toMatch(/\p{Script=Han}/u);
    expect(withTime).not.toBe(withoutTime);
  });

  it("returns no hint for unknown or missing codes so the diagnostic survives", () => {
    expect(hintFor("VAULT_FILL_AGENT_REQUIRED")).toBeNull();
    expect(passwordsVaultErrorHint({ message: "raw gateway message" })).toBeNull();
  });
});

describe("password vault request failure fallback", () => {
  it("uses the English catalog string when a failure carries no message", () => {
    expect(toPasswordsVaultError("").message).toBe("The password vault request failed.");
  });

  it("localizes that fallback for zh-CN", async () => {
    await i18n.setLocale("zh-CN");

    expect(toPasswordsVaultError("").message).toBe("密码库请求失败。");
  });
});
