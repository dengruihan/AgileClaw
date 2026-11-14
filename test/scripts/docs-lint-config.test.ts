import fs from "node:fs";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";

type DocsLintConfig = {
  globs?: string[];
  gitignore?: boolean;
};

function readDocsLintConfig(): DocsLintConfig {
  return JSON5.parse(fs.readFileSync("config/markdownlint-cli2.jsonc", "utf8")) as DocsLintConfig;
}

// CI checkouts never contain gitignored local notes (docs/internal/), so only
// this config guard protects the lint input boundary from regressing.
describe("docs lint input boundary", () => {
  it("respects .gitignore so local notes stay out of docs lint", () => {
    expect(readDocsLintConfig().gitignore).toBe(true);
  });

  it("keeps every tracked docs surface in lint scope", () => {
    expect(readDocsLintConfig().globs).toEqual(
      expect.arrayContaining(["docs/**/*.md", "docs/**/*.mdx", "README.md"]),
    );
  });
});
