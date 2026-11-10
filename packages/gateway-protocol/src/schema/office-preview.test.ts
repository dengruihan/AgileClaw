// Gateway Protocol regression: the Office preview state schema keeps its
// historical public runtime name while `office-preview.ts` owns the vocabulary.
import { describe, expect, it } from "vitest";
import * as schemaModules from "../schema-modules.js";
import * as artifactSchema from "./artifacts.js";
import { SessionFileOfficePreviewStateSchema } from "./office-preview.js";

describe("Office preview state schema exports", () => {
  it("keeps the historical Artifact constant as an alias of the single owner", () => {
    expect("ArtifactOfficePreviewStateSchema" in artifactSchema).toBe(true);
    expect(artifactSchema.ArtifactOfficePreviewStateSchema).toBe(
      SessionFileOfficePreviewStateSchema,
    );
    // The protocol registry re-exports both schema modules, so the constant is
    // reachable from the public barrel under its historical name.
    expect("ArtifactOfficePreviewStateSchema" in schemaModules).toBe(true);
    expect(schemaModules.ArtifactOfficePreviewStateSchema).toBe(
      SessionFileOfficePreviewStateSchema,
    );
    // One schema object, one registered name: a second alias would make the
    // native protocol generator reject the branch.
    expect("SessionFileOfficePreviewStateSchema" in schemaModules).toBe(false);
  });
});
