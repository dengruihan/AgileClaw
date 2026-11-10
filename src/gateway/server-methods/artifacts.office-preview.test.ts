import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactsDownloadResultSchema } from "../../../packages/gateway-protocol/src/schema/artifacts.js";
import {
  buildEncryptedOoxmlContainer,
  buildStyledXlsxFixture,
  buildXlsxFixture,
} from "../office-preview/office-preview.test-support.js";
import {
  expectErrorDetails,
  expectFirstArtifact,
  expectOkPayload,
  requireNonEmptyString,
  runtimeContext,
} from "./artifacts.test-support.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const hoisted = vi.hoisted(() => ({
  readManagedArtifactContent: vi.fn(),
  resolveManagedArtifactDownload: vi.fn(),
  resolveManagedUrlDownload: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../session-sharing-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-sharing-preparation.js")>();
  const { artifactFixtureSessionFacts } = await import("./artifacts.test-support.js");
  return {
    ...actual,
    prepareSessionMutationFacts: async (
      params: Parameters<typeof actual.prepareSessionMutationFacts>[0],
    ) => artifactFixtureSessionFacts(params),
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  const { withArtifactFixtureReader } = await import("./artifacts.test-support.js");
  return withArtifactFixtureReader(actual, hoisted.visitSessionMessagesAsync);
});

vi.mock("../managed-image-attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../managed-image-attachments.js")>(
    "../managed-image-attachments.js",
  );
  return {
    ...actual,
    readManagedOutgoingMediaArtifactContent: hoisted.readManagedArtifactContent,
    resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
    resolveManagedOutgoingMediaUrlDownload: hoisted.resolveManagedUrlDownload,
  };
});

const { artifactsHandlers } = await import("./artifacts.js");

type ArtifactCall = { ok: boolean; payload?: unknown; error?: unknown };

async function invoke(
  method: "artifacts.list" | "artifacts.download",
  params: Record<string, unknown>,
): Promise<ArtifactCall[]> {
  const calls: ArtifactCall[] = [];
  await artifactsHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    context: runtimeContext({}) as never,
  });
  return calls;
}

function messageWithFile(file: Record<string, unknown>) {
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    visit({ role: "assistant", content: [file], __openclaw: { seq: 2 } }, 2);
    return 1;
  });
}

function messageWithFilteredFile(params: {
  file: Record<string, unknown>;
  role?: string;
  runId: string;
  seq?: number;
}) {
  const seq = params.seq ?? 2;
  hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
    visit(
      {
        role: params.role ?? "assistant",
        content: [params.file],
        __openclaw: { seq, runId: params.runId },
      },
      seq,
    );
    return 1;
  });
}

async function openInlineArtifact(file: Record<string, unknown>) {
  messageWithFile(file);
  const listed = await invoke("artifacts.list", { sessionKey: "agent:main:main" });
  const artifactId = requireNonEmptyString(
    expectFirstArtifact(listed)?.id,
    "expected an inline artifact id",
  );
  return artifactId;
}

describe("artifacts.download opt-in Office preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.readManagedArtifactContent.mockResolvedValue(null);
  });

  it("parses an inline workbook only when preview is requested", async () => {
    const buffer = await buildXlsxFixture();
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "budget.xlsx",
      mimeType: XLSX_MIME,
      data: buffer.toString("base64"),
      sizeBytes: buffer.length,
    });

    const previewCalls = await invoke("artifacts.download", {
      sessionKey: "agent:main:main",
      artifactId,
      preview: "office",
    });
    const payload = expectOkPayload(previewCalls) as {
      artifact: Record<string, unknown>;
      preview: Record<string, unknown>;
      data?: string;
    };
    expect(payload.artifact).toMatchObject({ id: artifactId, title: "budget.xlsx" });
    expect(payload.preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    expect(payload.data).toBeUndefined();
    expect(Value.Check(ArtifactsDownloadResultSchema, payload)).toBe(true);

    // The ordinary download path still returns bytes and never parses them.
    messageWithFile({
      type: "file",
      title: "budget.xlsx",
      mimeType: XLSX_MIME,
      data: buffer.toString("base64"),
      sizeBytes: buffer.length,
    });
    const downloadCalls = await invoke("artifacts.download", {
      sessionKey: "agent:main:main",
      artifactId,
    });
    const download = expectOkPayload(downloadCalls) as {
      encoding?: string;
      data?: string;
      preview?: unknown;
    };
    expect(download.encoding).toBe("base64");
    expect(download.data).toBe(buffer.toString("base64"));
    expect(download.preview).toBeUndefined();
  });

  it("returns the richer workbook layout through an inline artifact", async () => {
    const buffer = await buildStyledXlsxFixture();
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "styled.xlsx",
      mimeType: XLSX_MIME,
      data: buffer.toString("base64"),
      sizeBytes: buffer.length,
    });

    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { preview: { state: string; preview: { sheets: Record<string, unknown>[] } } };
    expect(payload.preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    const sheet = payload.preview.preview.sheets[0];
    expect(sheet?.columns).toEqual([{ width: 30 }, { width: 16 }, { width: 16 }]);
    expect(sheet?.mergedCells).toHaveLength(1);
    const rows = sheet?.rows as string[][] | undefined;
    expect(rows?.[1]?.[1]).toBe("$1,200.50");
    expect(Value.Check(ArtifactsDownloadResultSchema, payload)).toBe(true);
  });

  it("returns the richer workbook layout through a managed artifact", async () => {
    const buffer = await buildStyledXlsxFixture();
    const artifactId = "artifact_managed_media_33333333-3333-4333-8333-333333333333";
    hoisted.readManagedArtifactContent.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "styled.xlsx",
      filename: "styled.xlsx",
      mimeType: XLSX_MIME,
      sizeBytes: buffer.length,
      buffer,
      tooLarge: false,
    });

    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        agentId: "main",
        artifactId,
        preview: "office",
      }),
    ) as { preview: { preview: { sheets: Record<string, unknown>[] } } };
    expect(payload.preview.preview.sheets[0]?.frozenColumns).toBe(1);
    expect(payload.preview.preview.sheets[0]?.styles).toBeTruthy();
  });

  it("reports an encrypted package as password-protected", async () => {
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "secret.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: buildEncryptedOoxmlContainer().toString("base64"),
      sizeBytes: buildEncryptedOoxmlContainer().length,
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { preview: Record<string, unknown> };
    expect(payload.preview).toEqual({
      kind: "office",
      format: "docx",
      state: "password-protected",
    });
    expect(Value.Check(ArtifactsDownloadResultSchema, payload)).toBe(true);
  });

  it("reports corrupt and renamed packages as invalid", async () => {
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "broken.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: Buffer.from("not a package").toString("base64"),
      sizeBytes: 13,
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { preview: Record<string, unknown> };
    expect(payload.preview).toEqual({ kind: "office", format: "docx", state: "invalid" });
  });

  it("keeps legacy containers metadata-only", async () => {
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "ledger.xls",
      mimeType: "application/vnd.ms-excel",
      data: Buffer.from("legacy").toString("base64"),
      sizeBytes: 6,
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { preview: Record<string, unknown> };
    expect(payload.preview).toEqual({ kind: "office", state: "unsupported" });
  });

  it("answers non-Office preview requests with ordinary download delivery", async () => {
    const data = Buffer.from("%PDF-1.4").toString("base64");
    const artifactId = await openInlineArtifact({
      type: "file",
      title: "report.pdf",
      mimeType: "application/pdf",
      data,
      sizeBytes: 8,
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { preview?: unknown; encoding?: string; data?: string; url?: string };
    // The preview opt-in never strips the payload another preview needs.
    expect(payload.preview).toBeUndefined();
    expect(payload.encoding).toBe("base64");
    expect(payload.data).toBe(data);
    expect(Value.Check(ArtifactsDownloadResultSchema, payload)).toBe(true);
  });

  it("keeps managed images on their ordinary URL delivery when a preview is requested", async () => {
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "image",
      title: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { artifact: Record<string, unknown>; url?: string; preview?: unknown };
    expect(payload.artifact).toMatchObject({ id: artifactId, type: "image" });
    expect(payload.url).toContain("/api/chat/media/outgoing/");
    expect(payload.preview).toBeUndefined();
    // Image-family IDs never read the managed original for the Office parser.
    expect(hoisted.readManagedArtifactContent).not.toHaveBeenCalled();
  });

  it("keeps managed non-Office media on their ordinary URL delivery", async () => {
    const artifactId = "artifact_managed_media_22222222-2222-4222-8222-222222222222";
    hoisted.readManagedArtifactContent.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "voice-note.mp3",
      filename: "voice-note.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 2048,
      buffer: Buffer.from("id3"),
      tooLarge: false,
    });
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "media",
      title: "voice-note.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 2048,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        artifactId,
        preview: "office",
      }),
    ) as { url?: string; preview?: unknown };
    expect(payload.url).toContain("/api/chat/media/outgoing/");
    expect(payload.preview).toBeUndefined();
  });

  it("reads the managed original under its existing ownership without minting a ticket", async () => {
    const buffer = await buildXlsxFixture();
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    hoisted.readManagedArtifactContent.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "applications.xlsx",
      filename: "applications.xlsx",
      mimeType: XLSX_MIME,
      sizeBytes: buffer.length,
      buffer,
      tooLarge: false,
    });

    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        agentId: "main",
        artifactId,
        preview: "office",
      }),
    ) as {
      artifact: Record<string, unknown>;
      preview: Record<string, unknown>;
      url?: string;
    };
    expect(payload.artifact).toMatchObject({
      id: artifactId,
      title: "applications.xlsx",
      sessionKey: "agent:main:main",
    });
    expect(payload.preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    expect(payload.url).toBeUndefined();
    expect(hoisted.readManagedArtifactContent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        artifactId,
        maxBytes: 8 * 1024 * 1024,
      }),
    );
    expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
    expect(hoisted.resolveManagedUrlDownload).not.toHaveBeenCalled();
  });

  it("carries matched run provenance into a managed Office preview", async () => {
    const buffer = await buildXlsxFixture();
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    messageWithFilteredFile({
      runId: "run-preview",
      file: { type: "file", artifactId, title: "applications.xlsx", mimeType: XLSX_MIME },
    });
    hoisted.readManagedArtifactContent.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "applications.xlsx",
      filename: "applications.xlsx",
      mimeType: XLSX_MIME,
      sizeBytes: buffer.length,
      buffer,
      tooLarge: false,
    });

    const payload = expectOkPayload(
      await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        agentId: "main",
        artifactId,
        runId: "run-preview",
        messageRole: "assistant",
        preview: "office",
      }),
    ) as { artifact: Record<string, unknown>; preview: Record<string, unknown> };
    expect(payload.preview).toMatchObject({ kind: "office", format: "xlsx", state: "ready" });
    expect(payload.artifact).toMatchObject({
      id: artifactId,
      runId: "run-preview",
      messageSeq: 2,
      source: "session-transcript",
    });
  });

  it.each([
    { filter: { runId: "other-run" }, messageRole: "assistant" },
    { filter: { runId: "run-preview", messageRole: "assistant" }, messageRole: "user" },
    { filter: { messageRole: "assistant" }, messageRole: "user" },
  ])(
    "requires filtered transcript membership before a managed Office preview: %j",
    async ({ filter, messageRole }) => {
      const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
      messageWithFilteredFile({
        role: messageRole,
        runId: "run-preview",
        file: { type: "file", artifactId, title: "applications.xlsx", mimeType: XLSX_MIME },
      });

      const calls = await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        agentId: "main",
        artifactId,
        preview: "office",
        ...filter,
      });
      expect(expectErrorDetails(calls)).toMatchObject({ type: "artifact_not_found", artifactId });
      expect(hoisted.readManagedArtifactContent).not.toHaveBeenCalled();
      expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { match: false, filter: { runId: "other-run" } },
    { match: true, filter: { runId: "run-preview" } },
  ])(
    "applies run filters to managed image fallbacks (match: $match)",
    async ({ match, filter }) => {
      const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
      messageWithFilteredFile({ runId: "run-preview", file: { type: "image", artifactId } });
      hoisted.resolveManagedArtifactDownload.mockResolvedValue({
        artifactId,
        sessionKey: "agent:main:main",
        type: "image",
        title: "chart.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        url: `/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const calls = await invoke("artifacts.download", {
        sessionKey: "agent:main:main",
        agentId: "main",
        artifactId,
        preview: "office",
        ...filter,
      });
      if (!match) {
        expect(expectErrorDetails(calls)).toMatchObject({ type: "artifact_not_found", artifactId });
        expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
        return;
      }
      const payload = expectOkPayload(calls) as {
        artifact: Record<string, unknown>;
        url?: string;
      };
      expect(payload.url).toContain("/api/chat/media/outgoing/");
      expect(payload.artifact).toMatchObject({
        id: artifactId,
        runId: "run-preview",
        messageSeq: 2,
      });
    },
  );

  it("requires filtered membership before a managed non-Office fallback", async () => {
    const artifactId = "artifact_managed_media_22222222-2222-4222-8222-222222222222";
    messageWithFilteredFile({
      runId: "run-preview",
      file: { type: "file", artifactId, title: "voice-note.mp3", mimeType: "audio/mpeg" },
    });
    hoisted.readManagedArtifactContent.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "file",
      title: "voice-note.mp3",
      filename: "voice-note.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 2048,
      buffer: Buffer.from("id3"),
      tooLarge: false,
    });
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "media",
      title: "voice-note.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 2048,
      url: `/api/chat/media/outgoing/agent%3Amain%3Amain/22222222-2222-4222-8222-222222222222/full`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const calls = await invoke("artifacts.download", {
      sessionKey: "agent:main:main",
      agentId: "main",
      artifactId,
      runId: "other-run",
      preview: "office",
    });
    expect(expectErrorDetails(calls)).toMatchObject({ type: "artifact_not_found", artifactId });
    expect(hoisted.readManagedArtifactContent).not.toHaveBeenCalled();
    expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
  });

  it("reports a managed artifact that its owner no longer exposes", async () => {
    const artifactId = "artifact_managed_media_11111111-1111-4111-8111-111111111111";
    const calls = await invoke("artifacts.download", {
      sessionKey: "agent:main:main",
      artifactId,
      preview: "office",
    });
    expect(expectErrorDetails(calls)).toMatchObject({
      type: "artifact_not_found",
      artifactId,
    });
    expect(hoisted.resolveManagedArtifactDownload).not.toHaveBeenCalled();
  });

  it("rejects preview reads without a session scope", async () => {
    const calls = await invoke("artifacts.download", {
      artifactId: "artifact_managed_media_11111111-1111-4111-8111-111111111111",
      preview: "office",
    });
    expectErrorDetails(calls);
    expect(hoisted.visitSessionMessagesAsync).not.toHaveBeenCalled();
    expect(hoisted.readManagedArtifactContent).not.toHaveBeenCalled();
  });
});
