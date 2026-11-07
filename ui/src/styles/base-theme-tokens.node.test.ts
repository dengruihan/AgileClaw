// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.dirname(stylesDir);
// Every alias name this bug class has produced so far, mapped to the canonical
// token. Undefined names silently drop declarations (or invalidate color-mix),
// so new aliases must be added to base.css, never invented at use sites.
const undefinedTokenMappings = {
  "bg-subtle": "bg-muted",
  "border-subtle": "border",
  fg: "text",
  // Font aliases arrive from surfaces that publish their own token names
  // (canvas widgets, the MCP Apps spec keys in mcp-app-theme.ts); inside
  // Control UI only --mono and --font-body exist.
  "font-mono": "mono",
  "font-sans": "font-body",
  foreground: "text",
  "panel-2": "panel-strong",
  success: "ok",
  surface: "panel",
  "text-muted": "muted",
  warning: "warn",
  "warning-subtle": "warn-subtle",
} as const;

function collectFiles(directory: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectFiles(entryPath, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [entryPath]
      : [];
  });
}

describe("Control UI base theme tokens", () => {
  it("defines every canonical replacement", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    for (const token of new Set(Object.values(undefinedTokenMappings))) {
      expect(baseCss, `missing --${token} in base.css`).toMatch(
        new RegExp(`^\\s*--${token}\\s*:`, "mu"),
      );
    }
  });

  it("does not reference undefined theme token names", () => {
    const undefinedTokens = Object.keys(undefinedTokenMappings);
    const referencePattern = new RegExp(
      `var\\(--(?:${undefinedTokens.join("|")})(?:\\s*\\)|\\s*,)`,
      "u",
    );
    // Inline style attributes and Lit css templates hit this class too
    // (var(--panel-2) shipped in a TS template), so scan all of ui/src.
    const violations = collectFiles(uiSrcDir, [".css", ".ts"])
      .filter((filePath) => !filePath.endsWith(".test.ts"))
      .flatMap((filePath) =>
        fs
          .readFileSync(filePath, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            referencePattern.test(line)
              ? [`${path.relative(uiSrcDir, filePath)}:${index + 1}: ${line.trim()}`]
              : [],
          ),
      );

    expect(violations).toEqual([]);
  });

  it("routes every Web Awesome switch through the shared accent", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");
    const localOverrides = collectFiles(stylesDir, [".css"])
      .filter((filePath) => !filePath.endsWith("base.css"))
      .filter((filePath) =>
        /[^{}]*wa-switch[^{}]*\{[^}]*--wa-form-control-activated-color:/su.test(
          fs.readFileSync(filePath, "utf8"),
        ),
      )
      .map((filePath) => path.relative(stylesDir, filePath));

    expect(baseCss).toMatch(
      /wa-switch\s*\{[^}]*--wa-form-control-activated-color:\s*var\(--accent\);[^}]*\}/su,
    );
    expect(localOverrides).toEqual([]);
  });

  it("derives the Web Awesome switch off state from theme tokens", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");
    const switchBlock = baseCss.match(/^wa-switch\s*\{([^}]*)\}/mu)?.[1] ?? "";
    // Unchecked track fill; the border color also paints the unchecked thumb.
    const offStateProperties = [
      "--wa-form-control-background-color",
      "--wa-form-control-border-color",
    ];
    const localOverrides = collectFiles(stylesDir, [".css"])
      .filter((filePath) => !filePath.endsWith("base.css"))
      .filter((filePath) =>
        offStateProperties.some((property) =>
          new RegExp(`[^{}]*wa-switch[^{}]*\\{[^}]*${property}:`, "su").test(
            fs.readFileSync(filePath, "utf8"),
          ),
        ),
      )
      .map((filePath) => path.relative(stylesDir, filePath));

    expect(switchBlock).toMatch(
      /--wa-form-control-background-color:\s*color-mix\(in srgb, var\(--border-strong\) 60%, transparent\);/u,
    );
    expect(switchBlock).toMatch(/--wa-form-control-border-color:\s*var\(--muted\);/u);
    expect(localOverrides).toEqual([]);
  });
});

// Palette edits left pre-paint mirrors stale before. Pre-paint needs a color
// before CSS loads.
describe("Control UI style --bg mirrors", () => {
  const RESOLVED_THEME_BG_SELECTOR = new Map<string, string>([
    ["phosphor", ":root"],
    ["phosphor-light", ':root:where([data-theme-mode="light"])'],
  ]);

  function readBlockToken(css: string, selector: string, token: string): string | undefined {
    const body = css.split(new RegExp(`${escapeSelector(selector)}\\s*\\{`, "u"))[1]?.split("}")[0];
    return body?.match(new RegExp(`${token}:\\s*([^;]+);`, "u"))?.[1]?.trim();
  }

  function escapeSelector(selector: string): string {
    return selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  }

  /** The style's canonical --bg, keyed by the resolved data-theme value. */
  function readCanonicalBackgrounds(): Map<string, string> {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");
    const backgrounds = new Map<string, string>();
    for (const [resolved, selector] of RESOLVED_THEME_BG_SELECTOR) {
      const value = readBlockToken(baseCss, selector, "--bg");
      if (value) {
        backgrounds.set(resolved, value);
      }
    }
    return backgrounds;
  }

  it("keeps the index.html pre-paint background on every theme's --bg", () => {
    const indexHtml = fs.readFileSync(path.join(uiSrcDir, "..", "index.html"), "utf8");
    const canonical = readCanonicalBackgrounds();

    const prePaint = new Map<string, string>();
    for (const match of indexHtml.matchAll(
      /html(?:\[data-theme-mode="([^"]+)"\])?\s*\{\s*background:\s*([^;]+);/gu,
    )) {
      const attribute = match[1];
      const value = (match[2] ?? "").trim();
      // Bare `html` is the default dark paint; the -mode selector is light.
      prePaint.set(attribute === "light" ? "phosphor-light" : "phosphor", value);
    }

    for (const [resolved, background] of canonical) {
      expect(prePaint.get(resolved)?.toLowerCase(), `${resolved}: pre-paint background`).toBe(
        background.toLowerCase(),
      );
    }

    expect(canonical.size).toBe(RESOLVED_THEME_BG_SELECTOR.size);
  });
});
