import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createThemeDefinitionFixture } from "../../test/helpers/theme-fixture.js";
import { loadManifestThemeDefinitions } from "./manifest-theme-definitions.js";
import { normalizeManifestThemes } from "./manifest-themes.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PLUGIN_ACTIVITY_ICON_MAX_BYTES } from "./portable-icon-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const definition = createThemeDefinitionFixture({ avatarHat: "beret" });
const declaration: PluginManifestTheme = {
  id: "redhat",
  name: definition.name,
  description: definition.description,
  source: "theme.json",
  hats: { beret: "beret.svg" },
};

function fixture() {
  const rootDir = tempDirs.make("openclaw-theme-artwork-");
  fs.writeFileSync(path.join(rootDir, "theme.json"), JSON.stringify(definition));
  fs.writeFileSync(path.join(rootDir, "beret.svg"), SVG);
  const capture = (rejectHardlinks = true) => {
    const diagnostics: PluginDiagnostic[] = [];
    const themes = withPluginCache(createPluginCache(), () =>
      loadManifestThemeDefinitions({
        pluginId: "theme-pack",
        rootDir,
        themes: [declaration],
        rejectHardlinks,
        diagnostics,
      }),
    );
    return { themes, diagnostics };
  };
  return { rootDir, capture };
}

describe("manifest theme artwork", () => {
  it("normalizes package-relative hat paths", () => {
    expect(
      normalizeManifestThemes(
        [{ ...declaration, hats: { beret: "./assets/beret.svg" } }],
        "theme-pack",
      ),
    ).toEqual({
      ok: true,
      themes: [{ ...declaration, hats: { beret: "assets/beret.svg" } }],
    });
  });

  it.each([
    { hats: [] },
    { hats: { Beret: "beret.svg" } },
    { hats: { fedora: "beret.svg" } },
    { hats: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`hat-${i}`, "beret.svg"])) },
  ])("rejects invalid hat declarations: %j", (artwork) => {
    expect(normalizeManifestThemes([{ ...declaration, ...artwork }], "theme-pack")).toMatchObject({
      ok: false,
    });
  });

  it.each([
    '"hats":{"beret":"beret.svg","b\\u0065ret":"other.svg"}',
    "hats: {beret: 'beret.svg', beret: 'other.svg'}",
  ])("rejects duplicate artwork keys before JSON parsing can hide them: %s", (artwork) => {
    const rootDir = tempDirs.make("openclaw-theme-duplicate-");
    const base = JSON.stringify({ ...declaration, hats: undefined }).slice(0, -1);
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      `{"id":"theme-pack","configSchema":{},"themes":[${base},${artwork}}]}`,
    );
    expect(withPluginCache(createPluginCache(), () => loadPluginManifest(rootDir))).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicate artwork ID"),
    });
  });

  it("loads legacy pet declarations without reading retired artwork or losing the palette and hat", () => {
    const plugin = fixture();
    fs.writeFileSync(
      path.join(plugin.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "theme-pack",
        configSchema: {},
        themes: [{ ...declaration, critters: { ferris: { source: "missing.svg" } } }],
      }),
    );
    fs.writeFileSync(
      path.join(plugin.rootDir, "theme.json"),
      JSON.stringify({ ...definition, critters: ["ferris"] }),
    );
    withPluginCache(createPluginCache(), () => {
      const loaded = loadPluginManifest(plugin.rootDir);
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      expect(loaded.manifest.themes).toEqual([declaration]);
      const diagnostics: PluginDiagnostic[] = [];
      expect(
        loadManifestThemeDefinitions({
          pluginId: "theme-pack",
          rootDir: plugin.rootDir,
          themes: loaded.manifest.themes,
          rejectHardlinks: true,
          diagnostics,
        }),
      ).toEqual([{ id: "redhat", definition, artwork: { hats: { beret: { svg: SVG } } } }]);
      expect(diagnostics).toEqual([]);
    });
  });

  it("retains captured bytes after disk changes and captures replacements in the next generation", () => {
    const plugin = fixture();
    const before = plugin.capture();
    expect(before.diagnostics).toEqual([]);
    expect(before.themes?.[0]).toEqual({
      id: "redhat",
      definition,
      artwork: { hats: { beret: { svg: SVG } } },
    });
    const changedSvg = SVG.replace("24v24", "12v12");
    fs.writeFileSync(path.join(plugin.rootDir, "beret.svg"), changedSvg);
    const after = plugin.capture();
    expect(before.themes?.[0]?.artwork?.hats?.beret?.svg).toBe(SVG);
    expect(after.themes?.[0]?.artwork?.hats?.beret?.svg).toBe(changedSvg);
  });

  it.each([
    "not an SVG",
    '<svg><script>alert("no")</script></svg>',
    '<svg><image href="https://example.invalid/pixel"/></svg>',
    `${SVG}${" ".repeat(PLUGIN_ACTIVITY_ICON_MAX_BYTES)}`,
    null,
  ])("omits the whole theme with a warning when declared artwork is invalid: %j", (svg) => {
    const plugin = fixture();
    const file = path.join(plugin.rootDir, "beret.svg");
    if (svg === null) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, svg);
    }
    const captured = plugin.capture();
    expect(captured.themes).toEqual([]);
    expect(captured.diagnostics).toEqual([
      expect.objectContaining({
        level: "warn",
        pluginId: "theme-pack",
        message: expect.stringContaining("artwork beret.svg"),
      }),
    ]);
  });
});
