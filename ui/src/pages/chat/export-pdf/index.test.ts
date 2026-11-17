import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlobFile } from "../../../lib/download.ts";
import { buildChatPdfBytes, buildChatPdfEntries, exportChatPdf } from "./index.ts";

vi.mock("../../../lib/download.ts", () => ({ downloadBlobFile: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const transcript = [
  { role: "user", content: "Which checks gate the release?", timestamp: 1_000 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The operator wants the gate list; keep it short." },
      { type: "text", text: "Tests and the UI lane gate the release." },
      { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "synthetic-check" } },
    ],
    timestamp: 2_000,
  },
  { role: "toolResult", toolCallId: "call-1", content: "exit 0\nsynthetic output" },
  { role: "assistant", content: "NO_REPLY" },
];

describe("buildChatPdfEntries", () => {
  it("keeps user and assistant bodies while dropping thinking, tools, and silent replies", () => {
    expect(buildChatPdfEntries(transcript, "AgileClaw")).toEqual([
      {
        speaker: "Message",
        role: "user",
        timestampIso: "1970-01-01T00:00:01.000Z",
        body: "Which checks gate the release?",
        attachments: 0,
      },
      {
        speaker: "AgileClaw",
        role: "assistant",
        timestampIso: "1970-01-01T00:00:02.000Z",
        body: "Tests and the UI lane gate the release.",
        attachments: 0,
      },
    ]);
  });

  it("returns no entries for a transcript without user or assistant bodies", () => {
    expect(
      buildChatPdfEntries(
        [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
          },
          { role: "toolResult", toolCallId: "call-1", content: "done" },
        ],
        "AgileClaw",
      ),
    ).toEqual([]);
  });
});

describe("exportChatPdf", () => {
  it("downloads one PDF named from the session title", () => {
    expect(
      exportChatPdf({
        messages: transcript,
        assistantName: "AgileClaw",
        title: "Release: planning/2026",
        now: Date.parse("2026-11-17T09:30:00Z"),
        authorize: () => true,
      }),
    ).toEqual({ status: "downloaded", unsupportedCharacters: 0 });

    const download = vi.mocked(downloadBlobFile);
    expect(download).toHaveBeenCalledOnce();
    // Unsafe filename characters never reach the download name.
    expect(download.mock.calls[0]![0]).toBe("openclaw-chat-Release-planning2026-202611170930.pdf");
    expect(download.mock.calls[0]![1].type).toBe("application/pdf");
  });

  it("refuses the download when live authority is revoked before the side effect", () => {
    expect(
      exportChatPdf({
        messages: transcript,
        assistantName: "AgileClaw",
        title: "Release planning",
        now: Date.parse("2026-11-17T09:30:00Z"),
        authorize: () => false,
      }),
    ).toEqual({ status: "denied" });
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it("reports an empty transcript without creating a download", () => {
    expect(
      exportChatPdf({
        messages: [],
        assistantName: "AgileClaw",
        title: "Empty",
        now: Date.parse("2026-11-17T09:30:00Z"),
        authorize: () => true,
      }),
    ).toEqual({ status: "empty" });
    expect(
      buildChatPdfBytes({ messages: [], assistantName: "AgileClaw", title: "Empty" }),
    ).toBeNull();
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });

  it("refuses a transcript beyond the export budget instead of truncating it", () => {
    const messages = [
      { role: "user", content: "Summarize this." },
      { role: "assistant", content: "x".repeat(1_500_001) },
    ];
    expect(
      exportChatPdf({ messages, assistantName: "AgileClaw", title: "Huge", authorize: () => true }),
    ).toEqual({ status: "too-large" });
  });

  it("writes a PDF document that starts with the PDF signature", () => {
    const built = buildChatPdfBytes({
      messages: transcript,
      assistantName: "AgileClaw",
      title: "Release planning",
      now: Date.parse("2026-11-17T09:30:00Z"),
    });
    expect(built).not.toBeNull();
    const header = new TextDecoder("latin1").decode(built!.bytes.subarray(0, 8));
    expect(header).toBe("%PDF-1.4");
  });

  it("keeps emoji content visible as an explained marker instead of a silent ?", () => {
    const built = buildChatPdfBytes({
      messages: [
        { role: "user", content: "Emoji fidelity: \u{1F99E} \u{1F600}" },
        { role: "assistant", content: "Two emoji above." },
      ],
      assistantName: "AgileClaw",
      title: "Emoji",
      now: Date.parse("2026-11-17T09:30:00Z"),
    });
    expect(built?.unsupportedCharacters).toBe(2);
    const document = new TextDecoder("latin1").decode(built!.bytes);
    // The marker is a real CID glyph, and the document explains the replacement.
    expect(document).toContain("25A1");
    expect(document).toContain("characters outside the PDF font range appear as");
    expect(document).not.toContain("? ?");
  });
});
