import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileOfficePdfSchema } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { OLE_COMPOUND_FILE_SIGNATURE } from "../office-preview/office-preview-container.js";
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
  convert: vi.fn(),
}));

vi.mock("../office-preview/office-preview-convert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../office-preview/office-preview-convert.js")>()),
  convertOfficeDocumentToPdf: hoisted.convert,
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
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PREVIEW_PDF = Buffer.from("%PDF-1.7\nworkspace-preview");

let fixtureSequence = 0;
function packageBytes(): Buffer {
  fixtureSequence += 1;
  return Buffer.concat([ZIP_LOCAL_HEADER, Buffer.from(`synthetic-package-${fixtureSequence}`)]);
}

function encryptedContainer(): Buffer {
  return Buffer.concat([OLE_COMPOUND_FILE_SIGNATURE, Buffer.from("EncryptedPackage", "utf16le")]);
}

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
  hoisted.convert.mockResolvedValue({ pdf: PREVIEW_PDF });
});

afterEach(() => {
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files Office PDF previews", () => {
  it("converts modern OOXML workspace files only when they are opened", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "budget.xlsx"), packageBytes());
    fs.writeFileSync(path.join(workspaceRoot, "report.docx"), packageBytes());
    fs.writeFileSync(path.join(workspaceRoot, "deck.pptx"), packageBytes());

    const workbook = expectOkPayload(await getFile("budget.xlsx")).file;
    expect(workbook).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "budget.xlsx",
      previewKind: "office",
      previewState: "ready",
    });
    expect(workbook.officePdf).toEqual({
      mimeType: "application/pdf",
      data: PREVIEW_PDF.toString("base64"),
      sizeBytes: PREVIEW_PDF.length,
    });
    expect(workbook.officePreview).toBeUndefined();
    expect(workbook.content).toBeUndefined();
    expect(Value.Check(SessionFileOfficePdfSchema, workbook.officePdf)).toBe(true);

    const document = expectOkPayload(await getFile("report.docx")).file;
    expect(document).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "office",
      previewState: "ready",
    });
    const presentation = expectOkPayload(await getFile("deck.pptx")).file;
    expect(presentation).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      previewKind: "office",
      previewState: "ready",
    });
    expect(hoisted.convert).toHaveBeenCalledTimes(3);
  });

  it("surfaces a converter outage instead of failing the file read", async () => {
    hoisted.convert.mockResolvedValue({ failure: "unavailable" });
    fs.writeFileSync(path.join(workspaceRoot, "outage.xlsx"), packageBytes());

    const file = expectOkPayload(await getFile("outage.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "outage.xlsx",
      previewKind: "unsupported",
      previewState: "unavailable",
    });
    expect(file.officePdf).toBeUndefined();
    expect(file.content).toBeUndefined();
  });

  it("degrades a corrupt package to a visible conversion failure", async () => {
    hoisted.convert.mockResolvedValue({ failure: "failed" });
    fs.writeFileSync(
      path.join(workspaceRoot, "broken.xlsx"),
      Buffer.concat([ZIP_LOCAL_HEADER, Buffer.from("garbage")]),
    );

    const file = expectOkPayload(await getFile("broken.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "broken.xlsx",
      previewKind: "unsupported",
      previewState: "failed",
    });
    expect(file.officePdf).toBeUndefined();
    expect(file.content).toBeUndefined();
    expect(hoisted.convert).toHaveBeenCalledOnce();
  });

  it("reports non-package bytes as invalid without converting them", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "renamed.xlsx"),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
    );

    const file = expectOkPayload(await getFile("renamed.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      path: "renamed.xlsx",
      previewKind: "unsupported",
      previewState: "invalid",
    });
    expect(file.officePdf).toBeUndefined();
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("labels legacy OLE containers without converting them", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "legacy.xls"),
      Buffer.concat([OLE_COMPOUND_FILE_SIGNATURE, Buffer.alloc(512)]),
    );

    const file = expectOkPayload(await getFile("legacy.xls")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.ms-excel",
      path: "legacy.xls",
      previewKind: "unsupported",
      previewState: "unsupported",
    });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("keeps the metadata-only preview for oversized workbooks", async () => {
    fs.writeFileSync(
      path.join(workspaceRoot, "huge.xlsx"),
      Buffer.concat([packageBytes(), Buffer.alloc(9 * 1024 * 1024)]),
    );

    const file = expectOkPayload(await getFile("huge.xlsx")).file;

    expect(file).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      previewKind: "unsupported",
      previewState: "too-large",
    });
    expect(file.content).toBeUndefined();
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it("keeps password-protected packages metadata-only", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "encrypted-container.docx"), encryptedContainer());

    const container = expectOkPayload(await getFile("encrypted-container.docx")).file;
    expect(container).toMatchObject({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "unsupported",
      previewState: "password-protected",
    });
    expect(container.officePdf).toBeUndefined();
    expect(hoisted.convert).not.toHaveBeenCalled();
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
