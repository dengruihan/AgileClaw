import { describe, expect, it } from "vitest";
import {
  buildControlUiRootAssetPath,
  CONTROL_UI_ROOT_PUBLIC_ASSETS,
  isControlUiRootPublicAsset,
  isControlUiVersionedPublicAsset,
} from "./control-ui-root-assets.js";

describe("Control UI root assets", () => {
  it("builds root asset paths under the configured mount", () => {
    expect(buildControlUiRootAssetPath(null, "favicon.svg")).toBe("/favicon.svg");
    expect(buildControlUiRootAssetPath("/apps/openclaw/", "sw.js")).toBe("/apps/openclaw/sw.js");
  });

  it("recognizes only the emitted root files", () => {
    for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
      expect(isControlUiRootPublicAsset(asset)).toBe(true);
    }
    expect(isControlUiRootPublicAsset("app-art/ios.webp")).toBe(false);
  });

  it("versions documented public inputs and the root files except the service worker", () => {
    for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
      expect(isControlUiVersionedPublicAsset(asset)).toBe(asset !== "sw.js");
    }
    for (const asset of [
      "fonts/lora.css",
      "fonts/lora.woff2",
      "themes/dark.css",
      "provider-icons/ProviderIcon-pi.svg",
      "cloud-provider-icons/aws.svg",
      "file-icons/compact/dark/pdf.svg",
    ]) {
      expect(isControlUiVersionedPublicAsset(asset)).toBe(true);
    }
  });

  it("rejects retired art families and arbitrary public files", () => {
    for (const asset of [
      "app-art/ios.webp",
      "app-art/ios-dark.webp",
      "community-art/example.webp",
      "themes/dark.svg",
      "provider-icons/ProviderIcon-pi.webp",
      "promo/hero.webp",
      "sw.js",
      "index.html",
    ]) {
      expect(isControlUiVersionedPublicAsset(asset)).toBe(false);
    }
  });
});
