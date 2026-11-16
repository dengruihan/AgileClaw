/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

describe("Device settings English loading", () => {
  it("loads complete fallback copy before device settings can render", async () => {
    const { manager } = await loadI18n();
    expect(manager.t("tabs.apps")).toBe("Plugin apps");
    expect(manager.t("configPage.deviceSettings.chromeExtension")).toBe(
      "configPage.deviceSettings.chromeExtension",
    );

    await manager.setLocale("de");
    await import("../pages/device/device-page.ts");
    const { registerSettingsEnglish } = await import("./locales/en-settings.ts");
    for (const [key, value] of flattenTranslations(registerSettingsEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("configPage.deviceSettings.chromeExtensionSetup")).toBe(
      "Set up Chrome on this device",
    );
  });
});
