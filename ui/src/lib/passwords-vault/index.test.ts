import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { toPasswordsVaultError } from "./index.ts";

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  await i18n.setLocale("en");
});

afterEach(async () => {
  await i18n.setLocale("en");
  vi.unstubAllGlobals();
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
