// Gateway Protocol regression: the Office preview state schema keeps its
// historical public runtime name while `office-preview.ts` owns the vocabulary.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import * as schemaModules from "../schema-modules.js";
import * as artifactSchema from "./artifacts.js";
import {
  SessionFileOfficePdfSchema,
  SessionFileOfficePreviewSchema,
  SessionFileOfficePreviewStateSchema,
} from "./office-preview.js";

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

describe("Office preview payload schema", () => {
  it("carries the converted PDF payload", () => {
    const pdf = {
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.7\npreview").toString("base64"),
      sizeBytes: 14,
    };

    expect(Value.Check(SessionFileOfficePdfSchema, pdf)).toBe(true);
    expect(
      Value.Check(artifactSchema.ArtifactOfficePreviewSchema, {
        kind: "office",
        format: "docx",
        state: "ready",
        pdf,
      }),
    ).toBe(true);
    expect(
      Value.Check(artifactSchema.ArtifactOfficePreviewSchema, {
        kind: "office",
        format: "docx",
        state: "unavailable",
      }),
    ).toBe(true);
  });

  it("keeps the structured preview schema as the published contract", () => {
    expect(
      Value.Check(SessionFileOfficePreviewSchema, {
        format: "xlsx",
        sheets: [{ name: "Budget", rows: [["Rent"]], rowCount: 1, columnCount: 1 }],
      }),
    ).toBe(true);
  });

  it("rejects a PDF payload with the wrong media type or size", () => {
    expect(
      Value.Check(SessionFileOfficePdfSchema, {
        mimeType: "text/html",
        data: "",
        sizeBytes: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionFileOfficePdfSchema, {
        mimeType: "application/pdf",
        data: "",
        sizeBytes: 16 * 1024 * 1024 + 1,
      }),
    ).toBe(false);
  });
});
