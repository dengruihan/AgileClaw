import { downloadTextFile } from "../../lib/download.ts";
import { buildChatTranscript } from "./export-transcript.ts";

export type ChatExportResult = "downloaded" | "empty";

export function exportChatMarkdown(messages: unknown[], assistantName: string): ChatExportResult {
  const markdown = buildChatMarkdown(messages, assistantName);
  if (!markdown) {
    return "empty";
  }
  downloadTextFile(`chat-${assistantName}-${Date.now()}.md`, markdown, "text/markdown");
  return "downloaded";
}

export function buildChatMarkdown(messages: unknown[], assistantName: string): string | null {
  const lines: string[] = [];
  for (const entry of buildChatTranscript(messages, assistantName)) {
    if (!entry.text.trim()) {
      continue;
    }
    lines.push(
      `## ${entry.speaker}${entry.timestampIso ? ` (${entry.timestampIso})` : ""}`,
      "",
      entry.text,
      "",
    );
  }
  return lines.length > 0 ? [`# Chat with ${assistantName}`, "", ...lines].join("\n") : null;
}
