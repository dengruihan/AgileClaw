/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { MARKETPLACE_PRESET_IDS } from "./marketplace-presets.ts";
import {
  loadInstalledMarketplacePresets,
  marketplacePresetsStorageKey,
  saveInstalledMarketplacePresets,
} from "./marketplace-presets.ts";

const gatewayUrl = "ws://gateway.example.test/socket";

describe("dashboard marketplace presets", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("installs nothing when this browser stored no choice", () => {
    expect(loadInstalledMarketplacePresets(gatewayUrl)).toEqual([]);
  });

  it("restores a saved install in catalog order without duplicates", () => {
    expect(saveInstalledMarketplacePresets(gatewayUrl, ["system-monitoring"])).toBe(true);
    expect(loadInstalledMarketplacePresets(gatewayUrl)).toEqual(MARKETPLACE_PRESET_IDS);

    saveInstalledMarketplacePresets(gatewayUrl, ["system-monitoring", "system-monitoring"]);
    expect(loadInstalledMarketplacePresets(gatewayUrl)).toEqual(MARKETPLACE_PRESET_IDS);
  });

  it("treats unusable stored data as not installed", () => {
    localStorage.setItem(marketplacePresetsStorageKey(gatewayUrl), "{not json");
    expect(loadInstalledMarketplacePresets(gatewayUrl)).toEqual([]);
    localStorage.setItem(
      marketplacePresetsStorageKey(gatewayUrl),
      JSON.stringify(["unknown-preset"]),
    );
    expect(loadInstalledMarketplacePresets(gatewayUrl)).toEqual([]);
  });

  it("scopes the install to one Gateway origin", () => {
    saveInstalledMarketplacePresets(gatewayUrl, ["system-monitoring"]);
    expect(loadInstalledMarketplacePresets("ws://other.example.test")).toEqual([]);
  });

  it("stays not installed when no Gateway URL is known", () => {
    expect(loadInstalledMarketplacePresets("")).toEqual([]);
    expect(saveInstalledMarketplacePresets("", ["system-monitoring"])).toBe(false);
  });
});
