import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

function textMessage(text: string): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: [{ type: "text", text }],
  });
}

function messageText(message: AgentMessage): string {
  const content = (message as unknown as { content: unknown }).content;
  const block = Array.isArray(content) ? content[0] : undefined;
  return typeof (block as { text?: unknown } | undefined)?.text === "string"
    ? ((block as { text: string }).text as string)
    : JSON.stringify(content);
}

describe("transcript redaction mode", () => {
  it("stores credential-shaped transcript text verbatim when logging.redact is off", () => {
    const text = "https://control.example/#/callback?code=EQEEAEnVOG6xW7eQeKZN3pRjm2HL4fwYXzT9";
    const redacted = redactTranscriptMessage(textMessage(text), { logging: { redact: "off" } });
    expect(messageText(redacted)).toBe(text);
  });

  it("preserves registered values in transcripts while logging.redact is off", () => {
    resetSecretRedactionRegistryForTest();
    const secret = "EQEEAEnVOG6xW7eQeKZN3pRjm2HL4fwYXzT9";
    registerSecretValueForRedaction(secret);
    try {
      const redacted = redactTranscriptMessage(
        textMessage(`https://control.example/#/callback?code=${secret}`),
        { logging: { redact: "off" } },
      );
      const text = messageText(redacted);
      expect(text).toBe(`https://control.example/#/callback?code=${secret}`);
    } finally {
      resetSecretRedactionRegistryForTest();
    }
  });
});
