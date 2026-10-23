import { createHash } from "node:crypto";
import type { ThemeArtwork, ThemeCatalogEntry } from "../../packages/gateway-protocol/src/theme.js";
import { buildControlUiResourcePath } from "../gateway/control-ui-resource-routes.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

const catalogByPlugin = new WeakMap<PluginManifestRecord, ThemeCatalogEntry[]>();

function currentSnapshot() {
  // Appearance follows the live Gateway even when an agent retains an older runtime scope.
  return getProcessGatewayPluginMetadataSnapshot() ?? getCurrentPluginMetadataSnapshot();
}

function pluginThemes(plugin: PluginManifestRecord): ThemeCatalogEntry[] {
  const cached = catalogByPlugin.get(plugin);
  if (cached) {
    return cached;
  }
  const themes: ThemeCatalogEntry[] = [];
  for (const { id, definition, artwork } of plugin.themeDefinitions ?? []) {
    const resourceUrl = (artId: string, svg: string) => {
      const hash = createHash("sha256").update(svg).digest("hex").slice(0, 12);
      return `${buildControlUiResourcePath("pluginThemeArt", "", plugin.id, [id, "hat", artId])}?v=${hash}`;
    };
    const hats = artwork?.hats
      ? Object.fromEntries(
          Object.entries(artwork.hats).map(([artId, art]) => [
            artId,
            { url: resourceUrl(artId, art.svg) },
          ]),
        )
      : undefined;
    const projected: ThemeArtwork | undefined = hats ? { hats } : undefined;
    themes.push({
      id: `${plugin.id}/${id}`,
      name: definition.name,
      description: definition.description,
      ...(definition.mascot !== undefined ? { mascot: definition.mascot } : {}),
      ...(definition.workingPhrases !== undefined
        ? { workingPhrases: definition.workingPhrases }
        : {}),
      ...(definition.avatarHat !== undefined ? { avatarHat: definition.avatarHat } : {}),
      ...(projected ? { artwork: projected } : {}),
      source: "plugin",
      pluginId: plugin.id,
      modes: (["light", "dark"] as const).filter((mode) => Boolean(definition[mode])),
      definition,
    });
  }
  catalogByPlugin.set(plugin, themes);
  return themes;
}

/** Returns captured bytes from the enabled owner's current published generation. */
export function resolvePluginThemeArtwork(
  pluginId: string,
  themeId: string,
  artId: string,
): string | undefined {
  const snapshot = currentSnapshot();
  if (!snapshot?.index.plugins.some((plugin) => plugin.pluginId === pluginId && plugin.enabled)) {
    return undefined;
  }
  const theme = snapshot.plugins
    .find((plugin) => plugin.id === pluginId)
    ?.themeDefinitions?.find((entry) => entry.id === themeId);
  const artwork = theme?.artwork?.hats;
  return artwork && Object.hasOwn(artwork, artId) ? artwork[artId]?.svg : undefined;
}

/** Reads the published inventory only; explicit plugin lifecycle operations replace its palettes. */
export function listPluginThemes(): ThemeCatalogEntry[] {
  const snapshot = currentSnapshot();
  if (!snapshot) {
    return [];
  }
  const enabled = new Set(
    snapshot.index.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.pluginId),
  );
  return snapshot.plugins
    .flatMap((plugin) => (enabled.has(plugin.id) ? pluginThemes(plugin) : []))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
