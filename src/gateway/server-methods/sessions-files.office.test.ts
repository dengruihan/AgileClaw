import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import {
  buildDocxFixture,
  buildEncryptedOoxmlContainer,
  buildEncryptedZipFixture,
  buildEntryOverflowZipFixture,
  buildPptxFixture,
  buildStyledDocxFixture,
  buildStyledXlsxFixture,
  buildXlsxFixture,
  OLE_COMPOUND_FILE_HEADER,
} from "../office-preview/office-preview.test-support.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readDelta: vi.fn(),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-transcript-readers.js", async (original) => ({
  ...(await original<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta,
}));

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
function getFile(filePath: string) {
  return invoke("sessions.files.get", { sessionKey, path: filePath });
}

const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(
    { ...hoisted, readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta },
    mockVisibleMessages,
  );
});

afterEach(() => {
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files office previews", () => {
  it("bounds malformed worksheet row numbers at the RPC boundary", async () => {
    const sheetDataXml = Array.from(
      { length: 201 },
      (_, index) => `<row r="1"><c r="A1"><v>${index}</v></c></row>`,
    ).join("");
    fs.writeFileSync(
      path.join(workspaceRoot, "bogus-rows.xlsx"),
      await buildXlsxFixture({ sheets: [{ name: "Bogus", sheetDataXml }], sharedStrings: [] }),
    );

    const file = expectOkPayload(await getFile("bogus-rows.xlsx")).file;

    expect(file.previewKind).toBe("office");
    expect(file.officePreview.sheets[0].rows).toHaveLength(200);
    expect(file.officePreview.sheets[0].truncated).toBe(true);
    expect(file.officePreview.truncated).toBe(true);
    // The closed protocol schema rejects more than 200 rows, so the RPC payload
    // must validate as a whole.
    expect(Value.Check(SessionFileOfficePreviewSchema, file.officePreview)).toBe(true);
  });

  it("returns schema-valid payloads for overlong column references", async () => {
    const overlong = "A".repeat(400);
    const sheetDataXml = `<row r="1"><c r="${overlong}1"><v>1</v></c><c r="B1"><v>2</v></c></row>`;
    fs.writeFileSync(
      path.join(workspaceRoot, "overlong-column.xlsx"),
      await buildXlsxFixture({ sheets: [{ name: "Columns", sheetDataXml }], sharedStrings: [] }),
    );

    const file = expectOkPayload(await getFile("overlong-column.xlsx")).file;

    expect(file.previewKind).toBe("office");
    expect(file.officePreview.sheets[0].rows).toEqual([["1", "2"]]);
    expect(file.officePreview.sheets[0].columnCount).toBe(2);
    expect(Value.Check(SessionFileOfficePreviewSchema, file.officePreview)).toBe(true);
    expect(JSON.stringify(file.officePreview)).toContain('"columnCount":2');
  });

  it("returns structured payloads for modern OOXML files", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "budget.xlsx"), await buildXlsxFixture());
    fs.writeFileSync(path.join(workspaceRoot, "report.docx"), await buildDocxFixture());
    fs.writeFileSync(path.join(workspaceRoot, "deck.pptx"), await buildPptxFixture());

    const workbook = expectOkPayload(await getFile("budget.xlsx")).file;
    expect(workbook).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "budget.xlsx",
      previewKind: "office",
    });
    expect(workbook.officePreview.sheets[0].rows[1]).toEqual(["Rent", "1200"]);

    const document = expectOkPayload(await getFile("report.docx")).file;
    expect(document).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "office",
    });
    expect(document.officePreview.blocks[0]).toEqual({
      kind: "heading",
      level: 1,
      text: "Quarterly report",
    });

    const presentation = expectOkPayload(await getFile("deck.pptx")).file;
    expect(presentation).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      previewKind: "office",
    });
    expect(presentation.officePreview.slides[0]).toMatchObject({ index: 1, title: "Roadmap" });
  });

  it("degrades corrupt packages to metadata instead of failing the read", async () => {
    const fixture = await buildXlsxFixture();
    fs.writeFileSync(
      path.join(workspaceRoot, "broken.xlsx"),
      Buffer.concat([fixture.subarray(0, 64), Buffer.from("garbage")]),
    );

    const file = expectOkPayload(await getFile("broken.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "broken.xlsx",
      previewKind: "unsupported",
      previewState: "invalid",
    });
    expect(file.officePreview).toBeUndefined();
    expect(file.content).toBeUndefined();
  });

  it("labels legacy OLE containers without parsing them", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "legacy.xls"),
      Buffer.concat([OLE_COMPOUND_FILE_HEADER, Buffer.alloc(512)]),
    );

    const file = expectOkPayload(await getFile("legacy.xls")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.ms-excel",
      path: "legacy.xls",
      previewKind: "unsupported",
      previewState: "unsupported",
    });
  });

  it("keeps the metadata-only preview for oversized workbooks", async () => {
    const fixture = await buildXlsxFixture();
    fs.writeFileSync(
      path.join(workspaceRoot, "huge.xlsx"),
      Buffer.concat([fixture, Buffer.alloc(9 * 1024 * 1024)]),
    );

    const file = expectOkPayload(await getFile("huge.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      previewKind: "unsupported",
      previewState: "too-large",
    });
    expect(file.content).toBeUndefined();
  });

  it("returns richer layout payloads for styled workbooks and documents", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "styled.xlsx"), await buildStyledXlsxFixture());
    fs.writeFileSync(path.join(workspaceRoot, "styled.docx"), await buildStyledDocxFixture());

    const workbook = expectOkPayload(await getFile("styled.xlsx")).file;
    expect(workbook).toMatchObject({ previewKind: "office", previewState: "ready" });
    expect(workbook.officePreview.sheets[0].columns).toEqual([
      { width: 30 },
      { width: 16 },
      { width: 16 },
    ]);
    expect(workbook.officePreview.sheets[0].rows[1][1]).toBe("$1,200.50");
    expect(workbook.officePreview.sheets[0].mergedCells).toHaveLength(1);
    expect(workbook.officePreview.sheets[0].frozenRows).toBe(1);
    expect(Value.Check(SessionFileOfficePreviewSchema, workbook.officePreview)).toBe(true);

    const document = expectOkPayload(await getFile("styled.docx")).file;
    expect(document).toMatchObject({ previewKind: "office", previewState: "ready" });
    expect(document.officePreview.pages).toHaveLength(3);
    expect(document.officePreview.pages[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "paragraph", role: "title" }),
        expect.objectContaining({ kind: "table" }),
        expect.objectContaining({ kind: "image" }),
      ]),
    );
    expect(Value.Check(SessionFileOfficePreviewSchema, document.officePreview)).toBe(true);
  });

  it("keeps password-protected and encrypted packages metadata-only", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "encrypted-container.docx"),
      buildEncryptedOoxmlContainer(),
    );
    fs.writeFileSync(path.join(workspaceRoot, "encrypted-zip.docx"), buildEncryptedZipFixture());

    const container = expectOkPayload(await getFile("encrypted-container.docx")).file;
    expect(container).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "unsupported",
      previewState: "password-protected",
    });
    expect(container.officePreview).toBeUndefined();

    const zip = expectOkPayload(await getFile("encrypted-zip.docx")).file;
    expect(zip).toMatchObject({ previewKind: "unsupported", previewState: "password-protected" });
    expect(zip.officePreview).toBeUndefined();
  });

  it("reports an archive resource-limit budget as too-large", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "overflow.xlsx"),
      await buildEntryOverflowZipFixture(),
    );

    const file = expectOkPayload(await getFile("overflow.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      previewKind: "unsupported",
      previewState: "too-large",
    });
    expect(file.officePreview).toBeUndefined();
  });

  it("keeps a text file renamed to .xlsx on the text preview", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "notes.xlsx"), "plain text\n", "utf8");

    const payload = expectOkPayload(await getFile("notes.xlsx"));

    expect(payload.file).toMatchObject({
      content: "plain text\n",
      contentEncoding: "utf8",
      previewKind: "text",
    });
  });
});
