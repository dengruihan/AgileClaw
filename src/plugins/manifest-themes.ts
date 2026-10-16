import { createRequire } from "node:module";
import type { Expression, Property } from "acorn";
import {
  isThemeId,
  THEME_LOCAL_ID_PATTERN,
  THEME_NAME_MAX_LENGTH,
  THEME_DESCRIPTION_MAX_LENGTH,
  THEME_ARTWORK_ID_PATTERN,
  THEME_AVATAR_HAT_IDS,
} from "../../packages/gateway-protocol/src/theme.ts";
import type { PluginManifestTheme } from "./manifest-types.js";

const MAX_PLUGIN_THEMES = 32;
const MAX_THEME_ARTWORK_ENTRIES = 8;

function objectProperties(value: Expression): Property[] {
  return value.type === "ObjectExpression"
    ? value.properties.filter((property): property is Property => property.type === "Property")
    : [];
}

function propertyName(property: Property): string {
  return property.key.type === "Identifier"
    ? property.key.name
    : property.key.type === "Literal"
      ? String(property.key.value)
      : "";
}

function validateArtworkDuplicates(source: string): void {
  // JSON/JSON5 parsing already admitted the bytes. Load the AST parser only for artwork manifests.
  // SAFETY: the fixed Acorn dependency supplies the exports described by its own declarations.
  const { parseExpressionAt } = createRequire(import.meta.url)("acorn") as typeof import("acorn");
  const root = parseExpressionAt(`(${source}\n)`, 0, { ecmaVersion: "latest" });
  for (const property of objectProperties(root)) {
    if (propertyName(property) !== "themes" || property.value.type !== "ArrayExpression") {
      continue;
    }
    for (const theme of property.value.elements) {
      if (!theme || theme.type !== "ObjectExpression") {
        continue;
      }
      for (const artwork of objectProperties(theme)) {
        const kind = propertyName(artwork);
        if (kind !== "hats") {
          continue;
        }
        const ids = new Set<string>();
        for (const entry of objectProperties(artwork.value)) {
          const id = propertyName(entry);
          if (ids.has(id)) {
            throw new Error(`themes.${kind} has duplicate artwork ID ${id}`);
          }
          ids.add(id);
        }
      }
    }
  }
}

function normalizeArtworkEntries(
  value: unknown,
  label: string,
  catalogIds: readonly string[],
): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a map with at most ${MAX_THEME_ARTWORK_ENTRIES} entries`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_THEME_ARTWORK_ENTRIES) {
    throw new Error(`${label} must be a map with at most ${MAX_THEME_ARTWORK_ENTRIES} entries`);
  }
  for (const [id] of entries) {
    if (!THEME_ARTWORK_ID_PATTERN.test(id) || catalogIds.includes(id)) {
      throw new Error(`${label}.${id} must use a safe local ID outside the built-in catalog`);
    }
  }
  return entries;
}

function normalizeArtworkPath(value: unknown, label: string): string {
  const relativePath = typeof value === "string" ? value.replace(/^\.\//, "") : "";
  if (!/^(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.svg$/i.test(relativePath)) {
    throw new Error(`${label} must be an SVG file inside the plugin root`);
  }
  return relativePath;
}

function normalizeArtwork(hats: unknown, label: string): Pick<PluginManifestTheme, "hats"> {
  return hats === undefined
    ? {}
    : {
        hats: Object.fromEntries(
          normalizeArtworkEntries(hats, `${label}.hats`, THEME_AVATAR_HAT_IDS).map(
            ([id, source]) => [id, normalizeArtworkPath(source, `${label}.hats.${id}`)],
          ),
        ),
      };
}

export function normalizeManifestThemes(
  value: unknown,
  pluginId: string,
  manifestSource?: string,
): { ok: true; themes?: PluginManifestTheme[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_THEMES) {
    return {
      ok: false,
      error: `themes must be an array with at most ${MAX_PLUGIN_THEMES} entries`,
    };
  }
  if (value.length && (pluginId === "user" || !isThemeId(`${pluginId}/x`))) {
    return {
      ok: false,
      error: "themes require a portable plugin ID outside the reserved user namespace",
    };
  }
  const themes: PluginManifestTheme[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `themes[${index}] must be an object` };
    }
    // SAFETY: entry is a non-null, non-array object; every field is validated below.
    const { id, name, description, source, hats } = entry as Record<string, unknown>;
    if (
      Object.keys(entry).some(
        // Retired pet artwork must not invalidate the plugin's other capabilities.
        (key) => !["id", "name", "description", "source", "hats", "critters"].includes(key),
      ) ||
      typeof id !== "string" ||
      !THEME_LOCAL_ID_PATTERN.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > THEME_NAME_MAX_LENGTH ||
      typeof description !== "string" ||
      !description.trim() ||
      description.trim().length > THEME_DESCRIPTION_MAX_LENGTH ||
      Array.from(name + description).some(
        (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
      ) ||
      typeof source !== "string"
    ) {
      return {
        ok: false,
        error: `themes[${index}] requires a unique safe id, name, description, and JSON source`,
      };
    }
    const relativePath = source.replace(/^\.\//, "");
    if (!/^(?:[a-z0-9_-][a-z0-9._-]*\/)*[a-z0-9_-][a-z0-9._-]*\.json$/i.test(relativePath)) {
      return {
        ok: false,
        error: `themes[${index}].source must be a JSON file inside the plugin root`,
      };
    }
    try {
      themes.push({
        id,
        name: name.trim(),
        description: description.trim(),
        source: relativePath,
        ...normalizeArtwork(hats, `themes[${index}]`),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "invalid theme artwork" };
    }
    ids.add(id);
  }
  if (manifestSource && themes.some((theme) => theme.hats)) {
    try {
      validateArtworkDuplicates(manifestSource);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "invalid theme artwork" };
    }
  }
  return { ok: true, themes };
}
