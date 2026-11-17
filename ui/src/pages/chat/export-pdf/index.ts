import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { buildChatTranscript } from "../export-transcript.ts";
import { buildChatPdf, ChatPdfTooLargeError, type ChatPdfEntry } from "./chat-pdf.ts";

export type ChatPdfBuildParams = {
  messages: unknown[];
  assistantName: string;
  /** Session title used as the document heading and file stem. */
  title: string;
  now?: number;
};

export type ChatPdfExportParams = ChatPdfBuildParams & {
  /** Live authority gate, called immediately before the download side effect. */
  authorize: () => boolean;
};

export type ChatPdfBuildOutcome = {
  bytes: Uint8Array;
  /** Characters the PDF fonts cannot carry, rendered as a visible marker. */
  unsupportedCharacters: number;
};

export type ChatPdfExportResult =
  | { status: "downloaded"; unsupportedCharacters: number }
  | { status: "empty" }
  | { status: "too-large" }
  | { status: "denied" };

const MAX_TRANSCRIPT_CHARS = 1_500_000;

const UNSAFE_FILE_CHARS = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);

function sanitizeFileStem(value: string): string {
  const stem = Array.from(value.normalize("NFKC"))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !UNSAFE_FILE_CHARS.has(char);
    })
    .join("")
    .replace(/\s+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 48);
  return stem || "session";
}

function timestampLabel(now: number): string {
  const iso = new Date(now).toISOString();
  return iso.slice(0, 19).replace("T", " ") + " UTC";
}

function fileTimestamp(now: number): string {
  return new Date(now).toISOString().slice(0, 19).replace(/[-:T]/gu, "").slice(0, 12);
}

/** Builds the exported entries: user bodies plus assistant bodies, never tool output. */
export function buildChatPdfEntries(messages: unknown[], assistantName: string): ChatPdfEntry[] {
  return buildChatTranscript(messages, assistantName)
    .filter((entry) => entry.authorRole === "user" || entry.authorRole === "assistant")
    .filter((entry) => entry.text.trim().length > 0 || entry.attachments > 0)
    .map((entry) => ({
      // Attribution follows the author: an AI turn that also called a tool is still the assistant.
      speaker:
        entry.authorRole === "user"
          ? (entry.senderLabel ?? t("chat.messages.unattributedSender"))
          : (entry.senderLabel ?? assistantName),
      role: entry.authorRole,
      timestampIso: entry.timestampIso,
      body: entry.text,
      attachments: entry.attachments,
    }));
}

export function buildChatPdfBytes(params: ChatPdfBuildParams): ChatPdfBuildOutcome | null {
  const entries = buildChatPdfEntries(params.messages, params.assistantName);
  if (entries.length === 0) {
    return null;
  }
  const chars = entries.reduce((total, entry) => total + entry.body.length, 0);
  if (chars > MAX_TRANSCRIPT_CHARS) {
    throw new ChatPdfTooLargeError();
  }
  const now = params.now ?? Date.now();
  const { bytes, unsupportedCharacters } = buildChatPdf({
    title: params.title,
    exportedAt: now,
    entries,
    labels: {
      meta: `${t("chat.exportPdf.exportedAt", { date: timestampLabel(now) })} · ${t(
        entries.length === 1 ? "chat.sessionHeader.oneMessage" : "chat.sessionHeader.messages",
        { count: String(entries.length) },
      )}`,
      attachmentsOmitted: t("chat.exportPdf.attachmentsOmitted"),
      continued: t("chat.exportPdf.continued"),
      pageOf: (page, count) =>
        t("chat.exportPdf.pageOf", { page: String(page), count: String(count) }),
      unsupportedGlyphs: (count) =>
        t(count === 1 ? "chat.exportPdf.unsupportedGlyph" : "chat.exportPdf.unsupportedGlyphs", {
          count: String(count),
        }),
    },
  });
  return { bytes, unsupportedCharacters };
}

export function exportChatPdf(params: ChatPdfExportParams): ChatPdfExportResult {
  let built: ChatPdfBuildOutcome | null;
  try {
    built = buildChatPdfBytes(params);
  } catch (error) {
    if (error instanceof ChatPdfTooLargeError) {
      return { status: "too-large" };
    }
    throw error;
  }
  if (!built) {
    return { status: "empty" };
  }
  // Nothing awaits between this authority read and the download, so a revoked
  // role or scope cannot slip in after the check.
  if (!params.authorize()) {
    return { status: "denied" };
  }
  const now = params.now ?? Date.now();
  downloadBlobFile(
    `openclaw-chat-${sanitizeFileStem(params.title)}-${fileTimestamp(now)}.pdf`,
    new Blob([new Uint8Array(built.bytes).buffer], { type: "application/pdf" }),
  );
  return { status: "downloaded", unsupportedCharacters: built.unsupportedCharacters };
}
