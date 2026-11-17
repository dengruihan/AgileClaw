import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { buildChatTranscript } from "../export-transcript.ts";
import { buildChatPdf, ChatPdfTooLargeError, type ChatPdfEntry } from "./chat-pdf.ts";

export type ChatPdfExportParams = {
  messages: unknown[];
  assistantName: string;
  /** Session title used as the document heading and file stem. */
  title: string;
  now?: number;
};

export type ChatPdfExportResult = "downloaded" | "empty" | "too-large";

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

export function buildChatPdfBytes(params: ChatPdfExportParams): Uint8Array | null {
  const entries = buildChatPdfEntries(params.messages, params.assistantName);
  if (entries.length === 0) {
    return null;
  }
  const chars = entries.reduce((total, entry) => total + entry.body.length, 0);
  if (chars > MAX_TRANSCRIPT_CHARS) {
    throw new ChatPdfTooLargeError();
  }
  const now = params.now ?? Date.now();
  return buildChatPdf({
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
    },
  });
}

export function exportChatPdf(params: ChatPdfExportParams): ChatPdfExportResult {
  let bytes: Uint8Array | null;
  try {
    bytes = buildChatPdfBytes(params);
  } catch (error) {
    if (error instanceof ChatPdfTooLargeError) {
      return "too-large";
    }
    throw error;
  }
  if (!bytes) {
    return "empty";
  }
  const now = params.now ?? Date.now();
  downloadBlobFile(
    `openclaw-chat-${sanitizeFileStem(params.title)}-${fileTimestamp(now)}.pdf`,
    new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" }),
  );
  return "downloaded";
}
