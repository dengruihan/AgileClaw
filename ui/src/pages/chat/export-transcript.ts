import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { MessageContentItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
  resolveMessageRole,
  resolveMessageSenderLabel,
} from "../../lib/chat/message-normalizer.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";

/** One visible transcript turn, independent of the export format that serializes it. */
export type ChatTranscriptEntry = {
  /** Grouped role from the chat renderer's own classifier ("user", "assistant", "tool"). */
  role: string;
  /** Author role from the message envelope, which keeps AI text beside its tool calls. */
  authorRole: string;
  /** Explicit sender attribution, when the transcript carries one. */
  senderLabel: string | null;
  speaker: string;
  timestampMs: number | null;
  timestampIso: string | null;
  /** Display text after the chat renderer's envelope/thinking/tool projection. */
  text: string;
  /** Attachments the transcript cannot carry into a text export. */
  attachments: number;
};

const ATTACHMENT_CONTENT_TYPES = new Set<MessageContentItem["type"]>([
  "attachment",
  "attachment_error",
  "image",
  "omitted_media",
]);

export function countMessageAttachments(message: unknown): number {
  let content: MessageContentItem[];
  try {
    content = normalizeMessage(message).content;
  } catch {
    return 0;
  }
  return content.filter((item) => ATTACHMENT_CONTENT_TYPES.has(item.type)).length;
}

/**
 * Single owner for "which messages and which text appear in a transcript export".
 * Format serializers decide presentation only; they must not re-derive visibility,
 * role classification, speaker attribution, or text extraction.
 */
export function buildChatTranscript(
  messages: unknown[],
  assistantName: string,
): ChatTranscriptEntry[] {
  const entries: ChatTranscriptEntry[] = [];
  for (const message of visibleChatHistoryMessages(messages)) {
    const text = extractTextCached(message) ?? "";
    const attachments = countMessageAttachments(message);
    if (!text.trim() && attachments === 0) {
      continue;
    }
    const role = normalizeRoleForGrouping(resolveMessageRole(message));
    const envelope = asOptionalRecord(message);
    const authorRole = normalizeRoleForGrouping(readStringField(envelope, "role") ?? "");
    const senderLabel = resolveMessageSenderLabel(message);
    const speaker =
      role === "user"
        ? (senderLabel ?? t("chat.messages.unattributedSender"))
        : role === "assistant"
          ? (senderLabel ?? assistantName)
          : "Tool";
    const rawTimestamp = envelope?.timestamp;
    entries.push({
      role,
      authorRole,
      senderLabel: senderLabel ?? null,
      speaker,
      timestampMs:
        typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp) ? rawTimestamp : null,
      timestampIso: timestampMsToIsoString(rawTimestamp) ?? null,
      text,
      attachments,
    });
  }
  return entries;
}
