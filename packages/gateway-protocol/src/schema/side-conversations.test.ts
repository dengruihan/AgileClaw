import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsListParamsSchema } from "./sessions-list.js";
import {
  SideConversationsCloseParamsSchema,
  SideConversationsCreateParamsSchema,
  SideConversationsCreateResultSchema,
  SideConversationsListParamsSchema,
  SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH,
} from "./side-conversations.js";

const parentSessionKey = "agent:main:dashboard:parent";
const childSessionKey = "agent:main:dashboard:side-abc";

const summary = {
  sessionKey: childSessionKey,
  sessionId: "session-1",
  parentSessionKey,
  parentSessionId: "parent-1",
  intentId: "intent-1",
  ordinal: 1,
  state: "open",
  createdAt: 1,
  updatedAt: 1,
};

describe("side conversation protocol schemas", () => {
  it("accepts a bounded intent and rejects empty, oversized, or unknown input", () => {
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "intent-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "",
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "x".repeat(SIDE_CONVERSATION_MAX_INTENT_ID_LENGTH + 1),
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateParamsSchema, {
        parentSessionKey,
        intentId: "intent-1",
        model: "openai/gpt",
      }),
    ).toBe(false);
  });

  it("keeps the create result summary closed and state-bounded", () => {
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: summary,
      }),
    ).toBe(true);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, state: "deleted" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SideConversationsCreateResultSchema, {
        ok: true,
        created: true,
        conversation: { ...summary, childSessions: [childSessionKey] },
      }),
    ).toBe(false);
  });

  it("scopes list and transitions by parent or exact child key", () => {
    expect(Value.Check(SideConversationsListParamsSchema, { parentSessionKey })).toBe(true);
    expect(Value.Check(SideConversationsListParamsSchema, {})).toBe(false);
    expect(
      Value.Check(SideConversationsCloseParamsSchema, {
        parentSessionKey,
        sessionKey: childSessionKey,
      }),
    ).toBe(true);
    expect(Value.Check(SideConversationsCloseParamsSchema, { parentSessionKey })).toBe(false);
  });

  it("lists hidden side rows only on request", () => {
    expect(Value.Check(SessionsListParamsSchema, {})).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: true })).toBe(true);
    expect(Value.Check(SessionsListParamsSchema, { includeSideConversations: "yes" })).toBe(false);
  });
});
